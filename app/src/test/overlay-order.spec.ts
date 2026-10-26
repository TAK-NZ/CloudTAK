import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { serverPatch, serverPost, serverDelete, reconcileOverlays, layersOrder } = vi.hoisted(() => ({
    serverPatch: vi.fn(),
    serverPost: vi.fn(),
    serverDelete: vi.fn(),
    reconcileOverlays: vi.fn(async () => {}),
    layersOrder: { ids: [] as string[] }
}));

vi.mock('../std.ts', () => ({ server: { PATCH: serverPatch, POST: serverPost, DELETE: serverDelete } }));
vi.mock('../stores/map.ts', () => ({
    useMapStore: () => ({
        reconcileOverlays,
        map: { getLayersOrder: () => layersOrder.ids }
    })
}));
vi.mock('../base/overlay-class.ts', () => ({ default: class {} }));
vi.mock('../base/overlay-sync.ts', () => ({
    syncOverlays: vi.fn(),
    OVERLAY_LIST_CACHE_KEY: 'overlay'
}));

import OverlayManager from '../base/overlay.ts';
import type Overlay from '../base/overlay-class.ts';
import { db, type DBOverlay } from '../database.ts';

type StubOverlay = Overlay & {
    moveBefore: ReturnType<typeof vi.fn>;
    moveToBottom: ReturnType<typeof vi.fn>;
};

// The stub moves its layer within the simulated map order the way MapLibre would
function place(layer: string, before?: string): void {
    const order = layersOrder.ids.filter((id) => id !== layer);
    const idx = before === undefined ? -1 : order.indexOf(before);
    if (idx === -1) order.push(layer);
    else order.splice(idx, 0, layer);
    layersOrder.ids = order;
}

function stub(id: number, name: string, pos: number, mode = 'profile', layered = true): StubOverlay {
    const layer = `layer-${id}`;

    return {
        id, name, pos, mode,
        _internal: mode === 'internal',
        moveBefore: vi.fn((other?: Overlay) => place(layer, other?.anchorLayerId())),
        moveToBottom: vi.fn(() => {
            const first = layersOrder.ids.find((l) => l !== 'background' && l !== layer);
            place(layer, first);
        }),
        anchorLayerId: () => layered ? layer : undefined,
        layerIds: () => layered ? [layer] : [],
    } as unknown as StubOverlay;
}

function ids(): number[] {
    return OverlayManager.stack().map((overlay) => overlay.id);
}

