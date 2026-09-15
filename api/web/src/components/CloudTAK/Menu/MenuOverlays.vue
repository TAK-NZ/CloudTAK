<template>
    <MenuTemplate name='Overlays'>
        <template #buttons>
            <TablerIconButton
                :class='{
                    "pe-none": !isDraggable && !canEditOrder,
                    "opacity-50": !isDraggable && !canEditOrder
                }'
                :title='reorderButtonTitle'
                @click='handleReorderToggle'
            >
                <IconPencil
                    v-if='!isDraggable'
                    :size='32'
                    stroke='1'
                />
                <IconPencilCheck
                    v-else
                    :size='32'
                    stroke='1'
                />
            </TablerIconButton>

            <TablerIconButton
                v-if='!isDraggable'
                title='Add Overlay'
                @click='router.push("/menu/datas")'
            >
                <IconPlus
                    :size='32'
                    stroke='1'
                />
            </TablerIconButton>
        </template>

        <template #default>
            <div class='d-flex flex-column gap-3'>
                <div class='mt-2 d-flex align-items-center gap-3 flex-wrap'>
                    <TablerInput
                        v-model='overlayFilter'
                        placeholder='Search overlays...'
                        icon='search'
                        class='flex-grow-1'
                    />
                </div>

                <p
                    v-if='showDragHint'
                    class='small mb-0 text-white-50'
                >
                    {{ dragHintCopy }}
                </p>

                <TablerLoading
                    v-if='loading || !mapStore.isMapLoadedFully'
                    :desc='mapStore.isMapLoadedFully ? "Loading Overlays" : "Loading Map Overlays"'
                />

                <template v-else>
                    <div
                        v-if='overlayCount'
                        class='d-flex flex-column gap-3'
                    >
                        <!--
                            Map Features (the internal CoT overlay) is always
                            the top of the map layer stack, and the basemap is
                            always the bottom - the user explicitly asked for
                            both to be locked in place rather than draggable.
                            They're rendered in their own fixed lists outside
                            the `ref='sortableRef'` div so SortableJS never
                            manages them: it can't let another dragged card be
                            dropped above/below a card it doesn't control, so
                            there's no way for a drag on the freely-orderable
                            middle section to visually displace either pinned
                            card. OverlayManager.reorderLoaded() also refuses
                            to touch their `pos` even if an id for one of them
                            somehow ended up in the ordered-id list handed to
                            it, as defense in depth.
                        -->
                        <div
                            v-for='card in pinnedTopCards'
                            :key='card.overlay.id'
                        >
                            <OverlayCard
                                :card='card'
                                :is-draggable='isDraggable'
                                :draggable='false'
                                locked-title='Map Features always renders on top and cannot be reordered'
                                :is-opened='opened.has(card.overlay.id)'
                                @toggle-open='toggleOverlay(card.overlay.id)'
                                @update:visible='(value) => updateOverlay(card.overlay, { visible: value })'
                                @update:opacity='(value) => updateOverlay(card.overlay, { opacity: value })'
                                @remove='removeOverlay(card.overlay.id)'
                            />
                        </div>

                        <div
                            v-if='middleCards.length'
                            ref='sortableRef'
                            class='d-flex flex-column gap-3'
                        >
                            <OverlayCard
                                v-for='card in middleCards'
                                :key='card.overlay.id'
                                :card='card'
                                :is-draggable='isDraggable'
                                :draggable='true'
                                :is-opened='opened.has(card.overlay.id)'
                                @toggle-open='toggleOverlay(card.overlay.id)'
                                @update:visible='(value) => updateOverlay(card.overlay, { visible: value })'
                                @update:opacity='(value) => updateOverlay(card.overlay, { opacity: value })'
                                @remove='removeOverlay(card.overlay.id)'
                            />
                        </div>

                        <div
                            v-for='card in pinnedBottomCards'
                            :key='card.overlay.id'
                        >
                            <OverlayCard
                                :card='card'
                                :is-draggable='isDraggable'
                                :draggable='false'
                                locked-title='The basemap always renders on the bottom and cannot be reordered'
                                :is-opened='opened.has(card.overlay.id)'
                                @toggle-open='toggleOverlay(card.overlay.id)'
                                @update:visible='(value) => updateOverlay(card.overlay, { visible: value })'
                                @update:opacity='(value) => updateOverlay(card.overlay, { opacity: value })'
                                @remove='removeOverlay(card.overlay.id)'
                            />
                        </div>
                    </div>

                    <TablerNone
                        v-else
                        :label='hasSearchTerm ? "No overlays match your search" : "No overlays"'
                        :create='false'
                    />
                </template>
            </div>
        </template>
    </MenuTemplate>
</template>

