import {
    LAYERS,
    SNAPSHOT_STEP_S,
    SNAPSHOT_WINDOW_S,
    latestSnapshot,
} from './relay-request.js';
import type { WeatherLayer } from './relay-request.js';
import { fetchJsonUpstream, pauseUpstream, relay, upstreamPausedFor } from './relay-upstream.js';

/**
 * Newest snapshot per layer. The weather-proxy knows it per layer because
 * Rainbow publishes some layers (clouds) later than others. `source` is
 * 'computed' when the relay could not ask the proxy and used the clock.
 */
export interface LayerLatest {
    snapshot: number;
    source: 'rainbow' | 'computed';
}

/** How long a layer's newest snapshot is reused */
export const LATEST_TTL_MS = 30000;

/**
 * URL of the proxy's snapshot endpoint. Carries the API key, so it must only be
 * logged through `redactUrl`.
 */
export function buildSnapshotUrl(baseUrl: string, layer: WeatherLayer, key: string): URL {
    return new URL(`${baseUrl}/snapshot?layer=${layer}&api=${encodeURIComponent(key)}`);
}

export function computedLatest(nowS: number): LayerLatest {
    return { snapshot: latestSnapshot(nowS), source: 'computed' };
}

/**
 * Validate the proxy's answer. Returns null for anything unexpected; fields
 * other than `snapshot` and `source` are ignored and never copied.
 */
export function parseSnapshotResponse(json: unknown, nowS: number): LayerLatest | null {
    if (typeof json !== 'object' || json === null || Array.isArray(json)) return null;

    const { snapshot, source } = json as { snapshot?: unknown; source?: unknown };

    if (typeof snapshot !== 'number' || !Number.isInteger(snapshot) || snapshot % SNAPSHOT_STEP_S !== 0) return null;

    const newest = latestSnapshot(nowS);
    if (snapshot < newest - SNAPSHOT_WINDOW_S || snapshot > newest + SNAPSHOT_STEP_S) return null;

    if (source !== undefined && source !== 'rainbow' && source !== 'computed') return null;

    return { snapshot, source: source ?? 'rainbow' };
}

interface SnapshotConfig {
    baseUrl: string;
    key: string;
}

/**
 * Ask the proxy once. Never throws: any failure (network, 404 from an older
 * proxy, 400, 5xx, garbage) gives the computed snapshot. A 429 also pauses
 * upstream fetches. The answer, computed or not, is cached for 30 s so an
 * older proxy is not asked again for every tile.
 */
async function fetchLatest(layer: WeatherLayer, cfg: SnapshotConfig, agent: string): Promise<LayerLatest> {
    let value = computedLatest(Math.floor(relay.now() / 1000));

    try {
        const res = await fetchJsonUpstream(buildSnapshotUrl(cfg.baseUrl, layer, cfg.key), agent);

        if (res.status === 429) {
            pauseUpstream(res.retryAfterS);
        } else if (res.status === 200) {
            value = parseSnapshotResponse(res.json, Math.floor(relay.now() / 1000)) ?? value;
        }
    } catch {
        // fetchJsonUpstream already logged it, without the key
    }

    relay.latest.set(layer, { value, expires: relay.now() + LATEST_TTL_MS });
    return value;
}

/**
 * Newest snapshot of one layer.
 *
 * Served from a 30 s cache. Concurrent callers share one proxy call. While the
 * upstream is paused after a 429 the proxy is not asked and the computed value
 * is returned without being cached. A caller waits at most
 * `relay.latestBudgetMs` for the answer and then uses the computed value; the
 * lookup keeps running and fills the cache for the next caller.
 */
export async function resolveLatest(layer: WeatherLayer, cfg: SnapshotConfig, agent: string): Promise<LayerLatest> {
    const cached = relay.latest.get(layer);
    if (cached && cached.expires > relay.now()) return cached.value;

    const computed = () => computedLatest(Math.floor(relay.now() / 1000));
    if (upstreamPausedFor() > 0) return computed();

    let timer: NodeJS.Timeout | undefined;
    const budget = new Promise<LayerLatest>((resolve) => {
        timer = setTimeout(() => resolve(computed()), relay.latestBudgetMs);
    });

    try {
        const flight = relay.latestFlights.run(layer, () => fetchLatest(layer, cfg, agent)).then(r => r.value);
        return await Promise.race([flight, budget]);
    } catch {
        return computed();
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Newest snapshot of every layer, looked up in parallel. Never throws.
 */
export async function statusLatest(cfg: SnapshotConfig, agent: string): Promise<Record<WeatherLayer, LayerLatest>> {
    const entries = await Promise.all(LAYERS.map(async (layer) => {
        const value = await resolveLatest(layer, cfg, agent).catch(() => computedLatest(Math.floor(relay.now() / 1000)));
        return [layer, value] as const;
    }));

    return Object.fromEntries(entries) as Record<WeatherLayer, LayerLatest>;
}
