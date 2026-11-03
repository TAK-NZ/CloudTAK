/**
 * Breadcrumb trail helpers shared by the CoT view, the feature viewer & the map
 *
 * TAK.NZ-only file. Upstream v13.115.0 turned trails into `feature_history`
 * points drawn by the HistoryLayer instead of a `<uid>.track` feature, which
 * removed the only way to select and delete a trail from where it is used.
 * These helpers back the actions that put it back: see TrailActions.vue,
 * TrailPointBanner.vue and the trail click handling in stores/modules/history.ts.
 */
import { db } from '../database.ts';
import FeatureHistory from './feature-history.ts';

export type TrailSummary = {
    uid: string;
    callsign: string;
    color?: string;
    /** Live recording is switched on */
    live: boolean;
    points: number;
    /** Report time of the oldest and newest point in epoch ms, null without points */
    first: number | null;
    last: number | null;
};

/** What the trail helpers need from a MapLibre map */
export type TrailMap = {
    fitBounds(bounds: [[number, number], [number, number]], opts?: { padding?: number; maxZoom?: number }): unknown;
    flyTo(opts: { center: [number, number]; zoom?: number }): unknown;
    getZoom(): number;
};

/**
 * Summarise the trail of a CoT, or null when it has neither a trail record
 * nor any history points. A recording that has not seen a report yet is
 * returned with zero points so the UI can say so.
 */
export async function trailSummary(uid: string): Promise<TrailSummary | null> {
    const [trail, points, first, last] = await Promise.all([
        db.breadcrumb.get(`${uid}.track`),
        FeatureHistory.count(uid),
        db.feature_history
            .where('[uid+time]')
            .between([uid, -Infinity], [uid, Infinity], true, true)
            .first(),
        FeatureHistory.latest(uid),
    ]);

    if (!trail && !points) return null;

    // Trails recorded before history points existed only carry coordinates
    const legacy = !points && trail && trail.coordinates ? trail.coordinates.length : 0;

    return {
        uid,
        callsign: trail ? trail.callsign : (last ? last.callsign : uid),
        color: trail ? trail.color : undefined,
        live: trail ? trail.live : false,
        points: points || legacy,
        first: first ? first.time : null,
        last: last ? last.time : null,
    };
}

/** [west, south, east, north] of a trail, or null when there is nothing to frame */
export async function trailBounds(uid: string): Promise<[number, number, number, number] | null> {
    const positions: number[][] = [];

    for (const row of await FeatureHistory.list({ uid })) {
        if (row.geometry.type === 'Point') positions.push(row.geometry.coordinates);
    }

    if (!positions.length) {
        const trail = await db.breadcrumb.get(`${uid}.track`);
        if (trail && trail.coordinates) positions.push(...trail.coordinates);
    }

    if (!positions.length) return null;

    let west = Infinity;
    let south = Infinity;
    let east = -Infinity;
    let north = -Infinity;

    for (const [lon, lat] of positions) {
        west = Math.min(west, lon);
        east = Math.max(east, lon);
        south = Math.min(south, lat);
        north = Math.max(north, lat);
    }

    return [west, south, east, north];
}

/** Frame the whole trail, or centre on it when it is a single position. Returns false when there is no trail */
export async function zoomToTrail(map: TrailMap, uid: string): Promise<boolean> {
    const bounds = await trailBounds(uid);
    if (!bounds) return false;

    const [west, south, east, north] = bounds;

    if (west === east && south === north) {
        map.flyTo({ center: [west, south], zoom: Math.max(map.getZoom(), 14) });
    } else {
        map.fitBounds([[west, south], [east, north]], { padding: 60, maxZoom: 17 });
    }

    return true;
}

export function pointsLabel(points: number): string {
    return `${points} ${points === 1 ? 'point' : 'points'}`;
}

/** "03/11/2026 10:02 – 11:05" - the date is only repeated when the trail crosses midnight */
export function spanLabel(first: number, last: number): string {
    const a = new Date(first);
    const b = new Date(last);
    const time = (date: Date) => date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

    if (a.toDateString() === b.toDateString()) {
        return `${a.toLocaleDateString()} ${time(a)} – ${time(b)}`;
    }

    return `${a.toLocaleString()} – ${b.toLocaleString()}`;
}

/** The trail summary line: "123 points · 10:02 – 11:05", or why there are none */
export function summaryLabel(summary: TrailSummary): string {
    if (!summary.points) return summary.live ? 'Recording, waiting for the first position' : 'No points';
    if (summary.first === null || summary.last === null) return pointsLabel(summary.points);
    return `${pointsLabel(summary.points)} · ${spanLabel(summary.first, summary.last)}`;
}

/** The UID of the CoT a history point was reported by, or undefined when the id is not a history point */
export async function historyPointUid(id: string | number | undefined): Promise<string | undefined> {
    if (id === undefined || id === null) return undefined;
    const row = await db.feature_history.get(String(id));
    return row ? row.uid : undefined;
}
