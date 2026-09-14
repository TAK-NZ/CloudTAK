import type {
    ProfileOverlay,
    ProfileOverlay_Create
} from '../types.ts';
import { shallowReactive } from 'vue';
import { DrawToolMode } from '../stores/modules/draw.ts';
import type { FeatureCollection } from 'geojson';
import { bbox } from '@turf/bbox'
import type { LngLatBoundsLike, LayerSpecification, SourceSpecification, VectorTileSource, RasterTileSource, GeoJSONSource, MapLayerMouseEvent } from 'maplibre-gl'
import cotStyles from '../utils/styles.ts'
import { std, server } from '../std.js';
import { db, type DBOverlay } from '../database.ts';
import {
    registerTileJSONProtocol,
    setOverlayTileJSON,
    clearOverlayTileJSON,
    tileJSONSourceUrl,
    type OverlayTileJSON
} from '../stores/modules/tilejson.ts';
import { useMapStore } from '../stores/map.js';
import ProfileConfig from './profile.ts';
import Subscription from './subscription.ts';
import { FeatureVisibility } from '../stores/modules/feature-visibility.ts';
import OverlayManager from './overlay.ts';

/**
 * Namespace a basemap/overlay style's layer ids and point them at the overlay's
 * own source.
 *
 * Returns new layer objects. Do not go back to mutating in place: `replace()`
 * used to transform the array its caller handed it, and MenuBasemaps passes
 * `basemap.styles` straight out of its own component state - so re-selecting the
 * same basemap prefixed the same array a second time, a third time, and so on.
 * Overlay 23 on test reached `23-23-23-Background` that way, uniformly across all
 * 287 layers, one level per click.
 *
 * Idempotent as well as non-mutating, because the prefixed form is *persisted*
 * (`create()` PATCHes it back), so a stored style is already namespaced and any
 * path that re-derives would otherwise double it. Belt and braces: the real fix
 * for that is to stop storing a derived value at all and prefix at render time,
 * which is a larger change than this.
 *
 * Layers exempt from the source rewrite:
 *   - `background` has no source property at all.
 *   - `hillshade` points at the shared `__terrain__` raster-dem source, not at
 *     this overlay's vector/raster source.
 *
 * `create()` and `replace()` disagreed about `background` before this - one
 * skipped it, the other assigned `source` and needed a `@ts-expect-error` to do
 * it. One helper, one rule.
 */
function namespaceStyles(
    id: number | string,
    styles: Array<LayerSpecification>
): Array<LayerSpecification> {
    const prefix = `${id}-`;

    return styles.map((layer) => {
        const l = { ...layer } as LayerSpecification;

        if (!l.id.startsWith(prefix)) l.id = `${prefix}${l.id}`;

        if (l.type !== 'background' && l.type !== 'hillshade') {
            (l as LayerSpecification & { source?: string }).source = String(id);
        }

        return l;
    });
}

export default class Overlay {
    _destroyed: boolean;
    _internal: boolean;

    _timer: ReturnType<typeof setInterval> | null;

    _clickable: Array<{ id: string; type: string }>;

    // Each MapLibre layer-scoped listener runs its own queryRenderedFeatures
    // hit-test on every mousemove, so hover listeners are registered once per
    // overlay (with the full layer id array) and tracked here for removal
    _hoverListeners: Array<{
        type: 'mouseenter' | 'mousemove' | 'mouseleave';
        layerIds: string[];
        handler: (e: MapLayerMouseEvent) => void;
    }>;

    _error?: Error;
    _loaded: boolean;

    loading: boolean;

    id: number;
    name: string;
    active: boolean;
    username?: string;
    frequency: number | null;
    iconset: string | null;
    created: string;
    updated: string;
    pos: number;
    type: string;
    opacity: number;
    visible: boolean;
    mode: string;
    mode_id: string | null;
    encoding: 'mapbox' | 'terrarium' | null;
    attribution: string;

    actions: ProfileOverlay["actions"];

    url?: string;
    styles: Array<LayerSpecification>;
    token: string | null;
    tilejson: OverlayTileJSON | null;

