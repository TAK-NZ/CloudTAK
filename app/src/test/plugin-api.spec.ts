import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({
    worker: {
        db: {
            addAll: vi.fn(),
            remove: vi.fn(),
        },
    },
    refresh: vi.fn(),
}));

const feature = vi.hoisted(() => ({
    toArray: vi.fn(),
    filter: vi.fn(),
}));

vi.mock('../stores/map.ts', () => ({ useMapStore: () => store }));
vi.mock('../stores/float.ts', () => ({ useFloatStore: () => ({}) }));
vi.mock('../database.ts', () => ({ db: { feature } }));
vi.mock('../std.ts', () => ({ std: vi.fn(), stdurl: vi.fn() }));
vi.mock('maplibre-gl', () => ({}));

import { PluginAPI } from '../../plugin.ts';
import type { InputFeature } from '../../plugin.ts';

function polygon(id: string): InputFeature {
    return {
        id,
        type: 'Feature',
        path: '/',
        properties: { id, type: 'u-d-f', callsign: id },
        geometry: { type: 'Polygon', coordinates: [[[175, -40], [175.1, -40], [175.1, -40.1], [175, -40]]] },
    } as unknown as InputFeature;
}

describe('PluginAPI feature write side', () => {
    let api: PluginAPI;

    beforeEach(() => {
        vi.clearAllMocks();
        store.worker.db.addAll.mockResolvedValue(undefined);
        store.worker.db.remove.mockResolvedValue(undefined);
        store.refresh.mockResolvedValue(undefined);
        api = new PluginAPI({} as never, {} as never, {} as never);
    });

    describe('add', () => {
        it('adds deep copies as authored features, then refreshes', async () => {
            const input = [polygon('a'), polygon('b')];
            await api.feature.add(input);

            expect(store.worker.db.addAll).toHaveBeenCalledTimes(1);
            const [added, opts] = store.worker.db.addAll.mock.calls[0];
            expect(opts).toEqual({ authored: true });
            expect(added).toEqual(input);
            expect(added[0]).not.toBe(input[0]);
            expect(store.refresh).toHaveBeenCalledTimes(1);
            expect(store.refresh.mock.invocationCallOrder[0]).toBeGreaterThan(store.worker.db.addAll.mock.invocationCallOrder[0]);
        });

        it('does not share state with the input', async () => {
            const input = [polygon('a')];
            await api.feature.add(input);
            const [added] = store.worker.db.addAll.mock.calls[0];

            input[0].properties.callsign = 'changed';
            (input[0].geometry as { coordinates: number[][][] }).coordinates[0][0][0] = 0;

            expect(added[0].properties.callsign).toBe('a');
            expect(added[0].geometry.coordinates[0][0][0]).toBe(175);
        });

        it('sets no origin without a mission', async () => {
            await api.feature.add([polygon('a')]);
            const [added] = store.worker.db.addAll.mock.calls[0];
            expect(added[0].origin).toBeUndefined();
        });

        it('files every copy in the Data Sync when a mission is given', async () => {
            const input = [polygon('a'), polygon('b')];
            await api.feature.add(input, { mission: 'guid-1' });

            const [added] = store.worker.db.addAll.mock.calls[0];
            for (const f of added) {
                expect(f.origin).toEqual({ mode: 'Mission', mode_id: 'guid-1' });
            }
            expect(input[0].origin).toBeUndefined();
        });

        it('rejects when the store rejects and does not refresh', async () => {
            store.worker.db.addAll.mockRejectedValue(new Error('not loaded'));
            await expect(api.feature.add([polygon('a')], { mission: 'guid-1' })).rejects.toThrow('not loaded');
            expect(store.refresh).not.toHaveBeenCalled();
        });
    });

    describe('remove', () => {
        it('removes every id and resolves', async () => {
            await expect(api.feature.remove(['a', 'b', 'c'])).resolves.toBeUndefined();
            expect(store.worker.db.remove.mock.calls.map((c) => c[0])).toEqual(['a', 'b', 'c']);
        });

        it('tries every id and rejects with the first failure', async () => {
            store.worker.db.remove.mockImplementation(async (id: string) => {
                if (id === 'b') throw new Error('first');
                if (id === 'c') throw new Error('second');
            });

            await expect(api.feature.remove(['a', 'b', 'c', 'd'])).rejects.toThrow('first');
            expect(store.worker.db.remove).toHaveBeenCalledTimes(4);
        });
    });

    describe('list and stream', () => {
        it('list reads the local database, with and without a filter', async () => {
            feature.toArray.mockResolvedValue([{ id: 'a' }]);
            const filtered = { toArray: vi.fn().mockResolvedValue([{ id: 'b' }]) };
            feature.filter.mockReturnValue(filtered);

            expect(await api.feature.list()).toEqual([{ id: 'a' }]);
            const fn = () => true;
            expect(await api.feature.list({ filter: fn })).toEqual([{ id: 'b' }]);
            expect(feature.filter).toHaveBeenCalledWith(fn);
        });

        it('stream is an observable', () => {
            expect(typeof api.feature.stream().subscribe).toBe('function');
        });
    });
});
