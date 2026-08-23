import test from 'node:test';
import assert from 'node:assert';
import { timezoneAt, localCivilDate, sunTimesAt } from '../stateless/lib/sun.js';

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