    static async create(
        body: ProfileOverlay | ProfileOverlay_Create,
        opts: {
            internal?: boolean;
            skipSave?: boolean;
            clickable?: Array<{ id: string; type: string }>;
            before?: string;
            skipLayers?: boolean;
        } = {}
    ): Promise<Overlay> {
        if (opts.skipSave !== true) {
            let ov = await std('/api/profile/overlay', {
                method: 'POST',
                body
            }) as ProfileOverlay;

            if (ov.styles && ov.styles.length) {
                ov.styles = namespaceStyles(ov.id, ov.styles as Array<LayerSpecification>);
            }

            ov = await std(`/api/profile/overlay/${ov.id}`, {
                method: 'PATCH',
                body: ov
            }) as ProfileOverlay;

            const overlay = shallowReactive(new Overlay(ov, {
                internal: opts.internal
            })) as Overlay;

            await overlay.init(opts);

            await db.overlay.put(overlay.toDBOverlay());

            return overlay;
        } else {
            const overlay = shallowReactive(new Overlay(body as ProfileOverlay, {
                internal: opts.internal
            })) as Overlay;

            await overlay.init(opts);

            return overlay;
        }
    }

    static async internal(
        body: {
            id: number;
            type: string;
            name: string;
            styles?: Array<LayerSpecification>;
            clickable?: Array<{ id: string; type: string }>;
        }
    ): Promise<Overlay> {
        const overlay = await Overlay.create({
            ...body,
            visible: true,
            opacity: 1,
            username: 'internal',
            url: '',
            frequency: null,
            iconset: null,
            created: new Date().toISOString(),
            updated: new Date().toISOString(),
            token: undefined,
            tilejson: null,
            mode: 'internal',
            mode_id: undefined,
            styles: body.styles || [],
            pos: 3,
        }, {
            skipSave: true,
            clickable: body.clickable,
            internal: true
        });

        return overlay;
    }

    static async load(id: number): Promise<Overlay> {
        const remote = await std(`/api/profile/overlay/${id}`) as ProfileOverlay;

        const ov = await Overlay.create(remote, {
            skipSave: true
        });

        return ov;
    }

    constructor(
        overlay: ProfileOverlay & { encoding?: 'mapbox' | 'terrarium' | null },
        opts: {
            internal?: boolean;
        } = {}
    ) {
        this._destroyed = false;
        this._internal = opts.internal || false;
        this._clickable = [];
        this._hoverListeners = [];
        this._loaded = false;

        this.loading = false;

        this.id = overlay.id;
        this.name = overlay.name;
        this.active = overlay.active;
        this.username = overlay.username;
        this.frequency = overlay.frequency;
        this.iconset = overlay.iconset;
        this.created = overlay.created;
        this.updated = overlay.updated;
        this.actions = overlay.actions || {
            feature: []
        };
        this.pos = overlay.pos;
        this.type = overlay.type;
        this.opacity = overlay.opacity;
        this.visible = overlay.visible;
        this.mode = overlay.mode;
        this.mode_id = overlay.mode_id || null;
        this.encoding = overlay.encoding || null;
        this.attribution = overlay.attribution || '';
        this.url = overlay.url;
        this.styles = overlay.styles as Array<LayerSpecification>;
        this.token = overlay.token;
        this.tilejson = overlay.tilejson ?? null;

        if (this.frequency) {
            this._timer = setInterval(async () => {
                const mapStore = useMapStore();
                try {
                    mapStore.map.refreshTiles(String(this.id));
                } catch (err) {
                    console.error('Error refreshing tiles for overlay', this.id, err);
                }
            }, this.frequency * 1000);
        } else {
            this._timer = null;
        }
    }

    healthy(): boolean {
        return !this._error;
    }

    isTiled(): boolean {
        return this.type === 'raster' || this.type === 'vector' || this.type === 'raster-dem';
    }

    private sourceSpec(): SourceSpecification {
        const url = tileJSONSourceUrl(this.id);

        if (this.type === 'raster-dem') {
            return { type: 'raster-dem', url, encoding: this.encoding || 'mapbox' };
        } else if (this.type === 'vector') {
            return { type: 'vector', url };
        }

        return { type: 'raster', url };
    }

