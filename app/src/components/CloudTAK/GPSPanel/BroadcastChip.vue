<template>
    <div
        v-if='mode'
        class='broadcast-chip cloudtak-panel d-flex align-items-center gap-2'
        :class='mode === "paused" ? "broadcast-chip-paused" : "broadcast-chip-standby"'
        :data-test='`broadcast-chip-${mode}`'
        @click.stop
    >
        <span
            class='flex-grow-1 text-truncate'
            data-test='broadcast-chip-text'
            :title='text'
            v-text='text'
        />
        <button
            type='button'
            class='btn btn-sm flex-shrink-0 broadcast-chip-action'
            :class='mode === "paused" ? "btn-warning" : "btn-info"'
            :disabled='disabled'
            :title='disabledReason'
            data-test='broadcast-chip-action'
            @click.stop='act'
        >
            <span
                v-if='claiming'
                class='spinner-border spinner-border-sm me-1 broadcast-chip-spinner'
                role='status'
                data-test='broadcast-chip-pending'
            />
            {{ mode === 'paused' ? 'Resume' : 'Take over' }}
        </button>
    </div>
</template>

<script setup lang='ts'>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { LocationState } from '../../../utils/events.ts';
import { useMapStore } from '../../../stores/map.ts';
import { useSharingStore } from '../../../stores/sharing.ts';
import { broadcastChipMode } from '../../../utils/broadcast-chip.ts';

const mapStore = useMapStore();
const sharing = useSharingStore();

const mode = computed(() => broadcastChipMode(sharing));

const text = computed(() => {
    if (mode.value === 'paused') return 'Paused \u00b7 not connected';
    return sharing.standbyBy ? `Shared from ${sharing.standbyBy}` : 'Shared from another device';
});

// A session with no position has nothing to broadcast, so taking over would only
// leave the map without the user. Asking for a location first avoids that
const hasPosition = computed(() => {
    return mapStore.location === LocationState.Live || mapStore.location === LocationState.Preset;
});

// A Take over is answered by the server's next status message. Until then the button
// shows it is working, and it gives up waiting after a while in case no answer comes
const CLAIM_TIMEOUT_MS = 10000;
const claiming = ref(false);
let claimTimer: ReturnType<typeof setTimeout> | undefined;

watch(() => sharing.standbyBy, () => {
    claiming.value = false;
    clearTimeout(claimTimer);
});
watch(mode, () => {
    claiming.value = false;
    clearTimeout(claimTimer);
});
onBeforeUnmount(() => clearTimeout(claimTimer));

const disabled = computed(() => {
    if (sharing.busy || claiming.value) return true;
    return mode.value === 'standby' && !hasPosition.value;
});

const disabledReason = computed(() => {
    if (mode.value === 'standby' && !hasPosition.value) return 'Set your location first';
    return undefined;
});

async function act(): Promise<void> {
    if (disabled.value) return;
    if (mode.value === 'paused') await sharing.resume();
    else {
        claiming.value = true;
        clearTimeout(claimTimer);
        claimTimer = setTimeout(() => { claiming.value = false; }, CLAIM_TIMEOUT_MS);
        await sharing.takeOver();
    }
}
</script>

<style scoped>
.broadcast-chip {
    position: absolute;
    left: 0;
    bottom: calc(100% + 6px);
    width: 100%;
    padding: 0.2rem 0.3rem 0.2rem 0.6rem;
    font-size: 0.75rem;
    line-height: 1.2;
    border: 1px solid transparent;
    border-radius: 8px;
}

.broadcast-chip-standby {
    border-color: var(--tblr-info, #4dabf7);
}

.broadcast-chip-paused {
    border-color: var(--tblr-warning, #f59f00);
}

.broadcast-chip-action {
    padding: 0.1rem 0.5rem;
    font-size: 0.75rem;
}

.broadcast-chip-spinner {
    width: 0.7rem;
    height: 0.7rem;
    border-width: 1.5px;
}
</style>
