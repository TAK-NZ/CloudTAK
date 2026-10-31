import { Type } from '@sinclair/typebox';
import Schema from '@openaddresses/batch-schema';
import Err from '@openaddresses/batch-error';
import Auth from '../../common/auth.js';
import type ConfigStateless from '../config.js';
import { getSarConfig } from '../lib/sar/relay-config.js';
import { MAX_BODY_BYTES, TravelTimeBody, buildUpstreamBody } from '../lib/sar/relay-request.js';
import {
    STATUS_LIMIT,
    TOO_LARGE,
    UNAVAILABLE,
    callEngine,
    mapUpstream,
    relay,
    userAgent,
} from '../lib/sar/relay-upstream.js';

type RelayErr = Err & { retryAfterS?: number; extra?: Record<string, number> };

function relayErr(status: number, message: string, more: { retryAfterS?: number; extra?: Record<string, number> } = {}): RelayErr {
    const err: RelayErr = new Err(status, null, message, false);
    if (more.retryAfterS !== undefined) err.retryAfterS = more.retryAfterS;
    if (more.extra) err.extra = more.extra;
    return err;
}

const TravelTimeResult = Type.Object({
    status: Type.Literal('ok'),
    mode: Type.Literal('travel-time'),
    contours: Type.Any(),
    parameters: Type.Optional(Type.Any()),
    bbox: Type.Optional(Type.Any()),
    warnings: Type.Optional(Type.Array(Type.Any())),
    data: Type.Optional(Type.Any()),
    attribution: Type.Optional(Type.Array(Type.String())),
    disclaimer: Type.Optional(Type.String()),
    timings_s: Type.Optional(Type.Any()),
});

export default async function router(schema: Schema, config: ConfigStateless) {
    // Schema validation answers before the handlers run. Make those errors uncacheable
    // too; the success path sets the header again. The platform body parser accepts
    // 50 MB before this runs, so the 8 KB cap is checked here.
    schema.router.use('/sar', (req, res, next) => {
        res.setHeader('Cache-Control', 'no-store');

        const declared = Number(req.headers['content-length']);
        let size = Number.isFinite(declared) ? declared : 0;
        if (size <= MAX_BODY_BYTES && req.body !== undefined && req.body !== null) {
            try {
                size = Math.max(size, Buffer.byteLength(JSON.stringify(req.body)));
            } catch {
                size = MAX_BODY_BYTES + 1;
            }
        }

        if (size > MAX_BODY_BYTES) {
            fail(relayErr(413, TOO_LARGE), res);
            return;
        }

        next();
    });

    await schema.get('/sar/status', {
        name: 'SAR Status',
        group: 'SAR',
        description: 'Report whether the SAR travel-time relay is enabled. Makes no call to the SAR service.',
        res: Type.Object({
            apiVersion: Type.Literal(1),
            enabled: Type.Boolean(),
        }),
    }, async (req, res) => {
        try {
            const user = await Auth.as_user(config, req);

            const limit = relay.status.hit(user.email.toLowerCase(), STATUS_LIMIT);
            if (!limit.ok) throw relayErr(429, 'Too many SAR requests', { retryAfterS: limit.retryAfterS });

            res.setHeader('Cache-Control', 'no-store');
            res.json({
                apiVersion: 1,
                enabled: getSarConfig().enabled,
            });
        } catch (err) {
            fail(err, res);
        }
    });

    await schema.post('/sar/travel-time', {
        name: 'SAR Travel Time',
        group: 'SAR',
        description: 'Calculate travel-time contours from an initial planning point through the configured SAR service',
        body: TravelTimeBody,
        res: TravelTimeResult,
    }, async (req, res) => {
        const started = Date.now();
        let username = '';
        let status = 500;
        let upstream: number | null = null;

        try {
            const user = await Auth.as_user(config, req);
            username = user.email;

            const cfg = getSarConfig();
            if (!cfg.enabled) throw relayErr(502, UNAVAILABLE);

            const rate = relay.calc.hit(user.email.toLowerCase(), cfg.rate);
            if (!rate.ok) throw relayErr(429, 'Too many SAR requests', { retryAfterS: rate.retryAfterS });

            const result = await callEngine(cfg, buildUpstreamBody(req.body), userAgent(config.API_URL));
            upstream = result.status;

            const mapped = mapUpstream(result);
            if (!mapped.ok) throw relayErr(mapped.error.status, mapped.error.message, mapped.error);

            status = 200;
            res.setHeader('Cache-Control', 'no-store');
            res.status(200).json(mapped.body as typeof TravelTimeResult.static);
        } catch (err) {
            status = fail(err, res);
        } finally {
            // Never the coordinates, the key, a token or an upstream body
            console.info(JSON.stringify({
                type: 'sar',
                username,
                status,
                ms: Date.now() - started,
                speed_kmh: req.body?.speed_kmh ?? null,
                intervals: Array.isArray(req.body?.intervals_hours) ? req.body.intervals_hours.length : null,
                radius_km: req.body?.radius_km ?? null,
                upstream,
            }));
        }
    });
}

/**
 * Respond with an error that is never cached and return its status
 */
function fail(err: unknown, res: Parameters<typeof Err.respond>[1]): number {
    res.setHeader('Cache-Control', 'no-store');

    const relayError = err as RelayErr | undefined;
    const retry = relayError?.retryAfterS;
    if (typeof retry === 'number') res.setHeader('Retry-After', String(retry));

    if (relayError?.extra && relayError instanceof Err && !res.headersSent) {
        // Err.respond cannot add fields, and the 422 body carries suggested_radius_km
        res.status(relayError.status).json({
            status: relayError.status,
            message: relayError.safe,
            ...relayError.extra,
            messages: [],
        });
        return relayError.status;
    }

    Err.respond(err, res);

    const status = Number((err as { status?: number } | undefined)?.status);
    return Number.isNaN(status) ? 500 : status;
}