<script setup lang='ts'>
import { ref, watch, useTemplateRef, computed, onMounted, onBeforeUnmount } from 'vue';
import { useRouter } from 'vue-router';
import type { Subscription } from 'dexie';
import MenuTemplate from '../util/MenuTemplate.vue';
import {
    TablerIconButton,
    TablerInput,
    TablerLoading,
    TablerNone
} from '@tak-ps/vue-tabler';
import {
    IconPencil,
    IconPencilCheck,
    IconPlus
} from '@tabler/icons-vue';
import OverlayCard from './Overlays/OverlayCard.vue';
import type { OverlayCard as OverlayCardData, OverlayBadge, OverlayStatus } from './Overlays/overlay-card.ts';
import Sortable from 'sortablejs';
import type { SortableEvent } from 'sortablejs';
import type Overlay from '../../../../src/base/overlay-class.ts';
import type { DBOverlay } from '../../../../src/database.ts';
import OverlayManager from '../../../../src/base/overlay.ts';
import { useMapStore } from '../../../stores/map.ts';
import { profileAssetIdFromUrl } from '../../../utils/offline-tiles.ts';

type OverlayUpdate = Parameters<Overlay['update']>[0];

const router = useRouter();
const mapStore = useMapStore();

let sortable: Sortable | undefined;

const isDraggable = ref(false);
const loading = ref(false);
const opened = ref<Set<number>>(new Set());
const overlayFilter = ref('');
const overlayRenderTick = ref(0);

const dbOverlays = ref<DBOverlay[]>([]);

let listSubscription: Subscription | undefined;

const sortableRef = useTemplateRef<HTMLElement>('sortableRef');

const hasSearchTerm = computed(() => overlayFilter.value.trim().length > 0);

function overlayMatchesTerm(overlay: Overlay, term: string): boolean {
    return (
        (overlay.name ?? '').toLowerCase().includes(term)
        || (overlay.type ?? '').toLowerCase().includes(term)
        || (overlay.mode ?? '').toLowerCase().includes(term)
    );
}

const overlayCards = computed<OverlayCardData[]>(() => {
    void overlayRenderTick.value;

    const term = overlayFilter.value.trim().toLowerCase();
    const seen = new Set<number>();
    const cards: OverlayCardData[] = [];

    const consider = (overlay: Overlay | undefined): void => {
        if (!overlay || seen.has(overlay.id)) return;
        seen.add(overlay.id);

        // The terrain basemap's raster-dem overlay is auto-provisioned hidden
        // for every user (ensureDefaultTerrain()) purely so its visibility flag
        // can drive 3D terrain - it has no styling/ordering/opacity of its own
        // to manage here, and the map's dedicated 3D toggle (the mountain icon,
        // which flips this same overlay's `visible` flag) is the intended
        // control surface. Showing it as a card just reads as a stray "Hidden"
        // item the user is expected to fix.
        if (overlay.type === 'raster-dem') return;

        if (term && !overlayMatchesTerm(overlay, term)) return;

        cards.push({
            overlay,
            visible: overlay.visible,
            status: resolveOverlayStatus(overlay),
            badges: getOverlayBadges(overlay),
            offline: isOfflineOverlay(overlay)
        });
    };

    for (const record of dbOverlays.value) {
        consider(OverlayManager.loadedFrom(record.id));
    }

    // Internal overlays (e.g. "Map Features") are never persisted, so merge them from the loaded set
    for (const overlay of OverlayManager.loaded) {
        consider(overlay);
    }

    // Descending: OverlayManager.loaded is bottom-of-map-stack-first (index 0
    // = bottom), but a layers panel is expected to read top-of-stack-first -
    // the topmost-rendered overlay (usually "Map Features") at the top of the
    // list, the basemap at the bottom - matching how the map actually looks.
    return cards.sort((a, b) => OverlayManager.loaded.indexOf(b.overlay) - OverlayManager.loaded.indexOf(a.overlay));
});

// Map Features is always the top of the real map layer stack; splitting it
// into its own pinned list (rendered outside the Sortable container) is what
// actually enforces that, rather than just displaying it that way.
const pinnedTopCards = computed(() => overlayCards.value.filter((card) => card.overlay._internal));

// The basemap is always the bottom of the real map layer stack, pinned for
// the same reason as pinnedTopCards above.
const pinnedBottomCards = computed(() => overlayCards.value.filter((card) => card.overlay.mode === 'basemap'));

// Everything else is freely reorderable, and is the only thing handed to SortableJS.
const middleCards = computed(() => overlayCards.value.filter((card) => !card.overlay._internal && card.overlay.mode !== 'basemap'));

const overlayCount = computed(() => overlayCards.value.length);

// Reordering only makes sense with two or more freely-orderable overlays -
// the pinned top/bottom overlays never move, so they don't count here.
const canEditOrder = computed(() => !hasSearchTerm.value && middleCards.value.length > 1);

const showDragHint = computed(() => middleCards.value.length > 1 && !isDraggable.value && !canEditOrder.value);

const dragHintCopy = computed(() => {
    if (!showDragHint.value) return '';
    return 'Reordering available once you clear the search.';
});

const reorderButtonTitle = computed(() => {
    if (isDraggable.value) return 'Save Order';
    if (!canEditOrder.value) {
        if (middleCards.value.length <= 1) return 'Add another overlay to reorder';
        return 'Clear the search to reorder overlays';
    }
    return 'Edit Order';
});

