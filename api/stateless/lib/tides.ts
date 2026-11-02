import { Type, Static } from '@sinclair/typebox';
import { fetch } from '@tak-ps/node-safeurl';
import Err from '@openaddresses/batch-error';
import { wrapLongitude } from './sun.js';

/**
 * Tide predictions for a point, from the Open Waters tides API
 * (https://openwaters.io/api/tides/, harmonic constituents via Slackwater).
 *
 * The upstream API always answers with the nearest station, however far away
 * it is: a query in the open South Pacific still returns a station 2000 km away.
 * Whether a station is close enough to be meaningful is therefore decided here,
 * by MAX_STATION_DISTANCE_KM.
 */
export const TIDES_API = 'https://api.openwaters.io/tides';

/**
 * Stations further than this from the queried point are treated as "no station".
 *
 * Generous on purpose: along a long open coast with few stations (the NZ West
 * Coast, for one) the nearest station can be 150 km away and is still far more
 * useful than nothing. The client warns about stations beyond its own, much
 * smaller, distance (NEAR_STATION_KM in Query/Tides.vue).
 */
export const MAX_STATION_DISTANCE_KM = 200;

/** The prediction window starts this long before "now" and runs for WINDOW_HOURS. */
export const WINDOW_LOOKBACK_HOURS = 12;
export const WINDOW_HOURS = 48;

const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_MAX_ENTRIES = 500;
const REQUEST_TIMEOUT_MS = 10_000;

export type TideUnits = 'meters' | 'feet';

export const TideStation = Type.Object({
    id: Type.String({ description: 'Station identifier, e.g. linz/070' }),
    name: Type.String(),
    latitude: Type.Number(),
    longitude: Type.Number(),
    distance: Type.Number({ description: 'Distance from the queried point to the station, in kilometers' }),
    timezone: Type.Optional(Type.String({ description: 'IANA timezone of the station' })),
    datum: Type.String({ description: 'Vertical datum the heights are measured above, e.g. CD (chart datum) or LAT' }),
    attribution: Type.Optional(Type.String({ description: 'Attribution text required by the data license' })),
});

export const TideExtreme = Type.Object({
    time: Type.String({ description: 'ISO 8601 UTC instant' }),
    level: Type.Number(),
    type: Type.Union([Type.Literal('high'), Type.Literal('low')]),
});

export const TideLevel = Type.Object({
    time: Type.String({ description: 'ISO 8601 UTC instant' }),
    level: Type.Number(),
});

export const TideResponse = Type.Object({
    station: TideStation,
    units: Type.Union([Type.Literal('meters'), Type.Literal('feet')]),
    start: Type.String({ description: 'ISO 8601 UTC start of the prediction window' }),
    end: Type.String({ description: 'ISO 8601 UTC end of the prediction window' }),
    extremes: Type.Array(TideExtreme),
    timeline: Type.Array(TideLevel),
});

export type Tides = Static<typeof TideResponse>;

type UpstreamStation = {
    id?: unknown;
    name?: unknown;
    latitude?: unknown;
    longitude?: unknown;
    timezone?: unknown;
    chart_datum?: unknown;
    attribution?: unknown;
};

type UpstreamExtremes = {
    datum?: unknown;
    station?: UpstreamStation;
    distance?: unknown;
    extremes?: Array<{ time?: unknown; level?: unknown; high?: unknown }>;
};

type UpstreamTimeline = {
    station?: UpstreamStation;
    timeline?: Array<{ time?: unknown; level?: unknown }>;
};

