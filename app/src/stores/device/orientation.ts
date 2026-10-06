import { CapgoCompass } from '@capgo/capacitor-compass';
import { isNativePlatform } from '../../utils/capacitor.ts';
import { PermissionQuery, normalizePermissionState } from './shared.ts';
import type { DevicePermissionContext } from './types.ts';
import { startWebCompass } from './web-compass.ts';
import type { LatLng } from './declination.ts';

type DeviceOrientationEventWithPermission = typeof DeviceOrientationEvent & {
    requestPermission?: () => Promise<PermissionState>;
};

export interface OrientationListenerOptions {
    /** Current device location; lets the web compass convert magnetic to true north. */
    getLocation?: () => LatLng | null;
}

export class OrientationPermission {
    constructor(private readonly context: DevicePermissionContext) {}

    hasSupport(): boolean {
        if (isNativePlatform()) return true;

        return 'DeviceOrientationEvent' in window && (
            'ondeviceorientation' in window
            || 'ondeviceorientationabsolute' in (window as unknown as Record<string, unknown>)
        );
    }

    hasPermissionRequest(): boolean {
        if (isNativePlatform()) return false;
        if (!('DeviceOrientationEvent' in window)) return false;

        const orientationEvent = window.DeviceOrientationEvent as DeviceOrientationEventWithPermission;
        return typeof orientationEvent.requestPermission === 'function';
    }

    /**
     * Register a listener that fires with the compass heading (degrees clockwise
     * from north, 0–360) whenever the device orientation changes.
     *
     * North reference: on native the @capgo/capacitor-compass plugin value is
     * passed through as reported (true north on iOS; the Android plugin reports
     * magnetic north and is not yet corrected). On web the heading is true north
     * by default (magnetic declination applied when a location is available) or
     * magnetic north if the user chose so; iOS `webkitCompassHeading` is already
     * true north and is passed through.
     *
     * Returns an async cleanup function — call it to stop listening.
     */
    async addListener(
        callback: (heading: number | null) => void,
        options: OrientationListenerOptions = {}
    ): Promise<() => Promise<void>> {
        if (isNativePlatform()) {
            const handle = await CapgoCompass.addListener('headingChange', (event) => {
                callback(event.value);
            });
            await CapgoCompass.startListening();
            return async () => {
                try { await CapgoCompass.stopListening(); } catch { /* ignore */ }
                try { await handle.remove(); } catch { /* ignore */ }
            };
        }

        // Web fallback — DeviceOrientationEvent (see web-compass.ts)
        const stop = startWebCompass(callback, { getLocation: options.getLocation });
        return async () => {
            stop();
        };
    }

    async refreshStatus(): Promise<void> {
        if (isNativePlatform()) {
            try {
                const status = await CapgoCompass.checkPermissions();
                this.context.setPermissionStatus('orientation', normalizePermissionState(status.compass));
            } catch (err) {
                console.warn('Failed to check compass permission', err);
                this.context.setPermissionStatus('orientation', 'unknown');
            }
            return;
        }

        // Web fallback
        if (!this.hasSupport()) {
            this.context.setPermissionStatus('orientation', 'unsupported');
            return;
        }

        if (PermissionQuery.hasPermissionQuery()) {
            const sensorPermissions = ['accelerometer', 'gyroscope', 'magnetometer'];
            try {
                const results = await Promise.allSettled(sensorPermissions.map(async (name) => {
                    const status = await navigator.permissions.query({ name } as PermissionDescriptor);
                    return status.state;
                }));
                const states = results
                    .filter((result): result is PromiseFulfilledResult<PermissionState> => result.status === 'fulfilled')
                    .map((result) => result.value);

                if (states.includes('denied')) {
                    this.context.setPermissionStatus('orientation', 'denied');
                    return;
                }
                if (states.length === sensorPermissions.length && states.every((state) => state === 'granted')) {
                    this.context.setPermissionStatus('orientation', 'granted');
                    return;
                }
                if (states.includes('prompt')) {
                    this.context.setPermissionStatus('orientation', 'prompt');
                    return;
                }
            } catch (err) {
                console.warn('Failed to query orientation permission status', err);
            }
        }

        // iOS needs a user gesture. Chromium 151+ also exposes requestPermission, but
        // it is a no-op while the sensor permission defaults to allowed; if that
        // default changes, the permissions.query branch above reports 'prompt'.
        if (this.hasPermissionRequest() && !this.isChromium()) {
            this.context.setPermissionStatus('orientation', 'prompt');
        } else {
            this.context.setPermissionStatus('orientation', 'granted');
        }
    }

    async request(): Promise<void> {
        if (isNativePlatform()) {
            try {
                const status = await CapgoCompass.requestPermissions();
                this.context.setPermissionStatus('orientation', normalizePermissionState(status.compass));
            } catch (err) {
                console.warn('Failed to request compass permission', err);
            } finally {
                await this.refreshStatus();
            }
            return;
        }

        // Web fallback
        if (!this.hasSupport()) {
            this.context.setPermissionStatus('orientation', 'unsupported');
            return;
        }

        try {
            if (this.hasPermissionRequest()) {
                const orientationEvent = window.DeviceOrientationEvent as DeviceOrientationEventWithPermission;
                const status = await orientationEvent.requestPermission?.();
                if (status) {
                    this.context.setPermissionStatus('orientation', status);
                }
            } else {
                this.context.setPermissionStatus('orientation', 'granted');
            }
        } finally {
            await this.refreshStatus();
        }
    }

    // ─── web-only helpers ────────────────────────────────────────────────────

    private isChromium(): boolean {
        return 'userAgentData' in navigator || /\bChrome\/\d+/.test(navigator.userAgent);
    }
}
