import type Atlas from './atlas.ts';
import { std, stdurl } from '../std.ts';
import type COT from '../base/cot.ts';
import TAKNotification, { NotificationType } from '../base/notification.ts';
import {
    WorkerMessageType
} from '../base/events.ts';

import type { ContactList, Contact } from '../types.ts';

export default class AtlasTeam {
    atlas: Atlas;
    contacts: Map<string, Contact>

    constructor(atlas: Atlas) {
        this.atlas = atlas;

        this.contacts = new Map();
    }

    async init(): Promise<void> {
        await Promise.all([ this.load() ])
    }

    async set(cot: COT): Promise<Contact> {
        if (!cot.properties.group) {
            throw new Error('Contact Marker must have group property');
        }

        const entry = this.contacts.get(cot.id);

        const contact: Contact = {
            uid: cot.id,
            notes: entry?.notes || '',
            filterGroups: entry?.filterGroups || null,
            callsign: cot.properties.callsign,
            team: cot.properties.group.name,
            role: cot.properties.group.role,
            takv: entry?.takv || ''
        }

        this.contacts.set(cot.id, contact);

        this.atlas.postMessage({
            type: WorkerMessageType.Contact_Change
        });

        // Only notify on first appearance — not on updates or reconnect replays
        if (!entry && this.atlas.profile.uid() !== cot.id) {
            await TAKNotification.create(
                NotificationType.Contact,
                'Online Contact',
                `${cot.properties.callsign} is now Online`,
                `/cot/${cot.id}`,
                false
            );
        }

        return contact;
    }

    async get(uid: string): Promise<Contact | undefined> {
        return this.contacts.get(uid);
    }

    async getByCallsign(callsign: string): Promise<Contact | undefined> {
        for (const contact of this.contacts.values()) {
            if (contact.callsign === callsign) return contact;
        }
    }

    async load(): Promise<Map<string, Contact>> {
        const url = stdurl('/api/marti/api/contacts/all');
        const contacts = await std(url, {
            token: this.atlas.token
        }) as ContactList;

        // Merge rather than replace — contacts discovered from received CoTs
        // (e.g. server-side plugin/bot entities with endpoint *:-1:stcp that are
        // absent from /api/contacts/all) must survive reconnects so they remain
        // visible in the Contacts panel and do not re-trigger "Online" notifications.
        for (const contact of contacts) {
            if (!contact.uid) continue;
            this.contacts.set(contact.uid, contact);
        }

        return this.contacts;
    }
}