function finite(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function round(value: number, places: number): number {
    const factor = 10 ** places;
    return Math.round(value * factor) / factor;
}

/**
 * Turn the two upstream responses into the CloudTAK response, or null when the
 * nearest station is further than MAX_STATION_DISTANCE_KM away.
 *
 * Throws a 502 if the upstream payload does not have the expected shape, rather
 * than returning a partial chart.
 */
export function normalizeTides(
    extremes: UpstreamExtremes,
    timeline: UpstreamTimeline,
    units: TideUnits,
    start: Date,
    end: Date,
): Tides | null {
    const station = extremes.station;

    if (
        !station
        || typeof station.id !== 'string'
        || typeof station.name !== 'string'
        || !finite(station.latitude)
        || !finite(station.longitude)
        || !finite(extremes.distance)
        || !Array.isArray(extremes.extremes)
        || !Array.isArray(timeline.timeline)
    ) {
        throw new Err(502, null, 'Tide service returned an unexpected response');
    }

    if (extremes.distance > MAX_STATION_DISTANCE_KM) return null;

    if (timeline.station && timeline.station.id !== station.id) {
        throw new Err(502, null, 'Tide service returned mismatched stations');
    }

    const datum = typeof station.chart_datum === 'string'
        ? station.chart_datum
        : typeof extremes.datum === 'string' ? extremes.datum : 'CD';

    const result: Tides = {
        station: {
            id: station.id,
            name: station.name,
            latitude: station.latitude,
            longitude: station.longitude,
            distance: round(extremes.distance, 1),
            datum,
        },
        units,
        start: start.toISOString(),
        end: end.toISOString(),
        extremes: [],
        timeline: [],
    };

    if (typeof station.timezone === 'string' && station.timezone) result.station.timezone = station.timezone;
    if (typeof station.attribution === 'string' && station.attribution) result.station.attribution = station.attribution;

    for (const e of extremes.extremes) {
        if (typeof e.time !== 'string' || !finite(e.level)) continue;
        result.extremes.push({
            time: e.time,
            level: round(e.level, 3),
            type: e.high === true ? 'high' : 'low',
        });
    }

    for (const p of timeline.timeline) {
        if (typeof p.time !== 'string' || !finite(p.level)) continue;
        result.timeline.push({ time: p.time, level: round(p.level, 3) });
    }

    return result;
}

async function upstream<T>(path: string, params: URLSearchParams): Promise<T> {
    const url = new URL(`${TIDES_API}/${path}`);
    url.search = params.toString();

    let res;
    try {
        res = await fetch(url, { timeout: REQUEST_TIMEOUT_MS });
    } catch (err) {
        throw new Err(502, err instanceof Error ? err : new Error(String(err)), 'Tide service unavailable');
    }

    if (!res.ok) {
        throw new Err(502, new Error(`Tide service returned ${res.status}`), 'Tide service unavailable');
    }

    try {
        return await res.json() as T;
    } catch (err) {
        throw new Err(502, err instanceof Error ? err : new Error(String(err)), 'Tide service returned an unexpected response');
    }
}

type CacheEntry = { expires: number; value: Tides | null };
const cache = new Map<string, CacheEntry>();

/** Test hook: forget every cached prediction. */
export function clearTidesCache(): void {
    cache.clear();
}

/**
 * Predicted tides for the nearest station to a point, for 12 hours before to
 * 36 hours after `now`. Resolves to null when no station is within
 * MAX_STATION_DISTANCE_KM.
 *
 * The window start is truncated to the hour so that requests in the same hour
 * share a cache entry. Coordinates are keyed to 0.01 degrees (about 1 km), which
 * is far finer than station spacing.
 */
export async function getTides(
    longitude: number,
    latitude: number,
    units: TideUnits,
    now: Date = new Date(),
): Promise<Tides | null> {
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90) {
        throw new Err(400, null, 'Invalid coordinates');
    }

    const lon = wrapLongitude(longitude);

    const hour = 60 * 60 * 1000;
    const start = new Date(Math.floor(now.getTime() / hour) * hour - WINDOW_LOOKBACK_HOURS * hour);
    const end = new Date(start.getTime() + WINDOW_HOURS * hour);

    const key = `${latitude.toFixed(2)},${lon.toFixed(2)},${units},${start.getTime()}`;
    const hit = cache.get(key);
    if (hit && hit.expires > now.getTime()) return hit.value;

    const params = new URLSearchParams({
        latitude: String(latitude),
        longitude: String(lon),
        start: start.toISOString(),
        end: end.toISOString(),
        units,
    });

    const [extremes, timeline] = await Promise.all([
        upstream<UpstreamExtremes>('extremes', params),
        upstream<UpstreamTimeline>('timeline', params),
    ]);

    const value = normalizeTides(extremes, timeline, units, start, end);

    if (cache.size >= CACHE_MAX_ENTRIES) {
        const oldest = cache.keys().next();
        if (!oldest.done) cache.delete(oldest.value);
    }
    cache.set(key, { expires: now.getTime() + CACHE_TTL_MS, value });

    return value;
}
