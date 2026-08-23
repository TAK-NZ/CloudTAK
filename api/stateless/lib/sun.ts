import * as SunCalc from 'suncalc';
import type { SunTimes } from 'suncalc';
import tzlookup from 'tz-lookup';

/**
 * Normalise longitude into [-180, 180].
 *
 * Clients that derive coordinates from a map viewport can send longitudes outside
 * that range: MapLibre reports the unwrapped world copy the pointer is over, so
 * panning east across the antimeridian yields values such as 204. `tz-lookup`
 * rejects those as invalid coordinates, which would silently cost us the timezone
 * for a point that is perfectly well defined.
 */
export function wrapLongitude(longitude: number): number {
    if (!Number.isFinite(longitude)) return longitude;

    // Return in-range values untouched. Running them through the modulo below
    // would perturb them by floating point error - 174.7633 comes back as
    // 174.76329999999996 - which is physically irrelevant but would leak into
    // coordinates displayed in the UI and written into URLs.
    if (longitude >= -180 && longitude <= 180) return longitude;

    const wrapped = ((longitude + 180) % 360 + 360) % 360 - 180;

    // The antimeridian is +/-180; prefer +180 over folding to -180.
    return wrapped === -180 ? 180 : wrapped;
}

/**
 * IANA timezone identifier at a coordinate, or null if it can't be resolved.
 *
 * Deliberately returns null instead of throwing or guessing. Callers surface the
 * times as UTC in that case; falling back to the *viewer's* timezone is never an
 * option, because that is precisely the defect this module exists to prevent -
 * sun events for a point in New Zealand rendered as US Pacific wall-clock.
 */
export function timezoneAt(latitude: number, longitude: number): string | null {
    try {
        return tzlookup(latitude, wrapLongitude(longitude)) || null;
    } catch {
        return null;
    }
}

/**
 * Local civil date at `timezone` for the given instant, as [year, month, day].
 *
 * `en-CA` is used because it formats as YYYY-MM-DD, which parses back to numbers
 * unambiguously. Returns null if the zone is not recognised by the runtime.
 */
export function localCivilDate(timezone: string, now: Date): [number, number, number] | null {
    try {
        const parts = new Intl.DateTimeFormat('en-CA', {
            timeZone: timezone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        }).format(now).split('-').map(Number);

        if (parts.length !== 3 || !parts.every(Number.isFinite)) return null;

        return [parts[0], parts[1], parts[2]];
    } catch {
        return null;
    }
}

/**
 * UTC offset of `timeZone` at a given instant, in milliseconds.
 *
 * Derived by formatting the instant into the zone's wall-clock fields and
 * re-reading them as if they were UTC; the difference is the offset. `h23` keeps
 * midnight as hour 0 rather than the 24 that `hour12: false` can yield.
 */
function zoneOffsetMs(timeZone: string, at: Date): number {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    }).formatToParts(at).reduce<Record<string, number>>((acc, part) => {
        if (part.type !== 'literal') acc[part.type] = Number(part.value);
        return acc;
    }, {});

    const asUTC = Date.UTC(
        parts.year, parts.month - 1, parts.day,
        parts.hour, parts.minute, parts.second,
    );

    return asUTC - at.getTime();
}

/**
 * The instant corresponding to local noon on `[year, month, day]` in `timeZone`.
 *
 * The offset is resolved twice because the first lookup uses a provisional
 * instant that may sit on the other side of a DST transition from the real one.
 */
function localNoonInstant(timeZone: string, date: [number, number, number]): Date {
    const naive = Date.UTC(date[0], date[1] - 1, date[2], 12, 0, 0);
    const provisional = naive - zoneOffsetMs(timeZone, new Date(naive));

    return new Date(naive - zoneOffsetMs(timeZone, new Date(provisional)));
}

/**
 * Sun times for the day currently in progress *at the given coordinate*.
 *
 * `SunCalc.getTimes()` selects its solar day from the UTC date of the instant it
 * is handed, so passing `new Date()` returns the wrong day for any location far
 * enough from the prime meridian. At UTC+12 a caller sees yesterday's events for
 * most of the local working day: every event already in the past, and no
 * upcoming sunrise or sunset.
 *
 * We therefore anchor on local noon of the civil date in progress at the
 * coordinate. Noon is chosen deliberately: it sits roughly half a day from either
 * midnight, so neither a DST transition nor rounding can nudge the anchor into
 * the adjacent day.
 *
 * The anchor is built from the zone's actual UTC offset rather than from
 * longitude. Longitude would be wrong either side of the antimeridian, where
 * civil time and mean solar time differ by close to 24 hours - the Chatham
 * Islands sit at 176 degrees West on UTC+12:45, so a longitude-derived anchor
 * lands a day out. Longitude is used only as a fallback when the zone is unknown,
 * where it is still far better than the UTC date.
 */
export function sunTimesAt(
    latitude: number,
    longitude: number,
    altitude: number,
    timezone: string | null,
    now: Date = new Date(),
): SunTimes {
    const lon = wrapLongitude(longitude);
    const date = timezone ? localCivilDate(timezone, now) : null;

    let anchor: Date;

    if (timezone && date) {
        anchor = localNoonInstant(timezone, date);
    } else {
        const solarOffsetMs = (lon / 15) * 3600000;
        const solar = new Date(now.getTime() + solarOffsetMs);

        anchor = new Date(Date.UTC(
            solar.getUTCFullYear(), solar.getUTCMonth(), solar.getUTCDate(), 12, 0, 0,
        ) - solarOffsetMs);
    }

    return SunCalc.getTimes(anchor, latitude, lon, altitude);
}
