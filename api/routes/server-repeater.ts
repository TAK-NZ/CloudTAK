import { Type } from '@sinclair/typebox'
import Err from '@openaddresses/batch-error';
import Auth from '../lib/auth.js';
import Schema from '@openaddresses/batch-schema';
import { StandardResponse } from '../lib/types.js';
import Config from '../lib/config.js';
import { Repeater } from '@tak-ps/node-tak/lib/api/repeater';
import { TAKAPI, APIAuthCertificate } from '@tak-ps/node-tak';

export default async function router(schema: Schema, config: Config) {
    await schema.get('/server/repeater', {
        name: 'List Repeaters',
        group: 'ServerRepeater',
        description: 'Get Repeater List',
        res: Type.Object({
            total: Type.Integer(),
            items: Type.Array(Repeater)
        })
    }, async (req, res) => {
        try {
            await Auth.as_user(config, req, { admin: true });

            const auth = config.serverCert();
            const api = await TAKAPI.init(new URL(String(config.server.api)), new APIAuthCertificate(auth.cert, auth.key));

            const list = await api.Repeater.list()

            res.json({
                total: list.data.length,
                items: list.data
            })
        } catch (err) {
             Err.respond(err, res);
        }
    });

    await schema.delete('/server/repeater/:uid', {
        name: 'Delete Repeater',
        group: 'ServerRepeater',
        description: 'Delete Repeater',
        params: Type.Object({
            uid: Type.String()
        }),
        res: StandardResponse
    }, async (req, res) => {
        try {
            await Auth.as_user(config, req, { admin: true });

            const auth = config.serverCert();
            const api = await TAKAPI.init(new URL(String(config.server.api)), new APIAuthCertificate(auth.cert, auth.key));

            await api.Repeater.delete(req.params.uid)

            res.json({
                status: 200,
                message: 'Repeater Deleted'
            })
        } catch (err) {
             Err.respond(err, res);
        }
    });
}
