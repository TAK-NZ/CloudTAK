<template>
    <StandardItem
        :id='String(card.overlay.id)'
        class='p-3'
        :class='{
            "border-primary": isDraggable && draggable
        }'
        :hover='!isDraggable && card.overlay.id !== 0 && hasOverlayDetails(card.overlay)'
        @click='handleClick'
        @keydown.enter.prevent='handleClick'
        @keydown.space.prevent='handleClick'
    >
        <div
            class='d-flex justify-content-between gap-3'
        >
            <div
                class='d-flex align-items-center gap-2 flex-grow-1 w-100 overflow-hidden'
                :aria-disabled='isDraggable || card.overlay.id === 0'
            >
                <span
                    v-if='isDraggable && draggable'
                    title='Drag to reorder'
                >
                    <IconGripVertical
                        class='drag-handle cursor-move text-white-50'
                        role='button'
                        tabindex='0'
                        :size='20'
                        stroke='1'
                    />
                </span>
                <span
                    v-else-if='isDraggable && !draggable'
                    :title='lockedTitle'
                >
                    <IconLock
                        class='text-white-50'
                        :size='20'
                        stroke='1'
                    />
                </span>
                <span
                    v-if='card.overlay.type === "raster"'
                    class='flex-shrink-0 text-white-50'
                    title='Raster'
                >
                    <IconMap
                        :size='20'
                        stroke='1'
                    />
                </span>
                <span
                    v-else-if='card.overlay.type === "raster-dem"'
                    class='flex-shrink-0 text-white-50'
                    title='Terrain'
                >
                    <IconMap
                        :size='20'
                        stroke='1'
                    />
                </span>
                <span
                    v-else-if='card.overlay.type === "geojson" && card.overlay.mode === "mission"'
                    class='flex-shrink-0 text-white-50'
                    title='Data Sync'
                >
                    <IconCloudPin
                        :size='20'
                        stroke='1'
                    />
                </span>
                <span
                    v-else
                    class='flex-shrink-0 text-white-50'
                    title='Vector'
                >
                    <IconVector
                        :size='20'
                        stroke='1'
                    />
                </span>

                <div class='flex-grow-1 w-100 overflow-hidden'>
                    <div class='d-flex align-items-center gap-2 w-100'>
                        <div class='d-flex align-items-center flex-grow-1 w-100'>
                            <a
                                v-if='card.overlay.mode === "mission"'
                                class='fw-semibold text-decoration-underline d-inline-flex align-items-center text-break'
                                @click.stop='router.push(`/menu/missions/${card.overlay.mode_id}`)'
                                v-text='card.overlay.name'
                            />
                            <span
                                v-else
                                class='fw-semibold d-inline-flex align-items-center flex-grow-1 text-break'
                                v-text='card.overlay.name'
                            />
                        </div>
                    </div>
                    <div
                        v-if='card.badges.length || card.offline'
                        class='d-flex flex-wrap align-items-center gap-2 mt-2'
                    >
                        <span
                            v-for='badge in card.badges'
                            :key='`${card.overlay.id}-${badge.label}`'
                            class='badge rounded-pill'
                            :class='`text-bg-${badge.variant}`'
                        >
                            {{ badge.label }}
                        </span>
                        <TablerBadge
                            v-if='card.offline'
                            class='small'
                            background-color='rgba(32, 107, 196, 0.15)'
                            border-color='rgba(32, 107, 196, 0.35)'
                            text-color='#206bc4'
                            title='Tiles are available offline on this device'
                        >
                            Offline
                        </TablerBadge>
                    </div>
                </div>
            </div>

            <div
                style='min-width: 100px;'
                class='d-flex flex-column align-items-end gap-2'
            >
                <span
                    class='badge rounded-pill'
                    :class='`text-bg-${card.status.variant}`'
                    :title='card.status.tooltip || ""'
                >
                    {{ card.status.label }}
                </span>

                <div class='d-flex align-items-center gap-2 flex-wrap justify-content-end w-100'>
                    <TablerIconButton
                        v-if='card.overlay.hasBounds()'
                        title='Zoom To Overlay'
                        @click.stop.prevent='card.overlay.zoomTo()'
                    >
                        <IconMaximize
                            :size='20'
                            stroke='1'
                        />
                    </TablerIconButton>

                    <TablerIconButton
                        v-if='card.visible'
                        title='Hide Layer'
                        @click.stop.prevent='$emit("update:visible", !card.visible)'
                    >
                        <IconEye
                            :size='20'
                            stroke='1'
                        />
                    </TablerIconButton>

                    <TablerIconButton
                        v-else
                        title='Show Layer'
                        @click.stop.prevent='$emit("update:visible", !card.visible)'
                    >
                        <IconEyeOff
                            :size='20'
                            stroke='1'
                        />
                    </TablerIconButton>

                    <TablerDelete
                        v-if='["mission", "data", "profile", "overlay"].includes(card.overlay.mode)'
                        :key='card.overlay.id'
                        title='Delete Overlay'
                        :size='20'
                        role='button'
                        tabindex='0'
                        displaytype='icon'
                        @delete='$emit("remove")'
                    />
                </div>
            </div>
        </div>

        <div
            v-if='!isDraggable && isOpened && hasOverlayDetails(card.overlay)'
            class='mt-3 p-3 rounded-3 border border-white border-opacity-10 bg-black bg-opacity-25'
            @click.stop
        >
            <div
                v-if='card.overlay.type === "raster"'
                class='mb-3'
            >
                <TablerRange
                    :model-value='card.overlay.opacity'
                    label='Opacity'
                    :min='0'
                    :max='1'
                    :step='0.1'
                    @update:model-value='$emit("update:opacity", $event)'
                />
            </div>
            <TreeVector
                v-if='card.overlay.type === "vector"'
                :overlay='card.overlay'
            />
        </div>
    </StandardItem>
</template>

<script setup lang='ts'>
import { useRouter } from 'vue-router';
import {
    TablerBadge,
    TablerDelete,
    TablerIconButton,
    TablerRange
} from '@tak-ps/vue-tabler';
import TreeVector from './TreeVector.vue';
import {
    IconGripVertical,
    IconCloudPin,
    IconMaximize,
    IconVector,
    IconEyeOff,
    IconEye,
    IconLock,
    IconMap
} from '@tabler/icons-vue';
import StandardItem from '../../util/StandardItem.vue';
import { hasOverlayDetails } from './overlay-card.ts';
import type { OverlayCard } from './overlay-card.ts';

const props = defineProps<{
    card: OverlayCard;
    isDraggable: boolean;
    /** Whether this specific card may be dragged to reorder. False pins it in place (e.g. basemap, Map Features). */
    draggable: boolean;
    isOpened: boolean;
    lockedTitle?: string;
}>();

const emit = defineEmits<{
    (e: 'toggle-open'): void;
    (e: 'update:visible', value: boolean): void;
    (e: 'update:opacity', value: number): void;
    (e: 'remove'): void;
}>();

const router = useRouter();

function handleClick() {
    if (props.isDraggable) return;
    if (props.card.overlay.id === 0) return;
    if (!hasOverlayDetails(props.card.overlay)) return;
    emit('toggle-open');
}
</script>
