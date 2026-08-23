import { describe, expect, it } from 'vitest';
import { COORD_MODES, formatCoordPair, parseCoordPair, validateCoordPair, wrapLongitude } from './coordinateFormat.ts';

describe('coordinateFormat', () => {
    const lat = 39.739236;
    const lng = -104.990251;

    it('supports all configured coordinate modes', () => {
        expect(COORD_MODES.map((mode) => mode.value)).toEqual(['dd', 'dm', 'dms', 'mgrs', 'utm']);
    });

    it.each(COORD_MODES.map((mode) => mode.value))('round-trips %s coordinates', (mode) => {
        const formatted = formatCoordPair(lat, lng, mode);
        const parsed = parseCoordPair(formatted, mode);

        expect(parsed[0]).toBeCloseTo(lat, mode === 'mgrs' ? 3 : 4);
        expect(parsed[1]).toBeCloseTo(lng, mode === 'mgrs' ? 3 : 4);
        expect(validateCoordPair(formatted, mode)).toBe('');
    });

    it('parses signed decimal coordinate pairs', () => {
        expect(parseCoordPair('39.135606, -110.0', 'dd')).toEqual([39.135606, -110]);
        expect(validateCoordPair('39.135606, -110.0', 'dd')).toBe('');
    });
});

describe('wrapLongitude', () => {
    it('leaves in-range longitudes exactly untouched', () => {
        // Exact equality, not toBeCloseTo: the modulo arithmetic used for
        // out-of-range values perturbs these by floating point error, and the
        // result is displayed in the UI and written back into the URL.
        expect(wrapLongitude(174.7633)).toBe(174.7633);
        expect(wrapLongitude(-176.5597)).toBe(-176.5597);
        expect(wrapLongitude(0)).toBe(0);
        expect(wrapLongitude(180)).toBe(180);
        expect(wrapLongitude(-180)).toBe(-180);
    });

    it('normalises longitudes from east of the antimeridian', () => {
        // The value from the reported Query panel crash: MapLibre reported a
        // click near the Chathams as longitude 204 after panning east.
        expect(wrapLongitude(204.08162859110183)).toBeCloseTo(-155.91837140889817, 10);

        // Chatham Islands reached by panning east rather than west.
        expect(wrapLongitude(-176.5597 + 360)).toBeCloseTo(-176.5597, 10);

        // Auckland, two world copies east.
        expect(wrapLongitude(174.7633 + 720)).toBeCloseTo(174.7633, 10);
    });

    it('normalises longitudes from west of the antimeridian', () => {
        expect(wrapLongitude(-190)).toBe(170);
        expect(wrapLongitude(-360)).toBe(0);
    });

    it('passes non-finite values through for the caller to reject', () => {
        expect(wrapLongitude(NaN)).toBeNaN();
        expect(wrapLongitude(Infinity)).toBe(Infinity);
    });
});
