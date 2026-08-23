import test from 'node:test';
import assert from 'node:assert';
import { timezoneAt, localCivilDate, sunTimesAt, wrapLongitude } from '../stateless/lib/sun.js';

/**
 * suncalc types every event as `Date | null`, since events such as sunrise do not
 * occur on some days at high latitudes. None of the points exercised here are
 * polar, so assert the value is real and narrow it.
 */
function must(date: Date | null, label: string): Date {
    assert.ok(
        date instanceof Date && !Number.isNaN(date.getTime()),
        `${label} should be a valid Date`,
    );
    return date;
}

/**
 * Render an instant as HH:MM in a given zone, the way the Sun Phase panel does.
 */
function hhmm(date: Date | null, timeZone: string): string {
    return new Intl.DateTimeFormat('en-NZ', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone,
    }).format(must(date, 'time'));
}

/** Local calendar date (YYYY-MM-DD) of an instant in a given zone. */
function ymd(date: Date | null, timeZone: string): string {
    return new Intl.DateTimeFormat('en-CA', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        timeZone,
    }).format(must(date, 'date'));
}

// The originally reported scenario: an operator on US Pacific time at 16:36 on
// 2026-08-22 (= 2026-08-22T23:36Z) querying a point in the South Island of New
// Zealand, where the local date is already 2026-08-23.
const REPORTED_NOW = new Date('2026-08-22T23:36:00Z');
const NZ_LAT = -43.48239455544271;
const NZ_LON = 169.9446811687917;

test('timezoneAt - resolves New Zealand mainland and the Chatham Islands', () => {
    assert.equal(timezoneAt(NZ_LAT, NZ_LON), 'Pacific/Auckland');
    assert.equal(timezoneAt(-36.8485, 174.7633), 'Pacific/Auckland');
    assert.equal(timezoneAt(-46.4132, 168.3538), 'Pacific/Auckland');

    // Chatham is the case a coarse lookup gets wrong, and it is UTC+12:45 - a
    // whole-hour offset assumption would be 45 minutes out.
    assert.equal(timezoneAt(-43.9535, -176.5597), 'Pacific/Chatham');
});

test('timezoneAt - returns null rather than throwing on invalid input', () => {
    assert.equal(timezoneAt(NaN, NaN), null);
    assert.equal(timezoneAt(999, 999), null);
});

test('localCivilDate - uses the location zone, not the host zone', () => {
    // Same instant, two zones, two different calendar dates.
    assert.deepEqual(localCivilDate('Pacific/Auckland', REPORTED_NOW), [2026, 8, 23]);
    assert.deepEqual(localCivilDate('America/Los_Angeles', REPORTED_NOW), [2026, 8, 22]);
    assert.equal(localCivilDate('Not/AZone', REPORTED_NOW), null);
});

test('sunTimesAt - returns the local day at the point, not the UTC day', () => {
    const zone = timezoneAt(NZ_LAT, NZ_LON)!;
    const sun = sunTimesAt(NZ_LAT, NZ_LON, 0, zone, REPORTED_NOW);

    // Regression: the events must belong to the local day in progress at the
    // point (2026-08-23), not the UTC day of the caller's clock (2026-08-22),
    // which is what produced a panel full of "yesterday" events.
    assert.equal(ymd(sun.sunrise, zone), '2026-08-23', 'sunrise is on the local day');
    assert.equal(ymd(sun.sunset, zone), '2026-08-23', 'sunset is on the local day');
    assert.equal(ymd(sun.solarNoon, zone), '2026-08-23', 'solar noon is on the local day');
});

test('sunTimesAt - sunset is still ahead of an operator querying at local midday', () => {
    const zone = timezoneAt(NZ_LAT, NZ_LON)!;
    const sun = sunTimesAt(NZ_LAT, NZ_LON, 0, zone, REPORTED_NOW);

    const sunset = must(sun.sunset, 'sunset');
    const sunrise = must(sun.sunrise, 'sunrise');

    // Local time at the point was 11:36, so sunset must be in the future.
    // Before the fix every event was in the past.
    assert.ok(
        sunset.getTime() > REPORTED_NOW.getTime(),
        `sunset ${sunset.toISOString()} should be after ${REPORTED_NOW.toISOString()}`,
    );
    assert.ok(
        sunrise.getTime() < REPORTED_NOW.getTime(),
        'sunrise should already have happened at 11:36 local',
    );
});

test('sunTimesAt - rendered in the location zone, not the viewer zone', () => {
    const zone = timezoneAt(NZ_LAT, NZ_LON)!;
    const sun = sunTimesAt(NZ_LAT, NZ_LON, 0, zone, REPORTED_NOW);

    // Plausible late-winter times for the South Island. The bug rendered these
    // as 12:23 / 17:42 / 23:03 because it used the viewer's US Pacific zone.
    assert.equal(hhmm(sun.sunrise, zone), '07:23');
    assert.equal(hhmm(sun.solarNoon, zone), '12:42');
    assert.equal(hhmm(sun.sunset, zone), '18:03');

    // ...and they must not be the US Pacific renderings that the bug produced.
    assert.notEqual(hhmm(sun.sunrise, zone), hhmm(sun.sunrise, 'America/Los_Angeles'));
});

test('sunTimesAt - falls back to the longitude-derived solar day without a zone', () => {
    // With timezone null (lookup failed) the day must still be the local one,
    // derived from longitude, rather than the caller's UTC day.
    const sun = sunTimesAt(NZ_LAT, NZ_LON, 0, null, REPORTED_NOW);

    assert.equal(ymd(sun.sunrise, 'Pacific/Auckland'), '2026-08-23');
    assert.ok(must(sun.sunset, 'sunset').getTime() > REPORTED_NOW.getTime());
});

