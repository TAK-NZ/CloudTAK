import { Type } from '@sinclair/typebox';
import Schema from '@openaddresses/batch-schema';
import Err from '@openaddresses/batch-error';
import Auth from '../../common/auth.js';
import type ConfigStateless from '../config.js';
import { getRelayConfig } from '../lib/weather/relay-config.js';
import {
    LAYERS,
    buildUpstreamUrl,
    latestSnapshot,
    parseTileRequest,
    tileCacheKey,
} from '../lib/weather/relay-request.js';
import type { TileRequest } from '../lib/weather/relay-request.js';
import {
    UNAVAILABLE,
    fetchUpstream,
    logThrottled,
    pauseUpstream,
    relay,
    upstreamPausedFor,
    userAgent,
} from '../lib/weather/relay-upstream.js';
import type { FlightResult, TileType, UpstreamResponse } from '../lib/weather/relay-upstream.js';

const TILE_MAX_AGE = 600;
const FALLBACK_MAX_AGE = 30;
const STATUS_LIMIT = 60;
/**
 * Upstream fetches per task and minute. The weather-proxy allows 600 requests per
 * minute per client IP and re-arms its counter TTL on every allowed hit, so a
 * limit at or above 600 would never protect it. Stay well below 600.
 */
const TASK_FETCH_LIMIT = 500;
const ATTRIBUTION = 'Weather data provided by Rainbow.ai';

type RelayErr = Err & { retryAfterS?: number };

function tooMany(retryAfterS: number, message = 'Too many weather requests'): RelayErr {
    const err: RelayErr = new Err(429, null, message, false);
    err.retryAfterS = retryAfterS;
    return err;
}

function upstreamErr(status: number, message: string): Err {
    return new Err(status, null, message, false);
}

/**
 * Replace the value of every `token` query parameter
 */