    // Visibility maps onto the map's single terrain source; pitch eases only on user toggles
    applyTerrain(opts: { ease?: boolean } = {}): void {
        const mapStore = useMapStore();
        const sourceId = String(this.id);
        const active = mapStore.map.getTerrain()?.source === sourceId;

        if (this.visible && !this._error && mapStore.map.getSource(sourceId)) {
            if (!active) mapStore.map.setTerrain({ source: sourceId, exaggeration: 1.5 });
            mapStore.terrainEnabled = true;
            mapStore.map.setGlobalStateProperty('3d', true);
            if (opts.ease && mapStore.map.getPitch() === 0) mapStore.map.easeTo({ pitch: 45 });
        } else if (active) {
            this.disableTerrain(opts);
        }
    }

    private disableTerrain(opts: { ease?: boolean } = {}): void {
        const mapStore = useMapStore();
        mapStore.map.setTerrain(null);
        mapStore.terrainEnabled = false;
        mapStore.map.setGlobalStateProperty('3d', false);
        if (opts.ease) mapStore.map.easeTo({ pitch: 0 });
    }

    hasBounds(): boolean {
        const mapStore = useMapStore();
        const source = mapStore.map.getSource(String(this.id))
        if (!source) return false;

        if (source.type === 'vector') {
            return !!(source as VectorTileSource).bounds;
        } else if (source.type === 'raster') {
            return !!(source as RasterTileSource).bounds;
        } else if (source.type === 'geojson') {
            return true;
        } else {
            return false
        }
    }

    async zoomTo(): Promise<void> {
        const mapStore = useMapStore();
        const source = mapStore.map.getSource(String(this.id))
        if (!source) return;

        if (source.type === 'vector') {
            mapStore.map.fitBounds((source as VectorTileSource).bounds);
        } else if (source.type === 'raster') {
            mapStore.map.fitBounds((source as RasterTileSource).bounds);
        } else if (source.type === 'geojson') {
            const geojson = await (source as GeoJSONSource).getData();
            mapStore.map.fitBounds(bbox(geojson) as LngLatBoundsLike);
        }
    }

    /**
     * Ensure a raster-dem source exists on the map for hillshading, returning
     * its source ID. Does NOT enable 3D terrain — hillshading is a 2D effect
     * that only needs the raster-dem source to be registered.
     *
     * Resolution order:
     *  1. Any raster-dem source already on the map (e.g. from addTerrain())
     *  2. Query the API for any raster-dem basemap and add it as source
     *     '__terrain__' — no setTerrain() call, no 3D mode.
     *
     * Returns the source ID, or null if no raster-dem basemap is available.
     */
    static async ensureTerrainSource(mapStore: ReturnType<typeof useMapStore>): Promise<string | null> {
        // 1. Return any raster-dem source already on the map
        const sources = mapStore.map.getStyle().sources;
        for (const [id, src] of Object.entries(sources)) {
            if ((src as { type: string }).type === 'raster-dem') return id;
        }

        // 2. Load and register the first available raster-dem basemap as a bare
        //    raster-dem source — hillshading only, no 3D terrain.
        try {
            const { value: token } = await Preferences.get({ key: 'token' });

            const listUrl = stdurl('/api/basemap');
            listUrl.searchParams.set('type', 'raster-dem');
            listUrl.searchParams.set('hidden', 'all');
            listUrl.searchParams.set('limit', '1');
            if (token) listUrl.searchParams.set('token', token);

            const list = await std(listUrl.toString()) as { items: Array<{ id: number; tilesize?: number; encoding?: string }> };
            if (!list.items.length) return null;

            const terrain = list.items[0];
            const terrainUrl = stdurl(`/api/basemap/${terrain.id}/tiles`);
            if (token) terrainUrl.searchParams.set('token', token);

            const sourceId = '__terrain__';
            if (!mapStore.map.getSource(sourceId)) {
                // Hand MapLibre the TileJSON *url* and let it fetch and parse the
                // document itself, exactly as mapStore.addTerrain() does for 3D.
                //
                // This previously fetched the TileJSON here and spread it into
                // the source spec. MapLibre validates source specs and rejects
                // unknown properties, and CloudTAK's TileJSON carries several -
                // `tilejson`, `version`, `name`, `description`, `scheme`,
                // `center` and CloudTAK's own `actions`. Style.addSource()
                // returns early when validation fails, so the source was never
                // created; addLayers() then hit its `getSource` guard and
                // skipped every hillshade layer. Silent, because the validation
                // errors only surface as `error` events on the map.
                //
                // That is the whole reason 3D terrain worked while 2D
                // hillshading did not: addTerrain() was already passing a url.
                const source: {
                    type: 'raster-dem';
                    url: string;
                    tileSize?: number;
                    encoding?: 'mapbox' | 'terrarium';
                } = {
                    type: 'raster-dem',
                    url: String(terrainUrl)
                };

                if (terrain.tilesize) source.tileSize = terrain.tilesize;
                if (terrain.encoding === 'mapbox' || terrain.encoding === 'terrarium') {
                    source.encoding = terrain.encoding;
                }

                mapStore.map.addSource(sourceId, source);
            }

            return sourceId;
        } catch (err) {
            console.warn('Could not load terrain source for hillshading:', err);
            return null;
        }
    }

