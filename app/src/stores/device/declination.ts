import geomagnetism from 'geomagnetism';

export interface LatLng { lat: number; lng: number }

/**
 * Magnetic declination in degrees (positive = magnetic north is east of true
 * north) from the World Magnetic Model, or `null` if it cannot be computed.
 */
export function magneticDeclination(lat: number, lng: number, date: Date = new Date()): number | null {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;

    try {
        const decl = geomagnetism.model(date).point([lat, lng]).decl;
        return Number.isFinite(decl) ? decl : null;
    } catch {
        return null;
    }
}

/** Convert a magnetic heading to true north (0-360). */
export function magneticToTrue(heading: number, declination: number): number {
    return (((heading + declination) % 360) + 360) % 360;
}

const MAX_AGE_MS = 60_000;
// ~5 km; declination changes by well under 0.1 degrees over that distance
const MAX_MOVE_DEG = 0.05;

/**
 * Caches the declination so it is not recomputed for every sensor event:
 * refreshed once a minute or when the position moves more than a few km.
 */
export class DeclinationCache {
    private at = 0;
    private from: LatLng | null = null;
    private value: number | null = null;

    get(location: LatLng | null, now: number = Date.now()): number | null {
        if (!location) return null;

        const fresh = this.from !== null
            && now - this.at < MAX_AGE_MS
            && Math.abs(location.lat - this.from.lat) <= MAX_MOVE_DEG
            && Math.abs(location.lng - this.from.lng) <= MAX_MOVE_DEG;

        if (!fresh) {
            this.value = magneticDeclination(location.lat, location.lng, new Date(now));
            this.at = now;
            this.from = { lat: location.lat, lng: location.lng };
        }

        return this.value;
    }
}
