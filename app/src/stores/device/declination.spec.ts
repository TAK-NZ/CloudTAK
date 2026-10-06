import { describe, expect, it } from 'vitest';
import { DeclinationCache, magneticDeclination, magneticToTrue } from './declination.ts';

const DATE = new Date('2026-10-01T00:00:00Z');

describe('magneticDeclination', () => {
    it('is about +12.8 degrees east in San Francisco', () => {
        const decl = magneticDeclination(37.773452, -122.396341, DATE) as number;
        expect(decl).toBeGreaterThan(12.3);
        expect(decl).toBeLessThan(13.3);
    });

    it('is about +23 degrees east in Wellington', () => {
        const decl = magneticDeclination(-41.2865, 174.7762, DATE) as number;
        expect(decl).toBeGreaterThan(22.5);
        expect(decl).toBeLessThan(24);
    });

    it('is negative (west) on the US east coast', () => {
        expect(magneticDeclination(40.7128, -74.006, DATE) as number).toBeLessThan(-10);
    });

    it('returns null for invalid coordinates', () => {
        expect(magneticDeclination(Number.NaN, 0, DATE)).toBeNull();
        expect(magneticDeclination(95, 0, DATE)).toBeNull();
        expect(magneticDeclination(0, 200, DATE)).toBeNull();
    });
});

describe('magneticToTrue', () => {
    it('adds the declination and wraps to 0-360', () => {
        expect(magneticToTrue(344, 12.8)).toBeCloseTo(356.8, 5);
        expect(magneticToTrue(350, 23)).toBeCloseTo(13, 5);
        expect(magneticToTrue(5, -10)).toBeCloseTo(355, 5);
    });
});

describe('DeclinationCache', () => {
    const sf = { lat: 37.773452, lng: -122.396341 };

    it('returns null without a location', () => {
        expect(new DeclinationCache().get(null)).toBeNull();
    });

    it('reuses the value for a minute and small moves, then recomputes', () => {
        const cache = new DeclinationCache();
        const t0 = DATE.getTime();
        const first = cache.get(sf, t0) as number;
        expect(first).toBeGreaterThan(12);

        // Small move inside the minute: cached (value identical)
        expect(cache.get({ lat: sf.lat + 0.01, lng: sf.lng }, t0 + 30_000)).toBe(first);

        // Moving to Wellington recomputes even inside the minute
        const wellington = cache.get({ lat: -41.2865, lng: 174.7762 }, t0 + 40_000) as number;
        expect(wellington).toBeGreaterThan(22);

        // After a minute the same position is recomputed (still the same value)
        expect(cache.get({ lat: -41.2865, lng: 174.7762 }, t0 + 120_000)).toBeCloseTo(wellington, 1);
    });
});