    async addLayers(before?: string): Promise<void> {
        const mapStore = useMapStore();

        // If init() failed to register the source (e.g. a /tiles fetch
        // 404'd), skip layer registration. addLayer would otherwise throw
        // "source ... not found" and break the rest of map setup.
        if (this._error || !mapStore.map.getSource(String(this.id))) {
            return;
        }

        for (const l of this.styles) {
            // Background layers have no source, and upstream's narrowing here is
            // what lets us read l.source below without a suppression.
            if (l.type === 'background') continue;

            let layerSource: string | undefined = l.source;

            // Resolve the __terrain__ sentinel to the actual raster-dem source.
            // If no terrain source is available yet, skip the layer — it will be
            // re-attempted when a raster-dem source is added to the map.
            if (layerSource === '__terrain__') {
                const terrainId = await Overlay.ensureTerrainSource(mapStore);
                if (!terrainId) continue;
                layerSource = terrainId;
            }

            // Skip layers whose source isn't loaded yet (e.g. a hillshade layer
            // referencing a raster-dem overlay that hasn't been added to the map).
            if (layerSource && !mapStore.map.getSource(layerSource)) continue;

            // Clone the layer spec so we can substitute the resolved source
            // without mutating the stored styles (which must keep '__terrain__').
            const layerToAdd = layerSource !== (l as LayerSpecification & { source?: string }).source
                ? { ...l, source: layerSource as string } as LayerSpecification
                : l;

            if (before) {
                mapStore.map.addLayer(layerToAdd, before);
            } else {
                mapStore.map.addLayer(layerToAdd);
            }
        }

        // The above doesn't set vis/opacity initially - apply directly
        // without round-tripping through update()/save() which would PATCH
        // the server with unchanged values.
        for (const l of this.styles) {
            // Background layers have no source, and upstream's narrowing here is
            // what lets us read l.source below without a suppression.
            if (l.type === 'background') continue;

            let layerSource: string | undefined = l.source;
            if (layerSource === '__terrain__') {
                const terrainId = await Overlay.ensureTerrainSource(mapStore);
                if (!terrainId) continue;
                layerSource = terrainId;
            }
            // Skip layers that were deferred above (source not yet loaded)
            if (layerSource && !mapStore.map.getSource(layerSource)) continue;
            if (!mapStore.map.getLayer(l.id)) continue;

            if (this.type === 'raster') {
                mapStore.map.setPaintProperty(l.id, 'raster-opacity', Number(this.opacity));
            }
            mapStore.map.setLayoutProperty(l.id, 'visibility', this.visible ? 'visible' : 'none');
        }

        if (this.type === 'raster-dem') this.applyTerrain();

        await FeatureVisibility.applyToOverlay(this);

        if (this.mode === 'basemap') {
            mapStore.updateBackground();
            await mapStore.updateAttribution();
        }

        this.removeHoverListeners();

        const hoverLayerIds = this._clickable.map((click) => click.id);

        if (hoverLayerIds.length) {
            const hoverIds = new Set<string>();

            const onMouseEnter = () => {
                if (mapStore.draw.mode !== DrawToolMode.STATIC) return;
                mapStore.map.getCanvas().style.cursor = 'pointer';
            };

            const onMouseMove = (e: MapLayerMouseEvent) => {
                if (mapStore.draw.mode !== DrawToolMode.STATIC) return;
                if (!e.features) return;

                const newIds = new Set<string>();
                for (const f of e.features) newIds.add(String(f.id));

                for (const id of hoverIds) {
                    if (newIds.has(id)) continue;

                    mapStore.map.setFeatureState({
                        id: id,
                        source: String(this.id),
                        sourceLayer: 'out'
                    }, { hover: false });

                    hoverIds.delete(id);
                }

                for (const id of newIds) {
                    if (hoverIds.has(id)) continue;

                    mapStore.map.setFeatureState({
                        id: id,
                        source: String(this.id),
                        sourceLayer: 'out'
                    }, { hover: true });

                    hoverIds.add(id);
                }
            };

            const onMouseLeave = () => {
                if (mapStore.draw.mode !== DrawToolMode.STATIC) return;
                mapStore.map.getCanvas().style.cursor = '';

                for (const id of hoverIds) {
                    mapStore.map.setFeatureState({
                        id: id,
                        source: String(this.id),
                        sourceLayer: 'out'
                    }, { hover: false });
                }

                hoverIds.clear();
            };

            mapStore.map.on('mouseenter', hoverLayerIds, onMouseEnter);
            this._hoverListeners.push({ type: 'mouseenter', layerIds: hoverLayerIds, handler: onMouseEnter });

            mapStore.map.on('mouseleave', hoverLayerIds, onMouseLeave);
            this._hoverListeners.push({ type: 'mouseleave', layerIds: hoverLayerIds, handler: onMouseLeave });

            // Only vector overlays track hover feature-state, so only they pay
            // for a per-mousemove hit-test
            if (this.type === 'vector') {
                mapStore.map.on('mousemove', hoverLayerIds, onMouseMove);
                this._hoverListeners.push({ type: 'mousemove', layerIds: hoverLayerIds, handler: onMouseMove });
            }
        }
    }

