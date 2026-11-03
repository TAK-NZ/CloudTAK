import type { Request } from 'express';
import type { Static } from '@sinclair/typebox';
import type { TAKAPI } from '@tak-ps/node-tak';
import type { MissionOptions, SetRoleInput, MissionSubscriberRole } from '@tak-ps/node-tak/lib/api/mission';
import Auth, { AuthUser } from '../../../common/auth.js';
import TAKServerControl from '../../../common/control/takserver.js';
import ProfileOverlayControl from '../../../common/control/profile-overlay.js';
import type ConfigStateless from '../../config.js';

export type MissionContext = {
    user: AuthUser;
    api: TAKAPI;
    opts: Static<typeof MissionOptions>;
};

/**
 * Request scoped helpers shared by the Marti Mission endpoints
 */
export default class MissionControl {
    config: ConfigStateless;
    takserver: TAKServerControl;
    overlays: ProfileOverlayControl;

    constructor(config: ConfigStateless) {
        this.config = config;
        this.takserver = new TAKServerControl(config);
        this.overlays = new ProfileOverlayControl(config);
    }

    /**
     * Mission auth options for a request - an explicit MissionAuthorization
     * header takes precedence over the token stored on the user's subscription
     */
    async options(req: Request<any, any, any, any>, username: string, guid: string): Promise<Static<typeof MissionOptions>> {
        if (req.headers['missionauthorization']) {
            return { token: String(req.headers['missionauthorization']) };
        }

        return await this.overlays.subscription(username, guid);
    }

    /**
     * Authenticate the requesting user, build a TAK API client with their
     * certificate and resolve the Mission auth options for the given Mission
     */
    async context(req: Request<any, any, any, any>, guid: string, auth: {
        token?: boolean;
    } = {}): Promise<MissionContext> {
        const user = await Auth.as_user(this.config, req, { token: auth.token });
        const api = await this.takserver.asUser(user.email);
        const opts = await this.options(req, user.email, guid);

        return { user, api, opts };
    }

    /**
     * Remove the saved subscription of other users from a Mission
     *
     * `DELETE /subscription` is TAK Server's "leave the mission" call - it only
     * disconnects the live connection by default and matches the *caller's*
     * username when deleting, so it can never remove somebody else. A role change
     * without a `role` is what removes another subscriber (this is also what ATAK does).
     * It requires the MISSION_SET_ROLE permission.
     */
    async removeSubscribers(
        api: TAKAPI,
        guid: string,
        clientUids: string[],
        opts: Static<typeof MissionOptions>,
    ): Promise<void> {
        const subscribers = await api.Mission.subscriptionRoles(guid, opts);

        const usernames = new Map<string, string>();
        for (const subscriber of subscribers.data) {
            usernames.set(subscriber.clientUid, subscriber.username || '');
        }

        for (const clientUid of clientUids) {
            // The `role` is deliberately omitted, TAK Server treats that as "remove"
            await api.Mission.setRole(guid, {
                clientUid,
                username: usernames.get(clientUid) ?? '',
            } as Static<typeof SetRoleInput>, opts);
        }
    }

    /**
     * Change the default role of an existing Mission
     *
     * node-tak's `Mission.update()` cannot send `defaultRole`, so this mirrors its
     * request (the current values are sent back so nothing else is modified)
     * and adds the `defaultRole` parameter. Requires MISSION_SET_ROLE.
     */
    async setDefaultRole(
        api: TAKAPI,
        guid: string,
        role: MissionSubscriberRole,
        opts: Static<typeof MissionOptions>,
    ): Promise<void> {
        const mission = await api.Mission.get(guid, {}, opts);

        const url = new URL(`/Marti/api/missions/${encodeURIComponent(mission.name)}`, api.url);

        const current: Record<string, unknown> = {
            creatorUid: mission.creatorUid,
            description: mission.description,
            chatRoom: mission.chatRoom,
            baseLayer: mission.baseLayer,
            bbox: mission.bbox,
            path: mission.path,
            classification: mission.classification,
            tool: mission.tool,
            expiration: mission.expiration,
            inviteOnly: mission.inviteOnly,
        };

        for (const [key, value] of Object.entries(current)) {
            if (value !== undefined && value !== null) url.searchParams.append(key, String(value));
        }

        const groups = mission.groups === undefined
            ? []
            : Array.isArray(mission.groups) ? mission.groups : [mission.groups];

        for (const group of groups) url.searchParams.append('group', String(group));

        url.searchParams.append('defaultRole', role);
        url.searchParams.append('allowDupe', 'false');

        await api.fetch(url, {
            method: 'POST',
            headers: this.headers(opts),
        });
    }

    /**
     * Set, change or (when no password is given) remove the password of a Mission
     * Requires the MISSION_SET_PASSWORD permission.
     */
    async setPassword(
        api: TAKAPI,
        guid: string,
        password: string | undefined,
        opts: Static<typeof MissionOptions>,
    ): Promise<void> {
        const url = new URL(`/Marti/api/missions/guid/${encodeURIComponent(guid)}/password`, api.url);

        if (password !== undefined) url.searchParams.append('password', password);

        await api.fetch(url, {
            method: password !== undefined ? 'PUT' : 'DELETE',
            headers: this.headers(opts),
        });
    }

    private headers(opts: Static<typeof MissionOptions>): Record<string, string> {
        return opts.token ? { MissionAuthorization: `Bearer ${opts.token}` } : {};
    }
}
