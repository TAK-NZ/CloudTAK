import { Type } from '@sinclair/typebox';
import type ConfigStateless from '../config.js';
import Schema from '@openaddresses/batch-schema';
import Err from '@openaddresses/batch-error';
import Auth from '../../common/auth.js';
import * as Default from '../lib/limits.js';
import AuthentikProvider, { SCOPE_ALL, agencyScope } from '../lib/authentik-provider.js';

export const AgencyResponse = Type.Object({
    id: Type.Integer(),
    name: Type.String(),
    description: Type.Optional(Type.Any()),
});

export default async function router(schema: Schema, config: ConfigStateless) {
    await schema.get('/agency', {
        name: 'Get Agencies',
        group: 'Agency',
        description: 'Return a list Agencies',
        query: Type.Object({
            filter: Default.Filter,
        }),
        res: Type.Object({
            total: Type.Integer(),
            config: Type.Object({
                enabled: Type.Boolean(),
            }),
            items: Type.Array(AgencyResponse),
        }),

    }, async (req, res) => {
        try {
            const user = await Auth.as_user(config, req);
            const profile = await config.models.Profile.from(user.email);

            const cotak = config.user?.get('cotak');

            if (cotak && cotak.configured) {
                if (!profile.id) throw new Err(400, null, 'External ID must be set on profile');

                const list = await cotak.agencies(profile.id, req.query.filter);

                res.json({
                    ...list,
                    config: { enabled: true },
                });
            } else if (process.env.AUTHENTIK_URL && process.env.AUTHENTIK_API_TOKEN_SECRET_ARN) {
                const authentik = await AuthentikProvider.init(config);

                // Scope the agency list to what the caller may administer. A
                // system admin sees all; anyone else sees only their
                // agency_admin agencies (empty for a user with none).
                const scope = profile.system_admin ? SCOPE_ALL : agencyScope(profile.agency_admin || []);
                const list = await authentik.agencies(0, req.query.filter, scope);

                res.json({
                    ...list,
                    config: { enabled: true },
                });
            } else {
                res.json({
                    total: 0,
                    config: { enabled: false },
                    items: [],
                });
            }
        } catch (err) {
            Err.respond(err, res);
        }
    });

    await schema.get('/agency/:agencyid', {
        name: 'Get Agency',
        group: 'Agency',
        description: 'Return a single agency by id',
        params: Type.Object({
            agencyid: Type.Integer(),
        }),
        res: AgencyResponse,
    }, async (req, res) => {
        try {
            const user = await Auth.as_user(config, req);
            const profile = await config.models.Profile.from(user.email);

            const cotak = config.user?.get('cotak');

            if (cotak && cotak.configured) {
                if (!profile.id) throw new Err(400, null, 'External ID must be set on profile');
                const agency = await cotak.agency(profile.id, req.params.agencyid);
                res.json(agency);
            } else if (process.env.AUTHENTIK_URL && process.env.AUTHENTIK_API_TOKEN_SECRET_ARN) {
                const authentik = await AuthentikProvider.init(config);

                const scope = profile.system_admin ? SCOPE_ALL : agencyScope(profile.agency_admin || []);
                const agency = await authentik.agency(0, req.params.agencyid, scope);
                res.json(agency);
            } else {
                throw new Err(404, null, 'External API not configured');
            }
        } catch (err) {
            Err.respond(err, res);
        }
    });
}