    removeHoverListeners(): void {
        const mapStore = useMapStore();

        for (const l of this._hoverListeners) {
            mapStore.map.off(l.type, l.layerIds, l.handler);
        }

        this._hoverListeners = [];
    }

    async init(opts: {
        clickable?: Array<{ id: string; type: string }>;
        before?: string;
        skipLayers?: boolean;
    } = {}) {
        const mapStore = useMapStore();

        this._error = undefined;

        if (this.isTiled() && this.url) {
            if (!mapStore.map.getSource(String(this.id))) {
                // TileJSON load failures surface via the map `error` event (see map store)
                registerTileJSONProtocol();
                setOverlayTileJSON(this.id, { url: this.url, tilejson: this.tilejson });

                try {
                    mapStore.map.addSource(String(this.id), this.sourceSpec());
                } catch (err) {
                    this._error = err instanceof Error ? err : new Error(String(err));
                    console.error(`Failed to add ${this.type} source for overlay ${this.id} (${this.name}):`, err);
                }
            }
        } else if (this.type === 'geojson') {
            if (!mapStore.map.getSource(String(this.id))) {
                const data: FeatureCollection = { type: 'FeatureCollection', features: [] };

                mapStore.map.addSource(String(this.id), {
                    type: 'geojson',
                    cluster: false,
                    data
                })
            }
        }

        const display_text = (await ProfileConfig.get('display_text'))?.value;
        const display_icon_rotation = (await ProfileConfig.get('display_icon_rotation'))?.value;

        let size = 8
        if (display_text === 'Small') size = 4;
        if (display_text === 'Large') size = 16;

        if (!this.styles.length && this.type === 'raster') {
            this.styles = [{
                'id': String(this.id),
                'type': 'raster',
                'source': String(this.id)
            }]
        } else if (!this.styles.length && this.type === 'vector') {
            this.styles = cotStyles(String(this.id), {
                sourceLayer: 'out',
                group: false,
                icons: !!this.iconset,
                labels: { size }
            });
        } else if (!this.styles.length && this.type === 'geojson') {
            this.styles = cotStyles(String(this.id), {
                group: this.mode !== "mission",
                icons: true,
                course: true,
                rotateIcons: display_icon_rotation,
                labels: { size }
            });
        } else if (!this.styles.length) {
            this.styles = [];
        }

        if (this.type === 'vector' && this. mode !== 'basemap' && opts.clickable === undefined) {
            opts.clickable = this.styles.map((l) => {
                return { id: l.id, type: 'feat' };
            });
        } else if (this.type === 'geojson' && opts.clickable === undefined) {
            opts.clickable = this.styles.map((l) => {
                if (this.mode === 'mission') {
                    return { id: l.id, type: 'cot' };
                } else {
                    return { id: l.id, type: this.id === -1 ? 'cot' : 'feat' };
                }
            });
        }

        if (!opts.clickable) {
            opts.clickable = [];
        }

        this._clickable = opts.clickable;

        if (!opts.skipLayers) {
            await this.addLayers(opts.before);
        }
        this._loaded = true;

        // If this overlay provides a raster-dem source, other overlays (e.g. a
        // vector basemap with a hillshade layer) may have deferred layers that
        // depend on it. Re-attempt adding their deferred layers now.
        // This covers both explicit raster-dem overlays and the '-2' terrain source.
        if (this.type === 'raster-dem' || String(this.id) === '-2') {
            for (const other of OverlayManager.loaded) {
                if (other === this || !other._loaded) continue;
                await other.addLayers(opts.before);
            }
        }
    }

