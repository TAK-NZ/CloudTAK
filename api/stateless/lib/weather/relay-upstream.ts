import fs from 'node:fs';
import Err from '@openaddresses/batch-error';
import { fetch } from '@tak-ps/node-safeurl';
import { FixedWindowLimiter } from './relay-limiter.js';
import { TileCache, SingleFlight } from './relay-cache.js';
import { upstreamAllowForTests, __resetWarned } from './relay-config.js';

export { upstreamAllowForTests };

const pkg = JSON.parse(String(fs.readFileSync(new URL('../../../package.json', import.meta.url))));

export const UPSTREAM_TIMEOUT_MS = 8000;
export const MAX_TILE_BYTES = 1024 * 1024;
export const UNAVAILABLE = 'Weather upstream unavailable';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
const LOG_INTERVAL_MS = 60000;

export interface UpstreamResponse {
    status: number;
    contentType: string | null;
    body: Buffer | null;
    fallback: boolean;
    error: boolean;
    cacheControl: string | null;
    retryAfterS: number | null;
}

export interface FlightResult {
    body: Buffer;
    /** True when the tile is a transient fallback that must only be cached briefly by the client */
    short: boolean;
}

export interface RelayRuntime {
    now: () => number;
    upstreamTimeoutMs: number;
    /** Tile requests per user per minute */
    tile: FixedWindowLimiter;
    /** Upstream fetches led by one user per minute */
    miss: FixedWindowLimiter;
    /** Upstream fetches per task per minute */
    task: FixedWindowLimiter;
    /** Status calls per user per minute */
    status: FixedWindowLimiter;
    cache: TileCache;
    flights: SingleFlight<FlightResult>;
    logged: Map<string, number>;
}

function create(opts: { now?: () => number; upstreamTimeoutMs?: number; cacheMaxBytes?: number }): RelayRuntime {
    const runtime: RelayRuntime = {
        now: opts.now ?? (() => Date.now()),
        upstreamTimeoutMs: opts.upstreamTimeoutMs ?? UPSTREAM_TIMEOUT_MS,
        tile: undefined as unknown as FixedWindowLimiter,
        miss: undefined as unknown as FixedWindowLimiter,
        task: undefined as unknown as FixedWindowLimiter,
        status: undefined as unknown as FixedWindowLimiter,
        cache: undefined as unknown as TileCache,
        flights: new SingleFlight<FlightResult>(),
        logged: new Map(),
    };

    const now = () => runtime.now();
    runtime.tile = new FixedWindowLimiter({ windowMs: 60000, now });
    runtime.miss = new FixedWindowLimiter({ windowMs: 60000, now });
    runtime.task = new FixedWindowLimiter({ windowMs: 60000, now });
    runtime.status = new FixedWindowLimiter({ windowMs: 60000, now });
    runtime.cache = new TileCache({ now, maxBytes: opts.cacheMaxBytes });

    return runtime;
}

export const relay: RelayRuntime = create({});

/**
 * Test hook: replace all limiters, the cache, the single-flight map and the
 * warning memory. Production code never calls this.
 */
export function __resetForTests(opts: { now?: () => number; upstreamTimeoutMs?: number; cacheMaxBytes?: number } = {}): void {
    for (const limiter of [relay.tile, relay.miss, relay.task, relay.status]) limiter.stop();

    Object.assign(relay, create(opts));
    __resetWarned();
}

/**
 * Replace the secret values in a URL so it can be logged
 */
export function redactUrl(url: URL | string): string {
    const parsed = new URL(String(url));
    for (const name of ['api', 'key', 'token']) {
        if (parsed.searchParams.has(name)) parsed.searchParams.set(name, '***');
    }
    return parsed.toString();
}

/**
 * Log at most once a minute per message key
 */
export function logThrottled(level: 'warn' | 'error', key: string, message: string): void {
    const now = relay.now();
    const last = relay.logged.get(key);
    if (last !== undefined && now - last < LOG_INTERVAL_MS) return;

    relay.logged.set(key, now);
    if (level === 'warn') {
        console.warn(message);
    } else {
        console.error(message);
    }
}

export function userAgent(apiUrl: string): string {
    return `CloudTAK/${pkg.version} (+${apiUrl})`;
}

function unavailable(url: URL, reason: string): Err {
    logThrottled('warn', `upstream:${reason}`, `Weather relay: upstream failed (${reason}) for ${redactUrl(url)}`);
    return new Err(502, null, UNAVAILABLE, false);
}

function parseRetryAfter(raw: string | null): number | null {
    if (!raw || !/^[0-9]{1,6}$/.test(raw.trim())) return null;
    return Number(raw.trim());
}

async function readBody(res: { body: ReadableStream<Uint8Array> | null }): Promise<Buffer | null> {
    if (!res.body) return Buffer.alloc(0);

    const reader = res.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;

    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        total += value.byteLength;
        if (total > MAX_TILE_BYTES) {
            await reader.cancel().catch(() => undefined);
            return null;
        }

        chunks.push(Buffer.from(value));
    }

    return Buffer.concat(chunks, total);
}

/**
 * Fetch one tile from the weather proxy.
 *
 * Returns the upstream status for any non-200 answer that the caller maps
 * itself. Throws a 502 for everything that is not a usable PNG tile: network
 * errors, timeouts, SSRF blocks, redirects, wrong content type, bad magic bytes
 * and oversize bodies.
 */
export async function fetchUpstream(url: URL, agent = `CloudTAK/${pkg.version}`): Promise<UpstreamResponse> {
    let res;
    try {
        res = await fetch(url, {
            headers: {
                'user-agent': agent,
                'accept': 'image/png',
            },
            redirect: 'manual',
            timeout: relay.upstreamTimeoutMs,
            safeUrlAllow: upstreamAllowForTests,
        });
    } catch (err) {
        const name = err instanceof Error ? err.name : 'Error';
        const status = err instanceof Err ? `blocked ${err.status}` : name;
        throw unavailable(url, status);
    }

    const headers = res.headers;
    const result: UpstreamResponse = {
        status: res.status,
        contentType: headers.get('content-type'),
        body: null,
        fallback: headers.has('x-weather-fallback'),
        error: headers.has('x-weather-error'),
        cacheControl: headers.get('cache-control'),
        retryAfterS: parseRetryAfter(headers.get('retry-after')),
    };

    if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel().catch(() => undefined);
        throw unavailable(url, `redirect ${res.status}`);
    }

    if (res.status !== 200) {
        await res.body?.cancel().catch(() => undefined);
        return result;
    }

    if (!result.contentType || !result.contentType.toLowerCase().startsWith('image/png')) {
        await res.body?.cancel().catch(() => undefined);
        throw unavailable(url, 'content-type');
    }

    let body: Buffer | null;
    try {
        body = await readBody(res as unknown as { body: ReadableStream<Uint8Array> | null });
    } catch (err) {
        throw unavailable(url, err instanceof Error ? err.name : 'body');
    }

    if (body === null) throw unavailable(url, 'too large');
    if (body.byteLength < PNG_MAGIC.byteLength || !body.subarray(0, PNG_MAGIC.byteLength).equals(PNG_MAGIC)) {
        throw unavailable(url, 'not a png');
    }

    result.body = body;
    return result;
}
