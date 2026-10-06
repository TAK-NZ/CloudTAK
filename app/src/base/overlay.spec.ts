import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../database.ts', () => ({ db: { overlay: { put: vi.fn(async () => {}) }, profile: { get: vi.fn(async () => undefined) } } }));
vi.mock('../std.js', () => ({ std: vi.fn(async () => ({})), server: {}, stdurl: vi.fn() }));
vi.mock('@capacitor/preferences', () => ({ Preferences: { get: vi.fn(async () => ({ value: null })) } }));

// Minimal fake MapLibre map implementing real moveLayer()/addLayer() z-order
// semantics (per https://maplibre.org/maplibre-gl-js/docs/API/classes/Map/#movelayer):
// an ordered array of layer ids, index 0 = bottom of the stack.
class FakeMap {
    order: string[] = [];
    layerSpecs = new Map<string, unknown>();
    sources = new Set<string>();

    getStyle() { return { sources: {} }; }
    getSource(id: string) { return this.sources.has(id) ? { type: 'vector' } : undefined; }
    addSource(id: string) { this.sources.add(id); }

    addLayer(layer: { id: string }, before?: string) {
        this.layerSpecs.set(layer.id, layer);
        if (before) {
            const idx = this.order.indexOf(before);
            this.order.splice(idx === -1 ? this.order.length : idx, 0, layer.id);
        } else {
            this.order.push(layer.id);
        }
    }

    getLayer(id: string) { return this.layerSpecs.has(id) ? { id } : undefined; }

    moveLayer(id: string, beforeId?: string) {
        const idx = this.order.indexOf(id);
        if (idx !== -1) this.order.splice(idx, 1);
        if (beforeId) {
            const beforeIdx = this.order.indexOf(beforeId);
            this.order.splice(beforeIdx === -1 ? this.order.length : beforeIdx, 0, id);
        } else {
            this.order.push(id);
        }
    }

    setPaintProperty() {}
    setLayoutProperty() {}
    setGlobalStateProperty() {}
    getTerrain() { return null; }
    setTerrain() {}
    getPitch() { return 0; }
    easeTo() {}
    on() {}
    off() {}
}

const fakeMap = new FakeMap();
const fakeMapStore = {
    map: fakeMap,
    updateBackground: vi.fn(),
    updateAttribution: vi.fn(async () => {}),
};

vi.mock('../stores/map.ts', () => ({ useMapStore: () => fakeMapStore }));
vi.mock('../stores/map.js', () => ({ useMapStore: () => fakeMapStore }));
vi.mock('../stores/modules/feature-visibility.ts', () => ({ FeatureVisibility: { applyToOverlay: vi.fn(async () => {}) } }));

import Overlay from './overlay-class.ts';
import OverlayManager from './overlay.ts';

function styleLayers(id: number, n: number) {
    return Array.from({ length: n }, (_, i) => ({ id: `${id}-layer${i}`, type: 'circle', source: String(id) }));
}

async function makeOverlay(
    id: number,
    pos: number,
    mode: string,
    nLayers: number,
    opts: { internal?: boolean; type?: string } = {}
) {
    return Overlay.create({
        id, name: `overlay-${id}`, active: false, username: 'test',
        frequency: null, iconset: null,
        created: new Date().toISOString(), updated: new Date().toISOString(),
        actions: { feature: [] }, pos, type: opts.type ?? 'vector', opacity: 1, visible: true,
        mode, mode_id: null, encoding: null, attribution: '',
        url: 'https://example.test/tiles',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        styles: styleLayers(id, nLayers) as any,
        token: null, tilejson: null,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any, { skipSave: true, internal: opts.internal });
}

function overlaySpan(overlay: Overlay): [number, number] {
    const indices = overlay.styles.map((l) => fakeMap.order.indexOf(l.id));
    return [Math.min(...indices), Math.max(...indices)];
}

beforeEach(() => {
    fakeMap.order = [];
    fakeMap.layerSpecs.clear();
    fakeMap.sources.clear();
    OverlayManager.loaded.splice(0, OverlayManager.loaded.length);
});

describe('OverlayManager.applyLoadedOrder', () => {
    it('anchors past a layerless overlay (e.g. the auto-provisioned raster-dem terrain overlay) instead of corrupting the stack below it', async () => {
        // Regression test: the auto-provisioned terrain overlay
        // (ensureDefaultTerrain(), type raster-dem, always present, has zero
        // styles of its own) sitting between two real overlays in `loaded`
        // used to break moveBefore()'s anchor for whichever overlay was
        // sorted directly below it, pushing it (and everything below IT) to
        // the literal top of the map on the next applyLoadedOrder() call.
        const basemap = await makeOverlay(1, -1, 'basemap', 2);
        const m1 = await makeOverlay(2, 0, 'overlay', 2);
        const m2 = await makeOverlay(3, 1, 'overlay', 2);
        const terrain = await makeOverlay(4, 2, 'overlay', 0, { type: 'raster-dem' });
        const mapFeatures = await makeOverlay(-1, 3, 'internal', 3, { internal: true });

        OverlayManager.loaded.splice(0, OverlayManager.loaded.length, basemap, m1, m2, terrain, mapFeatures);

        OverlayManager.applyLoadedOrder();

        const [, basemapTop] = overlaySpan(basemap);
        const [mapFeaturesBottom] = overlaySpan(mapFeatures);

        expect(basemapTop).toBeLessThan(mapFeaturesBottom);
    });
});

describe('OverlayManager.reorderLoaded', () => {
    it('keeps the basemap and Map Features pinned to the ends of the stack across a reorder of the two middle overlays', async () => {
        const basemap = await makeOverlay(1, -1, 'basemap', 2);
        const m1 = await makeOverlay(2, 0, 'overlay', 2);
        const m2 = await makeOverlay(3, 1, 'overlay', 2);
        const mapFeatures = await makeOverlay(-1, 3, 'internal', 3, { internal: true });

        OverlayManager.loaded.splice(0, OverlayManager.loaded.length, basemap, m1, m2, mapFeatures);

        // Drag m1 above m2 in the display (top-first) order; saveOrder() in
        // MenuOverlays.vue reverses that back to bottom-first before calling
        // reorderLoaded, exactly like this.
        const orderedIds = [m2.id, m1.id];
        await OverlayManager.reorderLoaded(orderedIds, m1.id);

        expect(OverlayManager.loaded[0]).toBe(basemap);
        expect(OverlayManager.loaded[OverlayManager.loaded.length - 1]).toBe(mapFeatures);

        const [, basemapTop] = overlaySpan(basemap);
        const [mapFeaturesBottom] = overlaySpan(mapFeatures);
        expect(basemapTop).toBeLessThan(mapFeaturesBottom);
    });

    it('never reassigns pos on the basemap or an internal overlay even if their id lands in orderedIds', async () => {
        const basemap = await makeOverlay(1, -1, 'basemap', 2);
        const m1 = await makeOverlay(2, 0, 'overlay', 2);
        const mapFeatures = await makeOverlay(-1, 3, 'internal', 3, { internal: true });

        OverlayManager.loaded.splice(0, OverlayManager.loaded.length, basemap, m1, mapFeatures);

        // Deliberately include the pinned overlays' ids to make sure the
        // filter in reorderLoaded() excludes them structurally, not just by
        // omission from the caller.
        await OverlayManager.reorderLoaded([mapFeatures.id, m1.id, basemap.id], m1.id);

        expect(basemap.pos).toBe(-1);
        expect(mapFeatures.pos).toBe(3);
    });
});
