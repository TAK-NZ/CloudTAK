<template>
    <div class='col-12'>
        <IconMountain
            :size='18'
            stroke='1'
            color='#6b7990'
            class='ms-2 me-1'
        />
        <label
            class='subheader user-select-none'
            v-text='props.label'
        />
        <div class='mx-2'>
            <CopyField
                v-model='inMode'
                :size='24'
            />
            <div
                class='mx-2'
                role='menu'
            >
                <span
                    class='my-1 px-2 user-select-none'
                    :class='{
                        "cloudtak-accent rounded-bottom text-blue": mode === "feet",
                        "cursor-pointer": mode !== "feet",
                    }'
                    title='Feet'
                    role='menuitem'
                    tabindex='0'
                    @keyup.enter='mode = "feet"'
                    @click='mode = "feet"'
                >Feet</span>
                <span
                    class='my-1 px-2 user-select-none'
                    :class='{
                        "cloudtak-accent rounded-bottom text-blue": mode === "meter",
                        "cursor-pointer": mode !== "meter",
                    }'
                    title='Meters'
                    role='menuitem'
                    tabindex='0'
                    @keyup.enter='mode = "meter"'
                    @click='mode = "meter"'
                >Meters</span>
            </div>
        </div>
    </div>
</template>

<script setup lang='ts'>
import { ref, computed, watch, onMounted } from 'vue';
import CopyField from '../util/CopyField.vue';
import ProfileConfig from '../../../base/profile.ts';
import {
    IconMountain
} from '@tabler/icons-vue';

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