    remove() {
        const mapStore = useMapStore();

        this.removeHoverListeners();

        if (mapStore.map.getTerrain()?.source === String(this.id)) this.disableTerrain();

        for (const l of this.styles) {
            if (mapStore.map.getLayer(String(l.id))) {
                mapStore.map.removeLayer(String(l.id));
            }
        }

        if (mapStore.map.getStyle().sources[String(this.id)]) {
            // Don't crash the map if it already  removed
            mapStore.map.removeSource(String(this.id));
        }

        clearOverlayTileJSON(this.id);
    }

    /**
     * First renderable layer id of this overlay that is present on the map
     */
    anchorLayerId(): string | undefined {
        const mapStore = useMapStore();
        const anchor = this.styles.find((l) => l.type !== 'background' && mapStore.map.getLayer(l.id));
        return anchor ? String(anchor.id) : undefined;
    }

    moveBefore(overlay?: Overlay): void {
        const mapStore = useMapStore();
        const before = overlay?.styles.find((l) => l.type !== 'background')?.id;
        const hasBefore = before ? !!mapStore.map.getLayer(before) : false;

        for (const layer of this.styles) {
            if (!mapStore.map.getLayer(layer.id)) continue;

            if (before && hasBefore) {
                mapStore.map.moveLayer(layer.id, before);
            } else {
                mapStore.map.moveLayer(layer.id);
            }
        }
    }

