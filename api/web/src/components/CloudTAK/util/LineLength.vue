<template>
    <div class='col-12'>
        <label class='subheader mx-2'>Line Length</label>
        <div class='mx-2'>
            <CopyField
                v-model='inMode'
                :size='24'
            />
            <span
                v-tooltip='"Meters"'
                class='my-1 px-2 user-select-none'
                :class='{
                    "bg-gray-500 rounded-bottom text-blue": mode === "meter",
                    "cursor-pointer": mode !== "meter",
                }'
                role='menuitem'
                tabindex='0'
                @keyup.enter='mode = "meter"'
                @click='mode = "meter"'
            >Meters</span>
            <span
                v-tooltip='"Kilometers"'
                class='my-1 px-2 user-select-none'
                :class='{
                    "bg-gray-500 rounded-bottom text-blue": mode === "kilometer",
                    "cursor-pointer": mode !== "kilometer",
                }'
                role='menuitem'
                tabindex='0'
                @keyup.enter='mode = "kilometer"'
                @click='mode = "kilometer"'
            >Kilometers</span>
            <span
                v-tooltip='"Miles"'
                class='my-1 px-2 user-select-none'
                :class='{
                    "bg-gray-500 rounded-bottom text-blue": mode === "mile",
                    "cursor-pointer": mode !== "mile",
                }'
                role='menuitem'
                tabindex='0'
                @keyup.enter='mode = "mile"'
                @click='mode = "mile"'
            >Miles</span>
        </div>
    </div>
</template>

<script setup lang='ts'>
import { ref, computed, watch } from 'vue';
import { length } from '@turf/length';
import CopyField from './CopyField.vue';
import COT from '../../../base/cot.ts';

const props = defineProps({
    cot: {
        type: COT,
        required: true
    },
    unit: {
        type: String,
        default: 'mile'
    }
})

const mode = ref(props.unit === 'kilometer' ? 'kilometer' : props.unit === 'meter' ? 'meter' : 'mile');

// Watch for prop changes and update mode accordingly
watch(() => props.unit, (newUnit) => {
    mode.value = newUnit === 'kilometer' ? 'kilometer' : newUnit === 'meter' ? 'meter' : 'mile';
});

const inMode = computed(() => {
    if (props.cot.geometry.type !== 'LineString') return 'Not a Line!';

    const cotLength = length(props.cot.as_feature());

    if (mode.value === 'meter') {
        return cotLength * 1000;
    } else if (mode.value === 'kilometer') {
        return cotLength;
    } else if (mode.value === 'mile') {
        return cotLength * 0.621371;
    } else {
        return 'UNKNOWN';
    }
})
</script>
