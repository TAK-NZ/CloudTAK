import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NO_DATA_TIMEOUT_MS, SETTLE_MS } from './web-compass.ts';
import { setHeadingReference } from './heading-reference.ts';

vi.mock('../../utils/capacitor.ts', () => ({
    isNativePlatform: () => false
}));

vi.mock('@capgo/capacitor-compass', () => ({
    CapgoCompass: {}
}));

import { OrientationPermission } from './orientation.ts';

type Props = Record<string, unknown>;

function fire(type: string, props: Props = {}): void {
    const event = new Event(type);
    Object.assign(event, props);
    window.dispatchEvent(event);
}

// Flat phone whose top edge points at heading H has alpha = 360 - H
const relative = (alpha: number): void => fire('deviceorientation', { alpha, beta: 0, gamma: 0, absolute: false });
const absolute = (alpha: number): void => fire('deviceorientationabsolute', { alpha, beta: 0, gamma: 0, absolute: true });

const win = window as unknown as Record<string, unknown>;

function setVisibility(state: 'visible' | 'hidden'): void {
    Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
}

describe('OrientationPermission web compass', () => {
    const permission = new OrientationPermission({
        setPermissionStatus: vi.fn()
    } as unknown as ConstructorParameters<typeof OrientationPermission>[0]);
    let headings: Array<number | null>;
    let stop: (() => Promise<void>) | undefined;
    let location: { lat: number; lng: number } | null;

    async function start() {
        stop = await permission.addListener((heading) => {
            headings.push(heading);
        }, { getLocation: () => location });
    }

    beforeEach(() => {
        vi.useFakeTimers();
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        headings = [];
        location = null;
        win.ondeviceorientationabsolute = null;
        setHeadingReference('true');
    });

    afterEach(async () => {
        await stop?.();
        stop = undefined;
        delete win.ondeviceorientationabsolute;
        delete win.DeviceOrientationEvent;
        setVisibility('visible');
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('ignores the relative deviceorientation stream', async () => {
        await start();
        relative(260);
        relative(170);
        expect(headings).toEqual([]);
    });

    it('uses deviceorientationabsolute and ignores relative events next to it', async () => {
        await start();
        relative(170);
        absolute(260);
        relative(0);
        expect(headings).toHaveLength(1);
        expect(headings[0]).toBeCloseTo(100, 0);
    });

    it('does not select the relative event just because requestPermission exists', async () => {
        win.DeviceOrientationEvent = { prototype: {}, requestPermission: vi.fn() };
        expect(permission.hasPermissionRequest()).toBe(true);

        await start();
        // Relative offset by 90 degrees from the real heading of 100
        relative(170);
        absolute(260);
        expect(headings).toHaveLength(1);
        expect(headings[0]).toBeCloseTo(100, 0);
    });

    it('accepts deviceorientation events that report absolute === true', async () => {
        await start();
        fire('deviceorientation', { alpha: 260, beta: 0, gamma: 0, absolute: true });
        expect(headings).toHaveLength(1);
        expect(headings[0]).toBeCloseTo(100, 0);
    });

    it('does not double up when the absolute event and an absolute deviceorientation both fire', async () => {
        await start();
        absolute(260);
        fire('deviceorientation', { alpha: 260, beta: 0, gamma: 0, absolute: true });
        expect(headings).toHaveLength(1);
    });

    it('emits null for alpha null and for degenerate poses', async () => {
        await start();
        fire('deviceorientationabsolute', { alpha: null, beta: null, gamma: null, absolute: true });
        // Screen facing down: the back camera points at the sky
        fire('deviceorientationabsolute', { alpha: 260, beta: 180, gamma: 0, absolute: true });
        expect(headings).toEqual([null, null]);
    });

    it('takes screen.orientation.angle into account', async () => {
        // jsdom has no screen.orientation
        Object.defineProperty(screen, 'orientation', { value: { angle: 90 }, configurable: true });
        try {
            await start();
            // Flat, landscape: screen top is device +x, which points at 100 when alpha = 350
            absolute(350);
            expect(headings[0]).toBeCloseTo(100, 0);
        } finally {
            delete (screen as unknown as Record<string, unknown>).orientation;
        }
    });

    it('still uses the numeric iOS webkitCompassHeading and ignores alpha-only events after it', async () => {
        win.DeviceOrientationEvent = { prototype: {}, requestPermission: vi.fn() };
        await start();
        fire('deviceorientation', { alpha: 10, beta: 0, gamma: 0, absolute: false, webkitCompassHeading: 123 });
        expect(headings).toEqual([123]);

        // iOS flat: compass heading null, relative alpha must not be shown
        fire('deviceorientation', { alpha: 10, beta: 0, gamma: 0, absolute: false, webkitCompassHeading: null });
        fire('deviceorientationabsolute', { alpha: 10, beta: 0, gamma: 0, absolute: true });
        expect(headings).toEqual([123]);
    });

    it('does not apply declination to iOS webkitCompassHeading', async () => {
        location = { lat: 37.773452, lng: -122.396341 };
        await start();
        fire('deviceorientation', { alpha: 0, beta: 0, gamma: 0, absolute: false, webkitCompassHeading: 50 });
        expect(headings).toEqual([50]);
    });

    describe('north reference', () => {
        it('converts Android magnetic heading to true north when a location is known', async () => {
            location = { lat: 37.773452, lng: -122.396341 };
            await start();
            absolute(260);
            // Declination at SF is about +12.8 degrees east
            expect(headings[0]).toBeGreaterThan(112.3);
            expect(headings[0]).toBeLessThan(113.3);
        });

        it('stays magnetic without a location', async () => {
            await start();
            absolute(260);
            expect(headings[0]).toBeCloseTo(100, 0);
        });

        it('stays magnetic when the user chose magnetic north', async () => {
            location = { lat: 37.773452, lng: -122.396341 };
            setHeadingReference('magnetic');
            await start();
            absolute(260);
            expect(headings[0]).toBeCloseTo(100, 0);
        });
    });

    describe('resume handling', () => {
        it('discards the first samples after visibilitychange to visible, keeping the last heading', async () => {
            await start();
            absolute(260);
            expect(headings).toHaveLength(1);

            setVisibility('hidden');
            setVisibility('visible');

            // Two events inside the settle window are dropped
            absolute(170);
            absolute(170);
            expect(headings).toHaveLength(1);

            // Enough events but still inside the time window: still dropped
            absolute(170);
            expect(headings).toHaveLength(1);

            vi.advanceTimersByTime(SETTLE_MS + 1);
            absolute(260);
            expect(headings).toHaveLength(2);
            expect(headings[1]).toBeCloseTo(100, 0);
        });

        it('waits for two events even after the time window has passed', async () => {
            await start();
            setVisibility('visible');
            vi.advanceTimersByTime(SETTLE_MS * 3);

            absolute(170);
            absolute(170);
            expect(headings).toEqual([]);
            absolute(260);
            expect(headings).toHaveLength(1);
        });

        it('does not settle when the page goes hidden', async () => {
            await start();
            setVisibility('hidden');
            absolute(260);
            expect(headings).toHaveLength(1);
        });

        it('re-registers listeners and settles on pageshow with persisted', async () => {
            await start();
            absolute(260);
            expect(headings).toHaveLength(1);

            const pageshow = new Event('pageshow');
            Object.assign(pageshow, { persisted: true });
            window.dispatchEvent(pageshow);

            // Still delivers once (exactly one listener), after the settle window
            absolute(170);
            absolute(170);
            vi.advanceTimersByTime(SETTLE_MS + 1);
            absolute(260);
            expect(headings).toHaveLength(2);
        });

        it('ignores pageshow that is not from the back/forward cache', async () => {
            await start();
            const pageshow = new Event('pageshow');
            Object.assign(pageshow, { persisted: false });
            window.dispatchEvent(pageshow);
            absolute(260);
            expect(headings).toHaveLength(1);
        });
    });

    describe('no data timeout', () => {
        it('emits null and warns once when only relative events arrive', async () => {
            await start();
            relative(170);
            vi.advanceTimersByTime(NO_DATA_TIMEOUT_MS + 1);
            expect(headings).toEqual([null]);
            expect(console.warn).toHaveBeenCalledTimes(1);
        });

        it('emits null when no event arrives at all', async () => {
            await start();
            vi.advanceTimersByTime(NO_DATA_TIMEOUT_MS + 1);
            expect(headings).toEqual([null]);
        });

        it('does not fire once an absolute event has arrived', async () => {
            await start();
            absolute(260);
            vi.advanceTimersByTime(NO_DATA_TIMEOUT_MS * 2);
            expect(headings).toHaveLength(1);
            expect(console.warn).not.toHaveBeenCalled();
        });
    });

    it('stops listening when the cleanup function is called', async () => {
        await start();
        await stop?.();
        stop = undefined;
        absolute(260);
        vi.advanceTimersByTime(NO_DATA_TIMEOUT_MS * 2);
        expect(headings).toEqual([]);
    });
});

describe('OrientationPermission permission status', () => {
    afterEach(() => {
        delete win.DeviceOrientationEvent;
        delete win.ondeviceorientation;
        vi.restoreAllMocks();
    });

    function make() {
        const setPermissionStatus = vi.fn();
        const permission = new OrientationPermission({ setPermissionStatus } as unknown as ConstructorParameters<typeof OrientationPermission>[0]);
        return { permission, setPermissionStatus };
    }

    it('keeps prompting on iOS-style browsers without the permissions API', async () => {
        win.DeviceOrientationEvent = { prototype: {}, requestPermission: vi.fn() };
        win.ondeviceorientation = null;
        vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1');
        const { permission, setPermissionStatus } = make();
        await permission.refreshStatus();
        expect(setPermissionStatus).toHaveBeenCalledWith('orientation', 'prompt');
    });

    it('does not nag on Chrome 151+ where requestPermission is a no-op', async () => {
        win.DeviceOrientationEvent = { prototype: {}, requestPermission: vi.fn() };
        win.ondeviceorientation = null;
        vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36');
        const { permission, setPermissionStatus } = make();
        await permission.refreshStatus();
        expect(setPermissionStatus).toHaveBeenCalledWith('orientation', 'granted');
    });

    it('calls requestPermission from request() and reports its result', async () => {
        const requestPermission = vi.fn().mockResolvedValue('granted');
        win.DeviceOrientationEvent = { prototype: {}, requestPermission };
        win.ondeviceorientation = null;
        const { permission, setPermissionStatus } = make();
        await permission.request();
        expect(requestPermission).toHaveBeenCalledTimes(1);
        expect(setPermissionStatus).toHaveBeenCalledWith('orientation', 'granted');
    });
});
