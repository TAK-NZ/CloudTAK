import { headingFromEuler } from './heading.ts';
import { DeclinationCache, magneticToTrue } from './declination.ts';
import type { LatLng } from './declination.ts';
import { getHeadingReference } from './heading-reference.ts';

type DeviceOrientationEventWithCompass = DeviceOrientationEvent & {
    webkitCompassHeading?: number | null;
};

export interface WebCompassOptions {
    /** Current device location, used for the magnetic declination (true north). */
    getLocation?: () => LatLng | null;
    /** Window to listen on; defaults to the global window. */
    target?: Window & typeof globalThis;
}

/** Events discarded after the page becomes visible again (sensor restart). */
export const SETTLE_EVENTS = 2;
/** ...or for this long, whichever is longer. */
export const SETTLE_MS = 300;
/** Give up waiting for an absolute/compass event after this long. */
export const NO_DATA_TIMEOUT_MS = 3000;

/**
 * Web compass heading from DeviceOrientation events.
 *
 * Only heading sources with a north reference are used:
 * - `webkitCompassHeading` (iOS, already true north)
 * - `deviceorientationabsolute` (Android Chrome, magnetic north)
 * - `deviceorientation` events that report `absolute === true`
 *
 * A plain `deviceorientation` event on Android Chrome is the relative
 * game-rotation-vector stream: its yaw has an arbitrary reference that resets
 * whenever the sensor restarts (page start and every resume), so it is ignored.
 * The source is chosen by what the events carry, not by whether
 * `DeviceOrientationEvent.requestPermission` exists (Chrome 151+ has it too).
 *
 * Returns a function that stops listening.
 */
export function startWebCompass(
    callback: (heading: number | null) => void,
    options: WebCompassOptions = {}
): () => void {
    const win = options.target ?? window;
    const doc = win.document;
    const declination = new DeclinationCache();

    // WebKit exposes webkitCompassHeading on the event prototype. Its
    // deviceorientationabsolute event fires unreliably, so stick to the compass there.
    const DeviceOrientation = (win as unknown as { DeviceOrientationEvent?: { prototype: object } }).DeviceOrientationEvent;
    let iosMode = !!DeviceOrientation && 'webkitCompassHeading' in DeviceOrientation.prototype;
    let sawAbsoluteEvent = false;
    let gotData = false;
    let warned = false;
    let settleEvents = 0;
    let settleUntil = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const hasAbsoluteEvent = !iosMode && 'ondeviceorientationabsolute' in win;

    function armTimeout(): void {
        clearTimeout(timer);
        gotData = false;
        timer = setTimeout(() => {
            if (gotData) return;
            if (!warned) {
                warned = true;
                console.warn('No absolute device orientation data received; compass heading unavailable');
            }
            callback(null);
        }, NO_DATA_TIMEOUT_MS);
    }

    function settle(): void {
        settleEvents = SETTLE_EVENTS;
        settleUntil = Date.now() + SETTLE_MS;
    }

    function onEvent(event: Event): void {
        const orientation = event as DeviceOrientationEventWithCompass;
        const compass = orientation.webkitCompassHeading;

        let fromCompass = false;
        if (typeof compass === 'number' && Number.isFinite(compass)) {
            iosMode = true;
            fromCompass = true;
        } else if (iosMode) {
            // iOS without a compass fix (e.g. flat): alpha is relative, never use it
            return;
        } else if (event.type === 'deviceorientationabsolute') {
            sawAbsoluteEvent = true;
        } else if (orientation.absolute !== true || sawAbsoluteEvent) {
            // Relative stream, or a duplicate of the dedicated absolute event
            return;
        }

        gotData = true;
        clearTimeout(timer);

        if (settleEvents > 0 || Date.now() < settleUntil) {
            if (settleEvents > 0) settleEvents--;
            return;
        }

        if (fromCompass) {
            callback(compass as number);
            return;
        }

        let heading = headingFromEuler(
            orientation.alpha,
            orientation.beta,
            orientation.gamma,
            win.screen?.orientation?.angle ?? 0
        );

        // Android Chrome reports magnetic north; convert unless the user prefers it
        if (heading !== null && getHeadingReference() === 'true') {
            const decl = declination.get(options.getLocation?.() ?? null);
            if (decl !== null) heading = magneticToTrue(heading, decl);
        }

        callback(heading);
    }

    function register(): void {
        win.addEventListener('deviceorientation', onEvent);
        if (hasAbsoluteEvent) win.addEventListener('deviceorientationabsolute', onEvent);
    }

    function unregister(): void {
        win.removeEventListener('deviceorientation', onEvent);
        win.removeEventListener('deviceorientationabsolute', onEvent);
    }

    function onVisibilityChange(): void {
        if (doc.visibilityState === 'visible') settle();
    }

    function onPageShow(event: PageTransitionEvent): void {
        if (!event.persisted) return;
        // Restored from the back/forward cache: listeners may have been dropped
        unregister();
        register();
        settle();
        armTimeout();
    }

    register();
    doc.addEventListener('visibilitychange', onVisibilityChange);
    win.addEventListener('pageshow', onPageShow);
    armTimeout();

    return () => {
        clearTimeout(timer);
        unregister();
        doc.removeEventListener('visibilitychange', onVisibilityChange);
        win.removeEventListener('pageshow', onPageShow);
    };
}
