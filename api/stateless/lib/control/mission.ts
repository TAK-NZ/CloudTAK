import type { Request } from 'express';
import Err from '@openaddresses/batch-error';
import type { Static } from '@sinclair/typebox';
import type { TAKAPI } from '@tak-ps/node-tak';
import type { MissionOptions } from '@tak-ps/node-tak/lib/api/mission';
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
     * Refuse a change that would leave a Mission without an owner
     *
     * A Mission with no owner subscription can no longer have its roles, groups or
     * password changed, and a CloudTAK admin has no access to a Mission they are
     * not subscribed to. Only enforced while the Mission has an owner.
     *
     * `changes` lists subscribers being demoted or removed (`role` omitted means
     * removed). It mirrors how TAK Server picks the rows a role change touches:
     * with a `username` every subscription row of that username is changed,
     * otherwise only the row of the `clientUid`.
     */
    async assertOwnerRemains(
        api: TAKAPI,
        guid: string,
        changes: Array<{ clientUid: string; username?: string; role?: string }>,
        opts: Static<typeof MissionOptions>,
    ): Promise<void> {
        const subscribers = await api.Mission.subscriptionRoles(guid, opts);

        const owners = subscribers.data.filter(subscriber => subscriber.role.type === 'MISSION_OWNER');

        if (!owners.length) return;

        const demoted = changes.filter(change => change.role !== 'MISSION_OWNER');

        const remaining = owners.filter((owner) => {
            return !demoted.some((change) => {
                return change.username
                    ? owner.username === change.username
                    : owner.clientUid === change.clientUid;
            });
        });

        if (!remaining.length) {
            throw new Err(409, null, 'A Data Sync must keep at least one owner');
        }
    }
}
