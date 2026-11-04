import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Comlink from 'comlink';
import { createPinia, setActivePinia } from 'pinia';

vi.mock('../std.ts', () => ({ server: {}, stdurl: (path: string) => path }));
vi.mock('../std.js', () => ({ serverUrl: 'http://localhost', getRuntimeToken: () => undefined }));
vi.mock('maplibre-gl', () => ({}));
vi.mock('maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url', () => ({ default: 'maplibre-worker.js' }));
vi.mock('../workers/atlas.ts?worker&url', () => ({ default: 'atlas-worker.js' }));

import { useMapStore } from '../stores/map.ts';

// A worker endpoint backed by a MessageChannel so the store talks to a real
// Comlink remote. Its proxy answers every property read - including Vue's
// `__v_raw` - with another proxy, which is what $reset() used to trip over.
class FakeWorker {
    static terminated = 0;

    constructor() {
        const { port1, port2 } = new MessageChannel();
        Comlink.expose({ destroy: async () => undefined }, port2);
        port1.start();
        return Object.assign(port1, {
            terminate: () => {
                FakeWorker.terminated++;
                port1.close();
                port2.close();
            }
        }) as unknown as FakeWorker;
    }
}

describe('mapStore teardown', () => {
    beforeEach(() => {
        vi.stubGlobal('Worker', FakeWorker);
        FakeWorker.terminated = 0;
        setActivePinia(createPinia());
    });

    it('resets the store without overflowing the stack while a worker is running', async () => {
        const store = useMapStore();

        store.startWorker();
        expect(store.hasWorker).toBe(true);

        await expect(store.destroy()).resolves.toBeUndefined();

        expect(FakeWorker.terminated).toBe(1);
        expect(store.hasWorker).toBe(false);
        expect(() => store.worker).toThrow('Atlas worker has not yet started');
    });

    it('starts a fresh worker after a teardown', async () => {
        const store = useMapStore();

        store.startWorker();
        await store.destroy();

        store.startWorker();
        expect(store.hasWorker).toBe(true);

        await store.destroy();
        expect(FakeWorker.terminated).toBe(2);
    });
});
