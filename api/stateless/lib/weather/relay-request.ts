import Err from '@openaddresses/batch-error';

/**
 * Validation of the public tile request and construction of the upstream
 * request. Nothing from the client is ever forwarded verbatim: every value is
 * parsed against a strict allow list and the upstream URL is rebuilt from the
 * parsed result.
 */

export type WeatherLayer = 'precip' | 'precip-global' | 'clouds' | 'radars';

export const LAYERS: WeatherLayer[] = ['precip', 'precip-global', 'clouds', 'radars'];

export const RULES: Record<WeatherLayer, { color: boolean; forecast: boolean; coverage: boolean; usePrecipType: boolean }> = {
    'precip': { color: true, forecast: true, coverage: true, usePrecipType: false },
    'precip-global': { color: true, forecast: true, coverage: true, usePrecipType: false },
    'clouds': { color: false, forecast: false, coverage: false, usePrecipType: false },
    'radars': { color: true, forecast: false, coverage: true, usePrecipType: true },
};

export const ALLOWED_KEYS = [
    'layer', 'forecast', 'snapshot', 'size', 'color', 'coverage', 'use_precip_type', 'token',
];

const COLORS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'dbz_u8'];

export const SNAPSHOT_STEP_S = 600;
export const SNAPSHOT_WINDOW_S = 7200;
const MAX_ZOOM = 9;
const MAX_FORECAST = 240;

export interface TileRequest {
    layer: WeatherLayer;
    z: number;
    x: number;
    y: number;
    forecast: number;
    snapshot: number;
    size: 256 | 512;
    color: string | null;
    coverage: boolean;
    usePrecipType: boolean;
}

/**
 * Newest snapshot (epoch seconds) the relay accepts and reports: the last
 * fully elapsed 10 minute step.
 */
export function latestSnapshot(nowS: number): number {
    return Math.floor(nowS / SNAPSHOT_STEP_S) * SNAPSHOT_STEP_S - SNAPSHOT_STEP_S;
}

function bad(message: string): Err {
    return new Err(400, null, message, false);
}

/**
 * The snapshot a request is served from, given the newest snapshot of its layer.
 *
 * No snapshot (or `latest`) means the newest one. A snapshot newer than the
 * newest is served as the newest, so a client whose clock runs ahead of a
 * lagging layer still gets that layer's data and shares one cache entry. A
 * snapshot older than the two hour window is rejected. The value itself is
 * never echoed.
 */
export function effectiveSnapshot(requested: number | null, latest: number): number {
    if (requested === null) return latest;
    if (requested < latest - SNAPSHOT_WINDOW_S) throw bad('snapshot out of range');
    return requested > latest ? latest : requested;
}

/**
 * Convert one query value to its single string. A key sent more than once
 * is rejected by the caller before this is reached.
 */
function single(search: URLSearchParams, key: string): string | undefined {
    const value = search.get(key);
    return value === null ? undefined : value;
}

function coordinate(name: string, raw: number, max: number): number {
    if (!Number.isInteger(raw) || raw < 0 || raw >= max) {
        throw bad(`Invalid tile ${name}`);
    }
    return raw;
}

