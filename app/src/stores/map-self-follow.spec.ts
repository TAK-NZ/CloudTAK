import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useMapStore } from './map.ts';

describe('map store: self follow keeps the map north up', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
    });

    it('does not turn compass orientation on when the follow is armed with a known heading', () => {
        const store = useMapStore();
        store.deviceHeading = 123;
        store.userOrientationMode = false;

        // Launch, resume and the locator button all arm the follow
        store.armSelfFollow();

        expect(store.selfFollow).toBe(true);
        expect(store.userOrientationMode).toBe(false);
    });

    it('does not turn compass orientation on when the heading arrives after the follow was armed', () => {
        const store = useMapStore();
        store.deviceHeading = null;
        store.armSelfFollow();

        store.deviceHeading = 200;
        store.armSelfFollow();

        expect(store.userOrientationMode).toBe(false);
    });

    it('keeps compass orientation the user switched on', () => {
        const store = useMapStore();
        store.deviceHeading = 90;
        store.setOrientationMode(true);

        store.armSelfFollow();

        expect(store.userOrientationMode).toBe(true);
    });

    it('releasing the follow leaves the user\'s compass setting alone', () => {
        const store = useMapStore();
        store.setOrientationMode(true);

        store.releaseSelfFollow();

        expect(store.selfFollow).toBe(false);
        expect(store.userOrientationMode).toBe(true);
    });
});