function subscribeList(): void {
    listSubscription?.unsubscribe();
    loading.value = true;

    listSubscription = OverlayManager.liveList({ localFirst: true }).subscribe({
        next: (items) => {
            dbOverlays.value = items as DBOverlay[];
            loading.value = false;
        },
        error: (err: unknown) => {
            console.error('Failed to load overlays:', err);
            dbOverlays.value = [];
            loading.value = false;
        }
    });
}

onMounted(() => {
    subscribeList();
});

watch(overlayFilter, () => {
    if (isDraggable.value && !canEditOrder.value) {
        isDraggable.value = false;
    }
});

watch(
    () => ({
        container: sortableRef.value,
        draggable: isDraggable.value,
        hasSearch: hasSearchTerm.value
    }),
    ({ container, draggable, hasSearch }) => {
        const canSort = !!container && draggable && !hasSearch;
        if (canSort && container) {
            if (sortable && sortable.el === container) return;
            if (sortable) sortable.destroy();
            sortable = new Sortable(container, {
                sort: true,
                handle: '.drag-handle',
                dataIdAttr: 'id',
                onEnd: saveOrder
            });
        } else if (sortable) {
            sortable.destroy();
            sortable = undefined;
        }
    },
    { immediate: true }
);

onBeforeUnmount(() => {
    listSubscription?.unsubscribe();
    listSubscription = undefined;

    if (sortable) {
        sortable.destroy();
        sortable = undefined;
    }
});

function handleReorderToggle() {
    if (isDraggable.value) {
        isDraggable.value = false;
        return;
    }

    if (!canEditOrder.value) return;

    isDraggable.value = true;
}

function toggleOverlay(id: number) {
    if (opened.value.has(id)) {
        opened.value.delete(id);
    } else {
        opened.value.add(id);
    }
}

function resolveOverlayStatus(overlay: Overlay): OverlayStatus {
    if (!overlay.healthy()) {
        return {
            label: 'Issue',
            variant: 'danger',
            tooltip: overlay._error?.message ?? 'Unknown error'
        };
    }

    if (overlay.loading) {
        return {
            label: 'Pending',
            variant: 'warning',
            tooltip: 'Overlay is still loading data from the server.'
        };
    }

    if (!overlay.styles?.length) {
        return {
            label: 'Pending',
            variant: 'warning',
            tooltip: 'Overlay does not contain any styles yet.'
        };
    }

    return {
        label: 'Ready',
        variant: 'success'
    };
}

function isOfflineOverlay(overlay: Overlay): boolean {
    const assetId = profileAssetIdFromUrl(overlay.url);
    return !!assetId && mapStore.offlineTiles.has(assetId);
}

function getOverlayBadges(overlay: Overlay): OverlayBadge[] {
    const badges: OverlayBadge[] = [];
    const seen = new Set<string>();

    const addBadge = (badge: OverlayBadge) => {
        if (seen.has(badge.label)) return;
        seen.add(badge.label);
        badges.push(badge);
    };

    if (overlay.mode === 'mission') {
        addBadge({ label: 'Mission', variant: 'primary' });
    } else if (overlay.mode === 'data') {
        addBadge({ label: 'Data', variant: 'info' });
    } else if (overlay.mode === 'profile') {
        addBadge({ label: 'Profile', variant: 'info' });
    }

    if (overlay.type === 'raster') {
        addBadge({ label: 'Raster', variant: 'secondary' });
    } else if (overlay.type === 'raster-dem') {
        addBadge({ label: 'Terrain', variant: 'secondary' });
    } else if (overlay.type === 'vector') {
        addBadge({ label: 'Vector', variant: 'secondary' });
    } else if (overlay.type === 'geojson') {
        addBadge({ label: 'GeoJSON', variant: 'secondary' });
    }

    if (!overlay.visible) {
        addBadge({ label: 'Hidden', variant: 'dark' });
    }

    return badges;
}

async function saveOrder(sortableEv: SortableEvent) {
    if (!sortable) return;
    if (sortableEv.newIndex === undefined || isNaN(parseInt(String(sortableEv.newIndex)))) return;

    const id = sortableEv.item.getAttribute('id');
    if (!id) return;

    // The list renders top-of-stack-first (see overlayCards), but
    // OverlayManager.reorderLoaded() expects ids bottom-of-stack-first, the
    // same convention as OverlayManager.loaded itself - reverse DOM order
    // back to that convention before handing it off. sortable only manages
    // the middle, freely-reorderable cards, so this never contains the
    // pinned Map Features/basemap ids.
    const overlay_ids = sortable.toArray().map((i) => parseInt(i)).reverse();

    try {
        await OverlayManager.reorderLoaded(overlay_ids, id);
    } catch (err) {
        console.error('Failed to sync overlay order:', err);
    }
}

async function updateOverlay(overlay: Overlay, body: OverlayUpdate): Promise<void> {
    const update = overlay.update(body);
    overlayRenderTick.value += 1;

    try {
        await update;
    } catch (err) {
        console.error('Failed to sync overlay update:', err);
    } finally {
        overlayRenderTick.value += 1;
    }
}

async function removeOverlay(id: number) {
    try {
        await OverlayManager.deleteLoaded(id);
    } catch (err) {
        console.error('Failed to sync overlay delete:', err);
    }
}
</script>