function redactToken(url: string): string {
    return url.replace(/([?&]token=)[^&#]*/g, '$1***');
}
function cacheable(cacheControl: string | null): boolean {
    if (!cacheControl) return true;
    return !/\b(no-store|no-cache)\b|max-age=0(?![0-9])/i.test(cacheControl);
}

/**
 * Turn an upstream answer into a tile, or throw the error the client sees.
 * Upstream bodies and messages are never forwarded.
 */
function mapUpstream(up: UpstreamResponse, tile: TileRequest, cacheKey: string): FlightResult {
    if (up.status === 401 || up.status === 403) {
        logThrottled('error', 'upstream:auth', 'Weather relay: the weather proxy rejected the configured API key');
        throw upstreamErr(502, 'Weather upstream authentication failed');
    }

    if (up.status === 429) {
        // Stop every cache miss of this task from reaching the proxy for a while
        throw tooMany(pauseUpstream(up.retryAfterS), 'Weather upstream is rate limiting requests');
    }

    if (up.status === 400) throw upstreamErr(502, 'Weather upstream rejected the request');
    if (up.status === 404) throw upstreamErr(502, 'Weather upstream not found');
    if (up.status !== 200 || !up.body || !up.contentType) throw upstreamErr(502, UNAVAILABLE);

    if (up.error) throw upstreamErr(502, UNAVAILABLE);

    if (up.fallback) {
        // A fallback tile is current radar. Under a forecast label that would be wrong.
        if (tile.forecast > 0) throw upstreamErr(502, UNAVAILABLE);
        return { body: up.body, contentType: up.contentType, short: true };
    }

    if (cacheable(up.cacheControl)) relay.cache.set(cacheKey, up.body, up.contentType);
    return { body: up.body, contentType: up.contentType, short: false };
}

export default async function router(schema: Schema, config: ConfigStateless) {
    // Schema validation answers before the handlers run. Make those errors uncacheable
    // too; the success path overwrites the header.
    schema.router.use('/weather', (req, res, next) => {
        res.setHeader('Cache-Control', 'no-store');
        // The platform access log (morgan) prints req.originalUrl once the response is
        // sent. Keep the real URL for the handler and show the log a copy without the
        // session token.
        res.locals.weatherUrl = req.originalUrl;
        req.originalUrl = redactToken(req.originalUrl);
        next();
    });

    await schema.get('/weather/status', {
        name: 'Weather Status',
        group: 'Weather',
        description: 'Report whether the weather tile relay is enabled and which snapshot is the newest available',
        res: Type.Object({
            apiVersion: Type.Literal(1),
            enabled: Type.Boolean(),
            serverTime: Type.Integer(),
            snapshot: Type.Integer(),
            layers: Type.Array(Type.String()),
        }),
    }, async (req, res) => {
        try {
            const user = await Auth.as_user(config, req);

            const limit = relay.status.hit(user.email.toLowerCase(), STATUS_LIMIT);
            if (!limit.ok) throw tooMany(limit.retryAfterS);

            const serverTime = Math.floor(relay.now() / 1000);
            const enabled = getRelayConfig().enabled;

            res.setHeader('Cache-Control', 'no-store');
            res.json({
                apiVersion: 1,
                enabled,
                serverTime,
                snapshot: latestSnapshot(serverTime),
                layers: enabled ? [...LAYERS] : [],
            });
        } catch (err) {
            fail(err, res);
        }
    });

    await schema.get('/weather/tile/:z/:x/:y.png', {
        name: 'Weather Tile',
        group: 'Weather',
        description: 'Fetch a weather radar, precipitation or cloud tile through the configured weather proxy',
        params: Type.Object({
            z: Type.Integer({ minimum: 0 }),
            x: Type.Integer({ minimum: 0 }),
            y: Type.Integer({ minimum: 0 }),
        }),
        query: Type.Object({
            layer: Type.Optional(Type.String()),
            forecast: Type.Optional(Type.String()),
            snapshot: Type.Optional(Type.String()),
            size: Type.Optional(Type.String()),
            color: Type.Optional(Type.String()),
            coverage: Type.Optional(Type.String()),
            use_precip_type: Type.Optional(Type.String()),
            token: Type.Optional(Type.String()),
        }),
    }, async (req, res) => {
        const started = Date.now();
        let username = '';
        let status = 500;
        let cache = 'none';
        let sent: TileType | null = null;
        let audit: Partial<TileRequest> = {};

        try {
            const user = await Auth.as_user(config, req, { token: true });
            username = user.email;

            const cfg = getRelayConfig();
            if (!cfg.enabled || !cfg.baseUrl || !cfg.key) throw new Err(403, null, 'Weather is disabled', false);

            const id = user.email.toLowerCase();
            const rate = relay.tile.hit(id, cfg.rate);
            if (!rate.ok) throw tooMany(rate.retryAfterS);

            const search = new URL(String(res.locals.weatherUrl ?? req.originalUrl), 'http://localhost').searchParams;
            const tile = parseTileRequest(req.params, search, Math.floor(relay.now() / 1000));
            audit = tile;

            const cacheKey = tileCacheKey(tile);
            const cached = relay.cache.get(cacheKey);
            let body: Buffer;
            let contentType: TileType;
            let short = false;

            if (cached) {
                body = cached.body;
                contentType = cached.contentType;
                cache = 'hit';
            } else {
                // Nothing between this check and run() awaits, so a caller that
                // finds no flight is guaranteed to lead the new one.
                if (!relay.flights.has(cacheKey)) {
                    // After an upstream 429 (or this task's own fetch cap) only cache hits
                    // are served; a miss is answered without calling the proxy
                    const paused = upstreamPausedFor();
                    if (paused > 0) throw tooMany(paused, 'Weather upstream is rate limiting requests');

                    const miss = relay.miss.hit(id, Math.max(60, Math.floor(cfg.rate / 3)));
                    if (!miss.ok) throw tooMany(miss.retryAfterS);

                    const task = relay.task.hit('task', TASK_FETCH_LIMIT);
                    if (!task.ok) throw tooMany(pauseUpstream(task.retryAfterS));
                }

                const url = buildUpstreamUrl(cfg.baseUrl, tile, cfg.key);
                const { value, shared } = await relay.flights.run(cacheKey, async () => {
                    const up = await fetchUpstream(url, userAgent(config.API_URL));
                    return mapUpstream(up, tile, cacheKey);
                });

                body = value.body;
                contentType = value.contentType;
                short = value.short;
                cache = shared ? 'shared' : 'miss';
            }

            status = 200;
            sent = contentType;
            res.status(200);
            res.setHeader('Content-Type', contentType);
            res.setHeader('Content-Length', body.byteLength);
            res.setHeader('Cache-Control', `private, max-age=${short ? FALLBACK_MAX_AGE : TILE_MAX_AGE}`);
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('X-Weather-Api', '1');
            res.setHeader('X-Weather-Snapshot', String(tile.snapshot));
            res.setHeader('X-Weather-Cache', cache);
            res.setHeader('Attribution', ATTRIBUTION);
            res.end(body);
        } catch (err) {
            status = fail(err, res);
        } finally {
            console.info(JSON.stringify({
                type: 'weather',
                username,
                layer: audit.layer ?? null,
                z: audit.z ?? null,
                x: audit.x ?? null,
                y: audit.y ?? null,
                forecast: audit.forecast ?? null,
                status,
                cache,
                contentType: sent,
                ms: Date.now() - started,
            }));
        }
    });
}

/**
 * Respond with an error that is never cached and return its status
 */
function fail(err: unknown, res: Parameters<typeof Err.respond>[1]): number {
    res.setHeader('Cache-Control', 'no-store');

    const retry = (err as RelayErr | undefined)?.retryAfterS;
    if (typeof retry === 'number') res.setHeader('Retry-After', String(retry));

    Err.respond(err, res);

    const status = Number((err as { status?: number } | undefined)?.status);
    return Number.isNaN(status) ? 500 : status;
}