    async replace(
        overlay: {
            name?: string
            active?: boolean;
            username?: string
            actions?: ProfileOverlay["actions"];
            type?: string;
            opacity?: number;
            visible?: boolean;
            mode?: string;
            mode_id?: string;
            encoding?: 'mapbox' | 'terrarium' | null;
            attribution?: string;
            url?: string;
            token?: string;
            tilejson?: OverlayTileJSON | null;
            styles?: Array<LayerSpecification>;
        },
        opts: {
            before?: string;
        } = {}
    ): Promise<void> {
        this.remove();

        const oldType = this.type;
        const oldUrl = this.url;
        const oldModeId = this.mode_id;

        if (overlay.name) this.name = overlay.name;
        if (overlay.active !== undefined) this.active = overlay.active;
        if (overlay.username) this.username = overlay.username;
        if (overlay.actions) this.actions = overlay.actions || { feature: [] };
        if (overlay.type) this.type = overlay.type;

        if (this.type === 'raster' && oldType !== 'raster' && !overlay.styles) {
            this.styles = [];
        }

        if (overlay.opacity !== undefined) this.opacity = overlay.opacity;
        if (overlay.visible !== undefined) this.visible = overlay.visible;
        if (overlay.mode) this.mode = overlay.mode;
        if (overlay.mode_id) this.mode_id = overlay.mode_id || null;
        if (overlay.encoding !== undefined) this.encoding = overlay.encoding;
        if (overlay.attribution !== undefined) this.attribution = overlay.attribution;
        if (overlay.url) this.url = overlay.url;
        if (overlay.token) this.token = overlay.token;
        if (overlay.tilejson !== undefined) {
            this.tilejson = overlay.tilejson;
        } else if (this.url !== oldUrl || this.mode_id !== oldModeId) {
            this.tilejson = null;
        }
        if (overlay.styles) {
            // namespaceStyles() copies, so the caller's array is left alone.
            this.styles = namespaceStyles(this.id, overlay.styles as Array<LayerSpecification>);
        }

        await this.init({
            clickable: this._clickable,
            before: opts.before
        });

        await this.save();


        if (this.mode === 'basemap') {
            const mapStore = useMapStore();
            await mapStore.updateAttribution();
        }
    }

    async delete(): Promise<void> {
        const mapStore = useMapStore();
        const wasBasemap = this.mode === 'basemap';

        if (this.mode === 'mission' && this.mode_id) {
            if (mapStore.mission && mapStore.mission.guid === this.mode_id) {
                await mapStore.makeActiveMission(undefined);
            }

            const sub = await Subscription.from(this.mode_id, {
                subscribed: true
            });

            if (sub) {
                await sub.update({ subscribed: false });
            }
        }

        this._destroyed = true;

        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }

        this.remove();

        if (this._internal) return;

        if (this.id) {
            await db.overlay.delete(this.id);

            const { error, response } = await server.DELETE('/api/profile/overlay', {
                params: {
                    query: {
                        id: String(this.id),
                    }
                }
            });

            if (error && response.status !== 404) throw new Error(error.message);
        }

