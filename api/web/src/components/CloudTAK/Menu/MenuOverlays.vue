<template>
    <MenuTemplate name='Overlays'>
        <template #buttons>
            <TablerIconButton
                v-if='isDraggable === false'
                title='Edit Order'
                @click='isDraggable = true'
            >
                <IconPencil
                    :size='32'
                    stroke='1'
                />
            </TablerIconButton>

            <TablerIconButton
                v-else-if='isDraggable === true'
                title='Save Order'
                @click='isDraggable = false'
            >
                <IconPencilCheck
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
            <TablerLoading v-if='loading || !isLoaded' />
            <template v-else>
                <div ref='sortableRef'>
                    <div
                        v-for='overlay in sortedOverlays'
                        :id='String(overlay.id)'
                        :key='overlay.id'
                        class='col-lg py-2'
                    >
                        <div class='py-2 px-3'>
                            <div class='col-12 d-flex align-items-center'>
                                <IconGripVertical
                                    v-if='isDraggable && overlay.name !== "CoT Icons"'
                                    v-tooltip='"Draw to reorder"'
                                    class='drag-handle cursor-move'
                                    role='button'
                                    tabindex='0'
                                    :size='20'
                                    stroke='1'
                                />
                                <div
                                    v-else-if='isDraggable && overlay.name === "CoT Icons"'
                                    v-tooltip='"CoT Icons always stays at top"'
                                    class='opacity-50'
                                    :size='20'
                                >
                                    <IconGripVertical
                                        :size='20'
                                        stroke='1'
                                    />
                                </div>

                                <template v-if='!overlay.healthy()'>
                                    <IconAlertTriangle
                                        v-if='!isDraggable && !opened.has(overlay.id)'
                                        v-tooltip='overlay._error ? overlay._error.message : "Unknown Error"'
                                        :size='20'
                                        stroke='1'
                                    />
                                </template>
                                <template v-else-if='overlay.id !== 0 && overlay.mode !== "basemap"'>
                                    <IconChevronRight
                                        v-if='!isDraggable && !opened.has(overlay.id)'
                                        :size='20'
                                        stroke='1'
                                        role='button'
                                        tabindex='0'
                                        class='cursor-pointer'
                                        @click='opened.add(overlay.id)'
                                    />
                                    <IconChevronDown
                                        v-else-if='!isDraggable'
                                        :size='20'
                                        stroke='1'
                                        role='button'
                                        tabindex='0'
                                        class='cursor-pointer'
                                        @click='opened.delete(overlay.id)'
                                    />
                                </template>
                                <template v-else-if='overlay.mode === "basemap" && !isDraggable'>
                                    <div style='width: 20px;'></div>
                                </template>

                                <span class='mx-2'>
                                    <IconMap
                                        v-if='overlay.mode === "basemap"'
                                        v-tooltip='"Basemap"'
                                        :size='20'
                                        stroke='1'
                                    />
                                    <IconReplace
                                        v-else-if='overlay.type === "geojson" && overlay.mode === "mission"'
                                        v-tooltip='"Data Sync"'
                                        :size='20'
                                        stroke='1'
                                    />
                                    <IconVector
                                        v-else-if='overlay.name === "CoT Icons"'
                                        v-tooltip='"Vector"'
                                        :size='20'
                                        stroke='1'
                                    />
                                    <IconStack
                                        v-else
                                        v-tooltip='"Overlay"'
                                        :size='20'
                                        stroke='1'
                                    />
                                </span>

                                <span
                                    class='mx-2 user-select-none text-truncate'
                                    style='width: 200px;'
                                >
                                    <a
                                        v-if='overlay.mode === "mission"'
                                        class='cursor-pointer text-underline'
                                        @click='router.push(`/menu/missions/${overlay.mode_id}`)'
                                        v-text='overlay.name'
                                    />
                                    <a
                                        v-else-if='overlay.mode === "basemap"'
                                        class='cursor-pointer text-white'
                                        @click='router.push("/menu/basemaps")'
                                        v-text='overlay.name'
                                    />
                                    <span
                                        v-else
                                        v-text='overlay.name'
                                    />
                                </span>

                                <div class='ms-auto btn-list'>
                                    <TablerIconButton
                                        v-if='overlay.hasBounds() && overlay.mode !== "basemap"'
                                        title='Zoom To Overlay'
                                        @click.stop.prevent='overlay.zoomTo()'
                                    >
                                        <IconMaximize
                                            :size='20'
                                            stroke='1'
                                        />
                                    </TablerIconButton>

                                    <TablerDelete
                                        v-if='
                                            opened.has(overlay.id)
                                                && ["mission", "data", "profile", "overlay"].includes(overlay.mode)
                                        '
                                        :key='overlay.id'
                                        v-tooltip='"Delete Overlay"'
                                        :size='20'
                                        role='button'
                                        tabindex='0'
                                        displaytype='icon'
                                        @delete='removeOverlay(overlay.id)'
                                    />

                                    <TablerIconButton
                                        v-if='overlay.visible && overlay.mode !== "basemap"'
                                        title='Hide Layer'
                                        @click.stop.prevent='overlay.update({ visible: !overlay.visible })'
                                    >
                                        <IconEye
                                            :size='20'
                                            stroke='1'
                                        />
                                    </TablerIconButton>
                                    <TablerIconButton
                                        v-else-if='overlay.mode !== "basemap"'
                                        title='Show Layer'
                                        @click.stop.prevent='overlay.update({ visible: !overlay.visible })'
                                    >
                                        <IconEyeOff
                                            :size='20'
                                            stroke='1'
                                        />
                                    </TablerIconButton>
                                </div>
                            </div>
                        </div>

                        <template v-if='!isDraggable && opened.has(overlay.id)'>
                            <div
                                v-if='overlay.type === "raster" && overlay.mode !== "basemap"'
                                class='col-12'
                                style='margin-left: 30px; padding-right: 40px;'
                            >
                                <TablerRange
                                    v-model='overlay.opacity'
                                    label='Opacity'
                                    :min='0'
                                    :max='1'
                                    :step='0.1'
                                    @change='overlay.update({
                                        opacity: overlay.opacity
                                    })'
                                />
                            </div>
                            <TreeCots
                                v-if='overlay.type === "geojson" && overlay.id === -1'
                                :element='overlay'
                            />
                            <TreeMission
                                v-if='overlay.mode === "mission"'
                                :overlay='overlay'
                            />
                            <TreeVector
                                v-if='overlay.type === "vector"'
                                :overlay='overlay'
                            />
                        </template>
                    </div>
                </div>
            </template>
        </template>
    </MenuTemplate>
