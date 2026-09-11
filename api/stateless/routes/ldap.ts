import { Type } from '@sinclair/typebox';
import crypto from 'node:crypto';
import type ConfigStateless from '../config.js';
import Schema from '@openaddresses/batch-schema';
import Err from '@openaddresses/batch-error';
import Auth from '../../common/auth.js';
import { ConnectionAuth } from '../../common/connection-config.js';
import { Channel, ChannelAccess } from '../lib/interface-user.js';
import { TAKAPI, APIAuthPassword } from '@tak-ps/node-tak';
import AuthentikProvider, { SCOPE_ALL, agencyScope } from '../lib/authentik-provider.js';

export default async function router(schema: Schema, config: ConfigStateless) {
    await schema.get('/ldap/channel', {
        name: 'List Channel',
        group: 'LDAP',
        description: 'List Channels by proxy',
        query: Type.Object({
            agency: Type.Optional(Type.Integer()),
            filter: Type.String({ default: '' }),
        }),
        res: Type.Object({
            total: Type.Integer(),
            items: Type.Array(Channel),
        }),
    }, async (req, res) => {
        try {
            let profile = await Auth.as_profile(config, req);

            const cotak = config.user?.get('cotak');

            if (cotak && cotak.configured) {
                if (!profile.id) {
                    const response = await cotak.login(profile.username);
                    await config.models.Profile.commit(profile.username, { id: response.id });
                    profile = await config.models.Profile.from(profile.username);
                }

                const list = await cotak.channels(profile.id!, req.query);
                res.json(list);
            } else if (process.env.AUTHENTIK_URL && process.env.AUTHENTIK_API_TOKEN_SECRET_ARN) {
                const authentik = await AuthentikProvider.init(config);

                // A non-system-admin may only list channels within an agency
                // they administer. Reject an explicit request for an agency
                // outside their scope; otherwise the provider filters the list
                // down to their agencies.
                const scope = profile.system_admin ? SCOPE_ALL : agencyScope(profile.agency_admin || []);
                if (!profile.system_admin && req.query.agency && !(profile.agency_admin || []).includes(req.query.agency)) {
                    throw new Err(403, null, 'Cannot list channels for an Agency you are not an admin of');
                }

                const list = await authentik.channels(0, req.query, scope);
                res.json(list);
            } else {
                throw new Err(400, null, 'External LDAP API not configured - Contact your administrator');
            }
        } catch (err) {
            Err.respond(err, res);
        }
    });

    await schema.post('/ldap/user', {
        name: 'Create Machine User',
        group: 'LDAP',
        description: 'Create a machine user',
        body: Type.Object({
            name: Type.String(),
            description: Type.String(),
            locking: Type.Optional(Type.Boolean({ default: true })),
            agency_id: Type.Optional(Type.Integer()),
            channels: Type.Array(Type.Object({
                id: Type.Integer(),
                access: ChannelAccess,
            }), {
                minItems: 1,
            }),
        }),
        res: Type.Object({
            integrationId: Type.Optional(Type.Integer()),
            auth: ConnectionAuth,
        }),
    }, async (req, res) => {
        try {
            let profile = await Auth.as_profile(config, req);

            const cotak = config.user?.get('cotak');

            if (cotak && cotak.configured) {
                if (!profile.id) {
                    const response = await cotak.login(profile.username);
                    await config.models.Profile.commit(profile.username, { id: response.id });
                    profile = await config.models.Profile.from(profile.username);
                }

                const password = Array.from({ length: 16 }, () => {
                    return String.fromCharCode(crypto.randomInt(94) + 33);
                }).join('');

                const user = await cotak.createMachineUser(profile.id!, {
                    name: req.body.name,
                    description: req.body.description,
                    management_url: config.API_URL,
                    active: false,
                    locking: req.body.locking ?? true,
                    agency_id: req.body.agency_id,
                    password,
                    channels: req.body.channels,
                });

                const api = await TAKAPI.init(
                    new URL(config.server.webtak),
                    new APIAuthPassword(user.email, password),
                );

                const certs = await api.Credentials.generate();

                res.json({
                    integrationId: user.integrations.find(Boolean)?.id ?? undefined,
                    auth: certs,
                });
            } else if (process.env.AUTHENTIK_URL && process.env.AUTHENTIK_API_TOKEN_SECRET_ARN) {
                // Authentik does not support channel-locking; the machine user is created
                // and a TAK certificate is generated via password auth — same as CoTAK flow.

                // Authorization gate (mirrors POST /connection): a machine user
                // is always owned by an agency. A system admin may create one in
                // any agency; anyone else may only create one in an agency they
                // administer. Enforced before any Authentik write.
                if (!profile.system_admin) {
                    if (!req.body.agency_id) {
                        throw new Err(403, null, 'Only System Admins can create a machine user without an Agency');
                    } else if (!(profile.agency_admin || []).includes(req.body.agency_id)) {
                        throw new Err(403, null, 'Cannot create a machine user for an Agency you are not an admin of');
                    }
                }

                const authentik = await AuthentikProvider.init(config);

                const password = Array.from({ length: 16 }, () => {
                    return String.fromCharCode(crypto.randomInt(94) + 33);
                }).join('');

                const user = await authentik.createMachineUser(0, {
                    name: req.body.name,
                    agency_id: req.body.agency_id,
                    password,
                    integration: { description: req.body.description },
                });

                // Attach the new service account to each selected channel's
                // Authentik group. createMachineUser only provisions the
                // account; without this the channels chosen in the UI are
                // silently dropped and the machine user joins nothing. The
                // access level selects which group variant the user joins:
                // duplex -> base tak_<Channel>, read -> _READ, write -> _WRITE
                // (see attachMachineUser). A requested access level whose group
                // does not exist fails loudly rather than over-granting.
                for (const channel of req.body.channels) {
                    await authentik.attachMachineUser(0, {
                        machine_id: user.id,
                        channel_id: channel.id,
                        access: channel.access,
                    });
                }

                const api = await TAKAPI.init(
                    new URL(config.server.webtak),
                    new APIAuthPassword(user.email, password),
                );

                const certs = await api.Credentials.generate();

                res.json({
                    integrationId: undefined,
                    auth: certs,
                });
            } else {
                throw new Err(400, null, 'External LDAP API not configured - Contact your administrator');
            }
        } catch (err) {
            Err.respond(err, res);
        }
    });

    await schema.put('/ldap/user/:email', {
        name: 'Reset Machine User',
        group: 'LDAP',
        description: 'Reset the password on an existing user and regen a certificate',
        params: Type.Object({
            email: Type.String(),
        }),
        res: Type.Object({
            integrationId: Type.Optional(Type.Integer()),
            auth: ConnectionAuth,
        }),
    }, async (req, res) => {
        try {
            let profile = await Auth.as_profile(config, req);

            const cotak = config.user?.get('cotak');

            if (cotak && cotak.configured) {
                if (!profile.id) {
                    const response = await cotak.login(profile.username);
                    await config.models.Profile.commit(profile.username, { id: response.id });
                    profile = await config.models.Profile.from(profile.username);
                }

                const password = Array.from({ length: 16 }, () => String.fromCharCode(crypto.randomInt(33, 127)))
                    .join('');

                const user = await cotak.fetchMachineUser(profile.id!, req.params.email);
                await cotak.updateMachineUser(profile.id!, { id: user.id, password });

                const api = await TAKAPI.init(
                    new URL(config.server.webtak),
                    new APIAuthPassword(user.email, password),
                );

                const certs = await api.Credentials.generate();

                res.json({
                    integrationId: user.integrations.find(Boolean)?.id ?? undefined,
                    auth: certs,
                });
            } else if (process.env.AUTHENTIK_URL && process.env.AUTHENTIK_API_TOKEN_SECRET_ARN) {
                const authentik = await AuthentikProvider.init(config);

                const password = Array.from({ length: 16 }, () => String.fromCharCode(crypto.randomInt(33, 127)))
                    .join('');

                const user = await authentik.fetchMachineUser(0, req.params.email);
                await authentik.updateMachineUser(0, user.id, { password });

                const api = await TAKAPI.init(
                    new URL(config.server.webtak),
                    new APIAuthPassword(user.email, password),
                );

                const certs = await api.Credentials.generate();

                res.json({
                    integrationId: undefined,
                    auth: certs,
                });
            } else {
                throw new Err(400, null, 'External LDAP API not configured - Contact your administrator');
            }
        } catch (err) {
            Err.respond(err, res);
        }
    });
}