        // If the remaining basemaps provide no background color the CloudTAK
        // default is restored
        if (wasBasemap) {
            mapStore.updateBackground();
            await mapStore.updateAttribution();
        }
    }

    /**
     * Bring this loaded overlay in line with its local database record.
     * Changes are applied to the map directly and never saved, so records
     * written by another client (via AtlasSync) or by this client's own
     * update()/save() are reflected without echoing a PATCH back to the API.
     */
    async applyRecord(
        record: DBOverlay,
        opts: {
            before?: string;
        } = {}
    ): Promise<void> {
        const mapStore = useMapStore();

        const current = this.toDBOverlay();
        const sourceChanged = record.type !== current.type
            || record.url !== current.url
            || record.token !== current.token
            || (record.encoding ?? null) !== (current.encoding ?? null)
            || (!!record.tilejson && !!current.tilejson && JSON.stringify(record.tilejson) !== JSON.stringify(current.tilejson))
            || (record.styles.length > 0 && JSON.stringify(record.styles) !== JSON.stringify(current.styles));

        if (sourceChanged) this.remove();

        this.name = record.name;
        this.active = record.active;
        this.username = record.username;
        this.frequency = record.frequency;
        this.iconset = record.iconset;
        this.updated = record.updated;
        this.actions = record.actions || { feature: [] };
        this.pos = record.pos;
        this.type = record.type;
        this.mode = record.mode;
        this.mode_id = record.mode_id || null;
        this.encoding = record.encoding || null;
        this.attribution = record.attribution || '';
        this.url = record.url;
        this.token = record.token;
        this.tilejson = record.tilejson ?? this.tilejson;

        if (record.frequency !== current.frequency) {
            if (this._timer) clearInterval(this._timer);
            this._timer = record.frequency ? setInterval(() => {
                try {
                    mapStore.map.refreshTiles(String(this.id));
                } catch (err) {
                    console.error('Error refreshing tiles for overlay', this.id, err);
                }
            }, record.frequency * 1000) : null;
        }

        if (sourceChanged) {
            this.opacity = record.opacity;
            this.visible = record.visible;
            this.styles = record.styles as Array<LayerSpecification>;
            this._error = undefined;
            await this.init({ before: opts.before });
            return;
        }

        if (record.opacity !== this.opacity) {
            this.opacity = record.opacity;
            if (this.type === 'raster') {
                for (const l of this.styles) {
                    mapStore.map.setPaintProperty(l.id, 'raster-opacity', Number(this.opacity));
                }
            }
        }

        if (record.visible !== this.visible) {
            this.visible = record.visible;
            for (const l of this.styles) {
                if (l.type === 'background') continue;
                mapStore.map.setLayoutProperty(l.id, 'visibility', this.visible ? 'visible' : 'none');
            }

            if (this.type === 'raster-dem') this.applyTerrain();
        }
    }

    async update(body: {
        pos?: number;
        visible?: boolean;
        opacity?: number;
    }): Promise<void> {
        const mapStore = useMapStore();

        let changed = false;

        if (body.opacity !== undefined && body.opacity !== this.opacity) {
            this.opacity = body.opacity;
            for (const l of this.styles) {
                if (this.type === 'raster') {
                    mapStore.map.setPaintProperty(l.id, 'raster-opacity', Number(this.opacity));
                }
            }
            changed = true;
        }

        if (body.visible !== undefined && body.visible !== this.visible) {
            this.visible = body.visible;
            for (const l of this.styles) {
                if (l.type === 'background') continue;
                mapStore.map.setLayoutProperty(l.id, 'visibility', this.visible ? 'visible' : 'none');
            }

            if (this.type === 'raster-dem') this.applyTerrain({ ease: true });
            changed = true;
        }

        if (this.mode === 'basemap') {
            mapStore.updateBackground();
            await mapStore.updateAttribution();
        }

        if (body.pos !== undefined && body.pos !== this.pos) {
            this.pos = body.pos;
            changed = true;
        }

        if (changed) {
            await this.save();
        }
    }

    async save(): Promise<void> {
        if (this._destroyed) throw new Error('Cannot save a destroyed layer');
        if (this._internal) return;

        // We want to just use the default style every time for things like missions
        // We only want to save the style on custom datasources
        const dropStyles = ['mission', 'internal'].includes(this.mode);

        await db.overlay.put(this.toDBOverlay());

        const saved = await std(`/api/profile/overlay/${this.id}`, {
            method: 'PATCH',
            body: {
                pos: this.pos,
                name: this.name,
                type: this.type,
                active: this.active,
                opacity: this.opacity,
                mode_id: this.mode_id,
                url: this.url,
                visible: this.visible,
                styles: dropStyles ? [] : this.styles
            }
        }) as ProfileOverlay;

        if (saved.tilejson && JSON.stringify(saved.tilejson) !== JSON.stringify(this.tilejson)) {
            this.tilejson = saved.tilejson;
            await db.overlay.put(this.toDBOverlay());
        }
    }

    toDBOverlay(): DBOverlay {
        const dropStyles = ['mission', 'internal'].includes(this.mode);

        // IndexedDB uses the structured clone algorithm which cannot clone Vue
        // reactive Proxy objects. JSON round-trip strips any Proxy wrappers so
        // only plain objects reach the database.
        const styles = dropStyles ? [] : JSON.parse(JSON.stringify(this.styles)) as Array<LayerSpecification>;

        return {
            id: this.id,
            name: this.name,
            active: this.active,
            username: this.username,
            frequency: this.frequency,
            iconset: this.iconset,
            created: this.created,
            updated: this.updated,
            pos: this.pos,
            type: this.type,
            opacity: this.opacity,
            visible: this.visible,
            mode: this.mode,
            mode_id: this.mode_id,
            encoding: this.encoding,
            attribution: this.attribution,
            actions: this.actions,
            url: this.url,
            styles,
            token: this.token,
            tilejson: this.tilejson
        } as DBOverlay;
    }
}