test('sunTimesAt - stable across a DST transition at the queried location', () => {
    const zone = 'Pacific/Auckland';

    // NZDT ends 2026-04-05. Query from a UTC instant that falls on the previous
    // UTC day to make sure the anchor does not slip a day either side.
    for (const instant of ['2026-04-04T13:30:00Z', '2026-04-05T13:30:00Z']) {
        const now = new Date(instant);
        const expected = ymd(now, zone);
        const sun = sunTimesAt(-41.2866, 174.7756, 0, zone, now);

        assert.equal(
            ymd(sun.solarNoon, zone),
            expected,
            `solar noon should be on local day ${expected} for ${instant}`,
        );
    }
});

test('sunTimesAt - Chatham Islands resolve to their own +12:45 day', () => {
    const zone = timezoneAt(-43.9535, -176.5597)!;
    const now = new Date('2026-08-22T23:36:00Z');
    const sun = sunTimesAt(-43.9535, -176.5597, 0, zone, now);

    assert.equal(zone, 'Pacific/Chatham');
    assert.equal(ymd(sun.solarNoon, zone), ymd(now, zone));
});

// --- Antimeridian handling -------------------------------------------------
//
// MapLibre reports coordinates in whichever unwrapped world copy the pointer is
// over, so panning east across the antimeridian produces longitudes outside
// [-180, 180]. New Zealand sits on the antimeridian, so this is routine here.
// `tz-lookup` rejects such values as invalid coordinates, which previously cost
// us the timezone for a perfectly well defined point.

test('wrapLongitude - normalises into [-180, 180]', () => {
    // The longitude from the reported crash.
    assert.equal(wrapLongitude(204.08162859110183).toFixed(5), '-155.91837');

    // Chatham reached by panning east.
    assert.equal(wrapLongitude(-176.5597 + 360).toFixed(4), '-176.5597');

    // Already in range: untouched.
    assert.equal(wrapLongitude(174.7633), 174.7633);
    assert.equal(wrapLongitude(-176.5597), -176.5597);
    assert.equal(wrapLongitude(0), 0);

    // Antimeridian itself keeps its sign rather than folding.
    assert.equal(wrapLongitude(180), 180);
    assert.equal(wrapLongitude(-180), -180);

    // Multiple revolutions, both directions.
    assert.equal(wrapLongitude(174.7633 + 720).toFixed(4), '174.7633');
    assert.equal(wrapLongitude(-190), 170);

    // Non-finite input passes through for the caller to reject.
    assert.ok(Number.isNaN(wrapLongitude(NaN)));
});

test('timezoneAt - resolves an unwrapped longitude instead of giving up', () => {
    // Regression: this returned null, the API then emitted an empty timezone and
    // the Query panel threw `RangeError: Invalid time zone specified:`.
    const zone = timezoneAt(-39.89024591091161, 204.08162859110183);

    assert.notEqual(zone, null);
    assert.equal(zone, timezoneAt(-39.89024591091161, 204.08162859110183 - 360));
});

test('timezoneAt - Chatham resolves whether reached east or west', () => {
    assert.equal(timezoneAt(-43.9535, -176.5597), 'Pacific/Chatham');
    assert.equal(timezoneAt(-43.9535, -176.5597 + 360), 'Pacific/Chatham');
});

test('sunTimesAt - unwrapped longitude gives the same result as normalised', () => {
    const zone = timezoneAt(NZ_LAT, NZ_LON);
    if (zone === null) throw new Error('expected a zone for the query point');

    const normalised = sunTimesAt(NZ_LAT, NZ_LON, 0, zone, REPORTED_NOW);
    const unwrapped = sunTimesAt(NZ_LAT, NZ_LON + 360, 0, zone, REPORTED_NOW);

    assert.equal(
        must(unwrapped.sunrise, 'sunrise').getTime(),
        must(normalised.sunrise, 'sunrise').getTime(),
    );
    assert.equal(
        must(unwrapped.sunset, 'sunset').getTime(),
        must(normalised.sunset, 'sunset').getTime(),
    );
});

test('sunTimesAt - unwrapped longitude still works with no timezone', () => {
    // The longitude fallback path must normalise too, or the solar offset is
    // computed from a longitude of 534 and lands on the wrong day entirely.
    const normalised = sunTimesAt(NZ_LAT, NZ_LON, 0, null, REPORTED_NOW);
    const unwrapped = sunTimesAt(NZ_LAT, NZ_LON + 360, 0, null, REPORTED_NOW);

    assert.equal(
        must(unwrapped.solarNoon, 'solarNoon').getTime(),
        must(normalised.solarNoon, 'solarNoon').getTime(),
    );
});

test('every zone tz-lookup returns around New Zealand is usable by Intl', () => {
    // The crash was ultimately an unusable timezone string reaching
    // Intl.DateTimeFormat. Sweep the NZ area of responsibility, including ocean
    // and the Chathams, and assert every resolved zone can actually format.
    const zones = new Set<string>();

    for (let lat = -50; lat <= -30; lat += 0.5) {
        for (let lon = 160; lon <= 200; lon += 0.5) {
            const zone = timezoneAt(lat, lon);
            if (zone !== null) zones.add(zone);
        }
    }

    assert.ok(zones.size > 0, 'expected at least one zone across the region');
    assert.ok(zones.has('Pacific/Auckland'));
    assert.ok(zones.has('Pacific/Chatham'));

    for (const zone of zones) {
        assert.doesNotThrow(
            () => new Intl.DateTimeFormat('en-NZ', { timeZone: zone, hour: '2-digit' }),
            `zone ${zone} should be usable by Intl.DateTimeFormat`,
        );
        assert.ok(zone.trim() !== '', 'zone should never be blank');
    }
});
