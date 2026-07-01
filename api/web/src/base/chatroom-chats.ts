import { db } from '../database.ts';
import { server } from '../std.ts';
import type {
    ProfileChatList,
    APIProfileChat
} from '../types.ts'
import type { DBChatroomChat } from '../database.ts';
import type Atlas from '../workers/atlas.ts';
import type { Remote } from 'comlink';
import ContactManager from './contact.ts';

export default class ChatroomChats {
    chatroom: string;

    constructor(
        chatroom: string
    ) {
        this.chatroom = chatroom;
    }

    async refresh(): Promise<void> {
        const res = await server.GET('/api/profile/chatroom/{:chatroom}/chat', {
            params: {
                path: { ':chatroom': this.chatroom },
                query: { limit: 50, page: 0, order: 'desc', sort: 'created' }
            }
        });

        if (res.error) throw new Error(res.error.message);

        const list = res.data as ProfileChatList;

        await db.transaction('rw', db.chatroom_chats, async () => {
            // Add server messages not already in local DB.
            // Never delete local messages during refresh — the server may not
            // have echoed back sent messages yet.
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
        worker: Remote<Atlas>,
        recipient?: { uid: string, callsign: string }
    ): Promise<void> {
        const id = crypto.randomUUID();
        const created = new Date().toISOString();

        // Ensure the chatroom record exists before updating
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
                const contact = await ContactManager.getByCallsign(this.chatroom);
                if (contact) {
                    recipient = {
                        uid: contact.uid,
                        callsign: contact.callsign
                    }
                } else {
                    recipient = {
                        uid: this.chatroom,
                        callsign: this.chatroom
                    }
                }
            }
        }

        if (!recipient) throw new Error('Error sending Chat - Contact is not defined');

        const location = (await worker.profile?.location)?.coordinates || [0, 0];

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