</template>

<script setup lang='ts'>
import { ref, watch, useTemplateRef, computed } from 'vue';
import { useRouter } from 'vue-router';
import MenuTemplate from '../util/MenuTemplate.vue';
import {
    TablerDelete,
    TablerIconButton,
    TablerLoading,
    TablerRange
} from '@tak-ps/vue-tabler';
import TreeCots from './Overlays/TreeCots.vue';
import TreeVector from './Overlays/TreeVector.vue';
import TreeMission from './Overlays/TreeMission.vue';
import {
    IconGripVertical,
    IconAlertTriangle,
    IconChevronRight,
    IconChevronDown,
    IconReplace,
    IconMaximize,
    IconVector,
    IconStack,
    IconEyeOff,
    IconPencil,
    IconPencilCheck,
    IconPlus,
    IconEye,
    IconMap
} from '@tabler/icons-vue';
import Sortable from 'sortablejs';
import type { SortableEvent } from 'sortablejs'
import { useMapStore } from '../../../../src/stores/map.ts';

const mapStore = useMapStore();
const router = useRouter();

let sortable: Sortable;

const isDraggable = ref(false);
const loading = ref(false);
const opened = ref<Set<number>>(new Set());

const isLoaded = mapStore.isLoaded;
const overlays = mapStore.overlays;

const sortableRef = useTemplateRef<HTMLElement>('sortableRef');

// Sort overlays with CoT Icons always at top, then reverse order (highest pos first)
const sortedOverlays = computed(() => {
    const sorted = [...overlays].sort((a, b) => {
        // CoT Icons (id: -1) always goes first
        if (a.name === 'CoT Icons') return -1;
        if (b.name === 'CoT Icons') return 1;
        
        // For all other overlays, reverse the position order (highest pos first)
        return (b.pos || 0) - (a.pos || 0);
    });
    
    return sorted;
});

watch(isDraggable, () => {
    if (isDraggable.value && sortableRef.value) {
        sortable = new Sortable(sortableRef.value, {
            sort: true,
            handle: '.drag-handle',
            dataIdAttr: 'id',
            onEnd: saveOrder
        })
    } else {
        sortable.destroy()
    }
});

async function saveOrder(sortableEv: SortableEvent) {
    if (sortableEv.newIndex === undefined || isNaN(parseInt(String(sortableEv.newIndex)))) return;

    const id = sortableEv.item.getAttribute('id');
    if (!id) return;

    // Prevent moving CoT Icons from the top position
    const draggedOverlay = mapStore.getOverlayById(parseInt(id));
    if (draggedOverlay?.name === 'CoT Icons') {
        // Reset the sortable to original position
        sortable.sort(sortable.toArray());
        return;
    }

    // TODO: Eventually it would be awesome to just move the Overlay in the overlays array
    // And the MapStore would just dynamically re-order the layers so any part of the app could reorder

    const overlay_ids = sortable.toArray().map((i) => {
        return parseInt(i)
    });

    const overlay = mapStore.getOverlayById(parseInt(id))
    if (!overlay) throw new Error(`Could not find Overlay`);

    const post = mapStore.getOverlayById(overlay_ids[sortableEv.newIndex + 1]);

    for (const l of overlay.styles) {
        if (post) {
            mapStore.map.moveLayer(l.id, post.styles[0].id)
        } else {
            mapStore.map.moveLayer(l.id)
        }
    }

    // Since we're displaying in reverse order, we need to reverse the position assignment
    // Higher visual position = lower pos value in database
    const maxPos = Math.max(...overlays.filter(o => o.name !== 'CoT Icons').map(o => o.pos || 0));
    
    for (let i = 0; i < overlay_ids.length; i++) {
        const overlayToUpdate = mapStore.getOverlayById(overlay_ids[i]);
        if (overlayToUpdate && overlayToUpdate.name !== 'CoT Icons') {
            // Reverse the position: first item in visual list gets highest pos value
            const newPos = maxPos - i;
            await overlayToUpdate.update({ pos: newPos });
        }
    }
}

async function removeOverlay(id: number) {
    loading.value = true;
    for (const overlay of overlays) {
        if (overlay.id === id) {
            await mapStore.removeOverlay(overlay);
        }
    }
    loading.value = false;
}
</script>