export function parseTileRequest(
    params: { z: number | string; x: number | string; y: number | string },
    search: URLSearchParams,
    nowS: number,
    latestFor: (layer: WeatherLayer) => number = () => latestSnapshot(nowS),
): TileRequest {
    // Unknown and repeated keys. Names are echoed, values never are, and only
    // allow-listed names are echoed so the message cannot reflect input.
    const seen = new Set<string>();
    for (const key of search.keys()) {
        if (!ALLOWED_KEYS.includes(key)) throw bad('Unsupported query parameter');
        if (seen.has(key)) throw bad(`Query parameter ${key} may only be given once`);
        seen.add(key);
    }

    const z = Number(params.z);
    if (!Number.isInteger(z) || z < 0 || z > MAX_ZOOM) throw bad('Invalid tile z');
    const max = 2 ** z;
    const x = coordinate('x', Number(params.x), max);
    const y = coordinate('y', Number(params.y), max);

    const layerRaw = single(search, 'layer');
    if (layerRaw === undefined) throw bad('Query parameter layer is required');
    if (!LAYERS.includes(layerRaw as WeatherLayer)) throw bad('Invalid layer');
    const layer = layerRaw as WeatherLayer;
    const rule = RULES[layer];

    let forecast = 0;
    const forecastRaw = single(search, 'forecast');
    if (forecastRaw !== undefined) {
        if (!/^(0|[1-9][0-9]{0,2})$/.test(forecastRaw)) throw bad('Invalid forecast');
        forecast = Number(forecastRaw);
        if (forecast > MAX_FORECAST || forecast % 10 !== 0) throw bad('Invalid forecast');
        if (!rule.forecast && forecast !== 0) throw bad('forecast is not supported for this layer');
    }

    let requested: number | null = null;
    const snapshotRaw = single(search, 'snapshot');
    if (snapshotRaw !== undefined && snapshotRaw !== 'latest') {
        if (!/^[0-9]{10}$/.test(snapshotRaw)) throw bad('Invalid snapshot');
        requested = Number(snapshotRaw);
        if (requested % SNAPSHOT_STEP_S !== 0) throw bad('Invalid snapshot');
    }
    const snapshot = effectiveSnapshot(requested, latestFor(layer));

    let size: 256 | 512 = 256;
    const sizeRaw = single(search, 'size');
    if (sizeRaw !== undefined) {
        if (sizeRaw !== '256' && sizeRaw !== '512') throw bad('Invalid size');
        size = sizeRaw === '512' ? 512 : 256;
    }

    let color: string | null = null;
    const colorRaw = single(search, 'color');
    if (colorRaw !== undefined) {
        if (!rule.color) throw bad('color is not supported for this layer');
        if (!COLORS.includes(colorRaw)) throw bad('Invalid color');
        color = colorRaw;
    }

    let coverage = false;
    const coverageRaw = single(search, 'coverage');
    if (coverageRaw !== undefined) {
        if (!rule.coverage) throw bad('coverage is not supported for this layer');
        if (coverageRaw !== '0' && coverageRaw !== '1') throw bad('Invalid coverage');
        coverage = coverageRaw === '1';
    }

    let usePrecipType = false;
    const typeRaw = single(search, 'use_precip_type');
    if (typeRaw !== undefined) {
        if (!rule.usePrecipType) throw bad('use_precip_type is not supported for this layer');
        if (typeRaw !== '0' && typeRaw !== '1') throw bad('Invalid use_precip_type');
        usePrecipType = typeRaw === '1';
    }

    return { layer, z, x, y, forecast, snapshot, size, color, coverage, usePrecipType };
}

/**
 * Build the upstream URL. The parameter order is fixed, defaults are omitted
 * and the API key always comes last.
 */
export function buildUpstreamUrl(baseUrl: string, req: TileRequest, key: string): URL {
    let url = `${baseUrl}/${req.z}/${req.x}/${req.y}.png?provider=rainbow&layer=${req.layer}`;

    if (req.color !== null) url += `&color=${req.color}`;
    if (req.forecast > 0) url += `&forecast=${req.forecast}`;
    if (req.coverage) url += '&coverage=1';
    if (req.usePrecipType) url += '&use_precip_type=1';
    url += `&snapshot=${req.snapshot}`;
    if (req.size === 512) url += '&size=512';
    url += `&api=${encodeURIComponent(key)}`;

    return new URL(url);
}

/**
 * Cache key. Holds the effective snapshot, never the requested one, and no user,
 * API key or session token.
 */
export function tileCacheKey(req: TileRequest): string {
    return `${req.layer}|${req.z}/${req.x}/${req.y}|f${req.forecast}|s${req.snapshot}|z${req.size}|c${req.color ?? '-'}|v${req.coverage ? 1 : 0}|p${req.usePrecipType ? 1 : 0}`;
}
