import { Type } from '@sinclair/typebox'
import Schema from '@openaddresses/batch-schema';
import { GenerateUpsert } from '@openaddresses/batch-generic';
import Err from '@openaddresses/batch-error';
import Auth from '../lib/auth.js';
import Config from '../lib/config.js';

export default async function router(schema: Schema, config: Config) {
    await schema.get('/config', {
        name: 'Get Config',
        group: 'Config',
        description: 'Get Config',
        query: Type.Object({
            keys: Type.String()
        }),
        res: Type.Record(Type.String(), Type.Any())
    }, async (req, res) => {
        try {
            await Auth.as_user(config, req, { admin: true });

            const final: Record<string, string> = {};
            (await Promise.allSettled((req.query.keys.split(',').map((key) => {
                return config.models.Setting.from(key);
            })))).forEach((k) => {
                if (k.status === 'rejected') return;
                return final[k.value.key] = String(k.value.value);
            });

            res.json(final);
        } catch (err) {
            Err.respond(err, res);
        }
    });

    await schema.put('/config', {
        name: 'Update Config',
        group: 'Config',
        description: 'Update Config Key/Values',
        body: Type.Object({
            'agol::enabled': Type.Optional(Type.Boolean()),
            'agol::token': Type.Optional(Type.String()),

            'media::url': Type.Optional(Type.String()),

            'map::center': Type.Optional(Type.String()),
            'map::pitch': Type.Optional(Type.Integer({
                minimum: 0,
                maximum: 90
            })),
            'map::bearing': Type.Optional(Type.String({
                minimum: 0,
                maximum: 360
            })),
            'map::zoom': Type.Optional(Type.Integer({
                minimum: 0,
                maximum: 20
            })),

            'group::Yellow': Type.Optional(Type.String()),
            'group::Cyan': Type.Optional(Type.String()),
            'group::Green': Type.Optional(Type.String()),
            'group::Red': Type.Optional(Type.String()),
            'group::Purple': Type.Optional(Type.String()),
            'group::Orange': Type.Optional(Type.String()),
            'group::Blue': Type.Optional(Type.String()),
            'group::Magenta': Type.Optional(Type.String()),
            'group::White': Type.Optional(Type.String()),
            'group::Maroon': Type.Optional(Type.String()),
            'group::Dark Blue': Type.Optional(Type.String()),
            'group::Teal': Type.Optional(Type.String()),
            'group::Dark Green': Type.Optional(Type.String()),
            'group::Brown': Type.Optional(Type.String()),

            'oidc::enabled': Type.Optional(Type.Boolean()),
            'oidc::enforced': Type.Optional(Type.Boolean()),
            'oidc::name': Type.Optional(Type.String()),
            'oidc::discovery': Type.Optional(Type.String()),
            'oidc::client': Type.Optional(Type.String()),
            'oidc::secret': Type.Optional(Type.String()),

            // COTAK Specific Properties
            'provider::url': Type.Optional(Type.String()),
            'provider::secret': Type.Optional(Type.String()),
            'provider::client': Type.Optional(Type.String()),

            'login::signup': Type.Optional(Type.String()),
            'login::forgot': Type.Optional(Type.String()),
            'login::logo': Type.Optional(Type.String()),
        }),
        res: Type.Any()
    }, async (req, res) => {
        try {
            await Auth.as_user(config, req, { admin: true });

            const final: Record<string, string> = {};
            (await Promise.allSettled(Object.keys(req.body).map((key) => {
                return config.models.Setting.generate({
                    key: key,
                    // @ts-expect-error Index issue - look into this later
                    value: req.body[key]
                },{
                    upsert: GenerateUpsert.UPDATE
                });
            }))).forEach((k) => {
                if (k.status === 'rejected') return;
                return final[k.value.key] = String(k.value.value);
            });

            res.json(final);
        } catch (err) {
            Err.respond(err, res);
        }
    });

    await schema.get('/config/login', {
        name: 'Login Config',
        group: 'Config',
        description: 'Return Login Config',
        res: Type.Object({
            logo: Type.Optional(Type.String()),
            signup: Type.Optional(Type.String()),
            forgot: Type.Optional(Type.String()),
        })
    }, async (req, res) => {
        try {
            const keys = [
                'login::logo',
                'login::signup',
                'login::forgot',
            ];

            const final: Record<string, string> = {};
            (await Promise.allSettled(keys.map((key) => {
                return config.models.Setting.from(key);
            }))).forEach((k) => {
                if (k.status === 'rejected') return;
                return final[k.value.key.replace('login::', '')] = String(k.value.value);
            });

            for (let login of keys) {
                login = login.replace('login::', '')
            }

            res.json(final);
        } catch (err) {
            Err.respond(err, res);
        }
    });

    await schema.get('/config/tiles', {
        name: 'Tile Config',
        group: 'Config',
        description: 'Return Tile Config',
        res: Type.Object({
            url: Type.String()
        })
    }, async (req, res) => {
        try {
            res.json({
                url: config.PMTILES_URL
            });
        } catch (err) {
            Err.respond(err, res);
        }
    });

    await schema.get('/config/group', {
        name: 'List Groups',
        group: 'Config',
        description: 'Return Group Config',
        res: Type.Object({
            roles: Type.Array(Type.String()),
            groups: Type.Record(Type.String(), Type.String()),
        })
    }, async (req, res) => {
        try {
            await Auth.as_user(config, req);

            const keys = [
                'group::Yellow',
                'group::Cyan',
                'group::Green',
                'group::Red',
                'group::Purple',
                'group::Orange',
                'group::Blue',
                'group::Magenta',
                'group::White',
                'group::Maroon',
                'group::Dark Blue',
                'group::Teal',
                'group::Dark Green',
                'group::Brown',
            ];

            const final: Record<string, string> = {};
            (await Promise.allSettled(keys.map((key) => {
                return config.models.Setting.from(key);
            }))).forEach((k) => {
                if (k.status === 'rejected') return;
                return final[k.value.key.replace('group::', '')] = String(k.value.value);
            });

            for (let group of keys) {
                group = group.replace('group::', '')
                if (!final[group]) final[group] = '';
            }

            res.json({
                roles: [ "Team Member", "Team Lead", "HQ", "Sniper", "Medic", "Forward Observer", "RTO", "K9" ],
                groups: final
            });
        } catch (err) {
            Err.respond(err, res);
        }
    });

    await schema.get('/config/map', {
        name: 'Map Config',
        group: 'Config',
        description: 'Return Map Config',
        res: Type.Object({
            center: Type.String({ default: '-100,40' }),
            zoom: Type.Integer({ default: 4 }),
            pitch: Type.Integer({ default: 0 }),
            bearing: Type.Integer({ default: 0 }),
        })
    }, async (req, res) => {
        try {
            const keys = [
                'map::center',
                'map::pitch',
                'map::bearing',
                'map::zoom',
            ];

            const final: Record<string, any> = {};

            (await Promise.allSettled(keys.map((key) => {
                return config.models.Setting.from(key);
            }))).forEach((k) => {
                if (k.status === 'rejected') return;
                return final[k.value.key.replace('map::', '')] = String(k.value.value);
            });

            for (let map of keys) {
                map = map.replace('map::', '')
            }

            res.json({
                center: final.center || '-100,40',
                zoom: final.zoom || 4,
                pitch: final.pitch || 0,
                bearing: final.bearing || 0
            });
        } catch (err) {
            Err.respond(err, res);
        }
    });
}
