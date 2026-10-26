<template>
    <PropertyMeasureRow
        :label='label'
        :model-value='inMode'
        :unit='mode'
        :units='UNITS'
        @update:unit='mode = $event'
    />
</template>

<script setup lang='ts'>
import { ref, computed, watch, onMounted } from 'vue';
import PropertyMeasureRow from '../util/PropertyMeasureRow.vue';
import type { UnitOption } from '../util/UnitSwitcher.vue';
import ProfileConfig from '../../../base/profile.ts';

const UNITS: Array<UnitOption> = [
    { value: 'feet', label: 'ft', title: 'Feet' },
    { value: 'meter', label: 'm', title: 'Meters' },
];

const props = defineProps({
    label: {
        type: String,
        default: 'Elevation'
    },
    elevation: {
        type: Number,
        required: true
    },
    unit: {
        type: String,
        default: 'feet'
    }
})

const mode = ref(props.unit);

onMounted(async () => {
    const displayElevation = await ProfileConfig.get('display_elevation');
    if (displayElevation?.value) mode.value = displayElevation.value;
});

watch(mode, async (val) => {
    const config = new ProfileConfig('display_elevation', val as 'feet' | 'meter');
    await config.commit(val as 'feet' | 'meter');
});

// The CoT spec (and TAK clients such as ATAK) use 9999999 as a sentinel HAE
// value meaning "altitude unknown" - see e.g.
// https://github.com/NERVsystems/cotlib/blob/dd034749ceddb8b62c39125016767e211bf2095f/cotlib.go#L599
// It is a legitimate, present number, not null/NaN, so it has to be checked
// for explicitly rather than relying on a falsy/missing check. Mirror ATAK
// and show "--" instead of the raw sentinel or a nonsensical unit conversion
// of it (e.g. ~32.8 million feet).
const UNKNOWN_ELEVATION = 9999999;

const inMode = computed(() => {
    if (!Number.isFinite(props.elevation) || props.elevation === UNKNOWN_ELEVATION) {
        return '--';
    } else if (mode.value === 'feet') {
        return Math.round(props.elevation * 3.28084 * 100) / 100;
    } else if (mode.value === 'meter') {
        return Math.round(props.elevation * 100) / 100;
    } else {
        return 'UNKNOWN';
    }
})
</script>
