import { db } from './database.ts';
import { std, stdurl } from '../std.ts';
import type {
    ProfileChatList,
    APIProfileChat
} from '../types.ts'
import type { DBChatroomChat } from './database.ts';
import type Atlas from '../workers/atlas.ts';

export default class ChatroomChats {
    chatroom: string;

    constructor(
        chatroom: string
    ) {
        this.chatroom = chatroom;
    }

    async refresh(): Promise<void> {
        const url = stdurl(`/api/profile/chatroom/${encodeURIComponent(this.chatroom)}/chat`);

        const list = await std(url) as ProfileChatList;

        await db.transaction('rw', db.chatroom_chats, async () => {
            // Add server messages not already in local DB.
            // Never delete local messages during refresh — the server may not
            // have echoed back sent messages yet. Only explicit user deletion
            // should remove messages from the local DB.
            for (const chat of list.items) {
                const c = chat as APIProfileChat;
                const existing = await db.chatroom_chats.get(c.message_id);
                await db.chatroom_chats.put({
                    id: c.message_id,
                    chatroom: this.chatroom,
                    sender: c.sender_callsign,
                    sender_uid: c.sender_uid,
                    message: c.message,
                    // Preserve local created timestamp if record already exists
                    // so sort order matches what the user saw when the message
                    // was first stored locally.
                    created: existing?.created || c.created
                });
            }
        });

        const activeItem = list.items[list.items.length - 1];
        if (activeItem) {
            await db.chatroom.update(this.chatroom, {
                updated: (activeItem as APIProfileChat).created
            });
        }
    }

    async list(
        opts?: {
            refresh?: boolean,
        }
    ): Promise<Array<DBChatroomChat>> {
        if (opts?.refresh) {
            await this.refresh();
        }

        const chats = await db.chatroom_chats
            .where("chatroom")
            .equals(this.chatroom)
            .toArray();

        chats.sort((a, b) => {
            return a.created.localeCompare(b.created);
        });

        return chats;
    }

    async markRead(): Promise<void> {
        await db.chatroom.update(this.chatroom, { unread: 0 });
    }

    async send(
        message: string,
        sender: { uid: string, callsign: string },
        worker: Atlas,
        recipient?: { uid: string, callsign: string }
    ): Promise<void> {
        const id = crypto.randomUUID();
        const created = new Date().toISOString();

        // Ensure the chatroom record exists. Use put only if it doesn't
        // exist yet to avoid overwriting the created timestamp.
        const existingRoom = await db.chatroom.get(this.chatroom);
        if (!existingRoom) {
            await db.chatroom.put({
                id: this.chatroom,
                name: this.chatroom,
                created: created,
                updated: created,
                last_read: null
            });
        } else {
            await db.chatroom.update(this.chatroom, { updated: created });
        }

        await db.chatroom_chats.put({
            id: id,
            chatroom: this.chatroom,
            sender: sender.callsign,
            sender_uid: sender.uid,
            message: message,
            created: created
        });

        if (!recipient) {
            const chats = await this.list();
            const single = chats.find((chat) => {
                return chat.sender_uid !== sender.uid
            });

            if (single) {
                recipient = {
                    uid: single.sender_uid,
                    callsign: single.sender
                }
            } else {
                const contact = await worker.team.getByCallsign(this.chatroom);
                if (contact) {
                    recipient = {
                        uid: contact.uid,
                        callsign: contact.callsign
                    }
                }
            }
        }

        if (!recipient) throw new Error('Error sending Chat - Contact is not defined');

        let location: number[] | undefined;
        try {
            location = await worker.profile.currentCoordinates();
        } catch {
            // location is best-effort, don't fail the send
        }

        await worker.conn.sendCOT({
            chatroom: this.chatroom,
            from: {
                uid: sender.uid,
                callsign: sender.callsign
            },
            to: recipient,
            message: message,
            messageId: id,
            time: created,
            location
        }, 'chat');
    }
}