describe('OverlayManager stack order', () => {
    let basemap: StubOverlay;
    let features: StubOverlay;
    let ordinary: StubOverlay[];

    beforeEach(() => {
        OverlayManager.clearLoaded();
        serverPatch.mockReset();
        serverPost.mockReset();
        serverDelete.mockReset();
        reconcileOverlays.mockReset();
        reconcileOverlays.mockResolvedValue(undefined);
        layersOrder.ids = [];

        basemap = stub(10, 'Basemap', -1, 'basemap');
        features = stub(-1, 'Map Features', 3, 'internal');
        ordinary = [1, 2, 3, 4, 5].map((id) => stub(id, `Overlay ${id}`, id));

        // Registry order is deliberately scrambled - only pos decides the stack
        OverlayManager.appendLoaded(features, ordinary[2], basemap, ordinary[0], ordinary[4], ordinary[1], ordinary[3]);
    });

    it('stack sorts by pos with basemaps pinned bottom and internal overlays top', () => {
        expect(ids()).toEqual([10, 1, 2, 3, 4, 5, -1]);
    });

    it('stack breaks pos ties by id so renames cannot reorder the map', () => {
        const a = stub(20, 'Zulu', 5);
        const b = stub(21, 'Alpha', 5);
        OverlayManager.appendLoaded(b, a);

        expect(ids()).toEqual([10, 1, 2, 3, 4, 5, 20, 21, -1]);
    });

    it('compareStack pins by overlay kind even when pos is corrupted', () => {
        basemap.pos = 4;
        features.pos = 0;

        expect(ids()).toEqual([10, 1, 2, 3, 4, 5, -1]);
    });

    it('applyOrder leaves the map alone when managed layers already match the stack', () => {
        layersOrder.ids = ['background', 'layer-10', 'layer-1', 'layer-2', 'routing-line', 'layer-3', 'layer-4', 'layer-5', 'layer--1'];

        OverlayManager.applyOrder();

        for (const overlay of [basemap, features, ...ordinary]) {
            expect(overlay.moveBefore).not.toHaveBeenCalled();
            expect(overlay.moveToBottom).not.toHaveBeenCalled();
        }
    });

    it('applyOrder moves only the overlays that are out of order', () => {
        layersOrder.ids = ['background', 'layer-10', 'layer-2', 'layer-1', 'layer-3', 'layer-4', 'layer-5', 'layer--1'];

        OverlayManager.applyOrder();

        expect(ordinary[0].moveBefore).toHaveBeenCalledWith(ordinary[1]);
        expect(layersOrder.ids).toEqual(['background', 'layer-10', 'layer-1', 'layer-2', 'layer-3', 'layer-4', 'layer-5', 'layer--1']);

        for (const overlay of [basemap, features, ordinary[1], ordinary[2], ordinary[3], ordinary[4]]) {
            expect(overlay.moveBefore).not.toHaveBeenCalled();
        }
    });

    it('applyOrder places a newly synced overlay by pos, not by registry position', () => {
        // A mission subscribed mid-session lands in the registry last but sorts by its pos
        const mission = stub(30, 'Mission', 2.5, 'mission');
        OverlayManager.appendLoaded(mission);

        layersOrder.ids = ['background', 'layer-10', 'layer-1', 'layer-2', 'layer-3', 'layer-4', 'layer-5', 'layer--1', 'layer-30'];

        OverlayManager.applyOrder();

        expect(layersOrder.ids).toEqual(['background', 'layer-10', 'layer-1', 'layer-2', 'layer-30', 'layer-3', 'layer-4', 'layer-5', 'layer--1']);
    });

    it('applyOrder ignores overlays with no layers on the map', () => {
        const terrain = stub(20, 'Terrain', 2.5, 'profile', false);
        OverlayManager.appendLoaded(terrain);

        layersOrder.ids = ['background', 'layer-10', 'layer-2', 'layer-1', 'layer-3', 'layer-4', 'layer-5', 'layer--1'];

        OverlayManager.applyOrder();

        expect(terrain.moveBefore).not.toHaveBeenCalled();
        expect(layersOrder.ids).toEqual(['background', 'layer-10', 'layer-1', 'layer-2', 'layer-3', 'layer-4', 'layer-5', 'layer--1']);
    });

    it('applyOrder keeps a basemap below layers it does not manage', () => {
        // A plugin's radar sits directly below Map Features. A basemap that was
        // just (re)added lands on top of the map and must go back to the bottom,
        // not to just under Map Features, which would put it over the radar.
        OverlayManager.clearLoaded();
        OverlayManager.appendLoaded(basemap, features);

        layersOrder.ids = ['background', 'weather-radar', 'layer--1', 'layer-10'];

        OverlayManager.applyOrder();

        expect(basemap.moveToBottom).toHaveBeenCalledTimes(1);
        expect(basemap.moveBefore).not.toHaveBeenCalled();
        expect(layersOrder.ids).toEqual(['background', 'layer-10', 'weather-radar', 'layer--1']);
    });

    it('applyOrder does not carry ordinary overlays over layers they were already below', () => {
        layersOrder.ids = ['background', 'layer-10', 'layer-1', 'weather-radar', 'layer-3', 'layer-2', 'layer-4', 'layer-5', 'layer--1'];

        OverlayManager.applyOrder();

        expect(layersOrder.ids.indexOf('layer-1')).toBeLessThan(layersOrder.ids.indexOf('weather-radar'));
        expect(ordinary[0].moveBefore).not.toHaveBeenCalled();
    });

    it('createLoaded rolls back a mission overlay whose data failed to load', async () => {
        serverPost.mockResolvedValue({ data: { id: 40, name: 'Mission', mode: 'mission', mode_id: 'guid', pos: 6 } });
        serverDelete.mockResolvedValue({ response: { status: 200 } });

        reconcileOverlays.mockImplementation(async () => {
            if (!OverlayManager.loadedFrom(40)) {
                const mission = stub(40, 'Mission', 6, 'mission');
                mission._load = Promise.resolve(null);
                OverlayManager.appendLoaded(mission);
            }
        });

        await expect(OverlayManager.createLoaded({
            name: 'Mission', mode: 'mission', mode_id: 'guid', url: '/mission/guid', type: 'geojson'
        })).rejects.toThrow('Failed to load the Data Sync');

        expect(serverDelete).toHaveBeenCalledTimes(1);
        expect(reconcileOverlays).toHaveBeenCalledTimes(2);
    });

    it('reorderLoaded persists the ordinary order, mirrors pos locally and reconciles', async () => {
        await db.overlay.bulkPut(OverlayManager.loaded.map((overlay) => ({
            id: overlay.id, name: overlay.name, pos: overlay.pos, mode: overlay.mode
        }) as DBOverlay));

        serverPatch.mockResolvedValue({
            data: { items: [2, 1, 3, 4, 5].map((id, pos) => ({ id, pos })) }
        });

        await OverlayManager.reorderLoaded([10, 2, 1, 3, 4, 5, -1]);

        expect(serverPatch).toHaveBeenCalledWith('/api/profile/overlay/order', {
            body: { ids: [2, 1, 3, 4, 5] }
        });

        expect((await db.overlay.get(2))?.pos).toBe(0);
        expect((await db.overlay.get(1))?.pos).toBe(1);
        expect((await db.overlay.get(10))?.pos).toBe(-1);
        expect(reconcileOverlays).toHaveBeenCalledTimes(1);
    });

    it('reorderLoaded surfaces API failures without touching local state', async () => {
        serverPatch.mockResolvedValue({ error: { message: 'nope' } });

        await expect(OverlayManager.reorderLoaded([2, 1])).rejects.toThrow('nope');
        expect(reconcileOverlays).not.toHaveBeenCalled();
    });
});
