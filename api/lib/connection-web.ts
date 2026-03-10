import { Static } from '@sinclair/typebox'
import { DirectChat, CoTParser }  from '@tak-ps/node-cot';
import type { Feature }  from '@tak-ps/node-cot';
import { WebSocket } from 'ws';
import { ConnectionClient } from './connection-pool.js';

export class ConnectionWebSocket {
    ws: WebSocket;
    format: string;
    client?: ConnectionClient;

    constructor(ws: WebSocket, format = 'raw', client?: ConnectionClient) {
        this.ws = ws;
        this.format = format;

        if (client) {
            this.client = client;
            this.ws.on('message', async (data) => {
                try {
                    const msg = JSON.parse(String(data));

                    if (msg.type === 'chat') {
                        if (!msg.data.to?.uid || !msg.data.to?.callsign) {
                            throw new Error(`Chat message is missing recipient uid/callsign: ${JSON.stringify(msg.data.to)}`);
                        }
                        const chat = new DirectChat(msg.data);
                        if (msg.data.location && msg.data.location[0] !== 0 && msg.data.location[1] !== 0) {
                            chat.position(msg.data.location);
                        }
                        // TAK Server plugins (e.g. tak-gpt) are server-side entities
                        // (endpoint *:-1:stcp) with no TCP connection. The TAK Server
                        // routes <marti><dest uid="..."/> to connected TCP clients only,
                        // so messages to plugins are silently dropped.
                        // Use <marti><dest callsign="..."/> with the bot UID (matching
                        // ATAK's wire format). The TAK Server resolves the UID to the
                        // human-readable callsign in xmlDetail before delivering to the
                        // plugin, so tak-gpt's llmManagers.containsKey(botName) matches.
                        // Also inject <dest callsign="..."> directly inside <detail> as
                        // a fallback for plugins that search xmlDetail directly.
                        if (!chat.raw.event.detail) chat.raw.event.detail = {};
                        if (chat.raw.event.detail.marti) {
                            (chat.raw.event.detail.marti as Record<string, unknown>).dest = [
                                { _attributes: { callsign: msg.data.to.callsign } }
                            ];
                        }
                        (chat.raw.event.detail as Record<string, unknown>).dest = {
                            _attributes: { callsign: msg.data.to.callsign }
                        };
                        client.tak.write([chat]);
                        // Do NOT store the outgoing message here. The TAK Server echoes
                        // the CoT back on the sender's TCP connection, which triggers
                        // connection-pool.ts cots() to store it. Storing here as well
                        // would result in the sender seeing the message twice.
                    } else {
                        const feat = msg.data as Static<typeof Feature.Feature>;

                        const cot = await CoTParser.from_geojson(feat);

                        client.tak.write([cot]);
                    }
                } catch (err) {
                    this.ws.send(JSON.stringify({
                        type: 'Error',
                        properties: {
                            message: err instanceof Error ? err.message : String(err)
                        }
                    }));
                }
            });
        }
    }

    destroy() {
        this.ws.close();
        delete this.client;
    }

}
