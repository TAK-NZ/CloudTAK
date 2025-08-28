<template>
    <div class='col-12'>
        <IconPolygon
            :size='18'
            stroke='1'
            color='#6b7990'
            class='ms-2 me-1'
        />
        <label class='subheader user-select-none'>Polygon Area</label>
        <div class='mx-2'>
            <CopyField
                v-model='inMode'
                :size='24'
            />
            <span
                v-tooltip='"Square Meters"'
                class='my-1 px-2 user-select-none text-blue'
                :class='{
                    "bg-gray-500 rounded-bottom": mode === "sqmeter",
                    "cursor-pointer": mode !== "sqmeter",
                }'
                role='menuitem'
                tabindex='0'
                @keyup.enter='mode = "sqmeter"'
                @click='mode = "sqmeter"'
            >m<sup>2</sup></span>
            <span
                v-tooltip='"Square Kilometers"'
                class='my-1 px-2 user-select-none text-blue'
                :class='{
                    "bg-gray-500 rounded-bottom": mode === "sqkm",
                    "cursor-pointer": mode !== "sqkm",
                }'
                role='menuitem'
                tabindex='0'
                @keyup.enter='mode = "sqkm"'
                @click='mode = "sqkm"'
            >km<sup>2</sup></span>
            <span
                v-tooltip='"Hectares"'
                class='my-1 px-2 user-select-none text-blue'
                :class='{
                    "bg-gray-500 rounded-bottom": mode === "ha",
                    "cursor-pointer": mode !== "ha",
                }'
                role='menuitem'
                tabindex='0'
                @keyup.enter='mode = "ha"'
                @click='mode = "ha"'
            >ha</span>
            <span
                v-tooltip='"Square Feet"'
                class='my-1 px-2 user-select-none text-blue'
                :class='{
                    "bg-gray-500 rounded-bottom": mode === "sqfeet",
                    "cursor-pointer": mode !== "sqfeet",
                }'
                role='menuitem'
                tabindex='0'
                @keyup.enter='mode = "sqfeet"'
                @click='mode = "sqfeet"'
            >ft<sup>2</sup></span>
            <span
                v-tooltip='"Square Miles"'
                class='my-1 px-2 user-select-none text-blue'
                :class='{
                    "bg-gray-500 rounded-bottom": mode === "sqmiles",
                    "cursor-pointer": mode !== "sqmiles",
                }'
                role='menuitem'
                tabindex='0'
                @keyup.enter='mode = "sqmiles"'
                @click='mode = "sqmiles"'
            >mi<sup>2</sup></span>
            <span
                v-tooltip='"Acres"'
                class='my-1 px-2 user-select-none text-blue'
                :class='{
                    "bg-gray-500 rounded-bottom": mode === "acre",
                    "cursor-pointer": mode !== "acre",
                }'
                role='menuitem'
                tabindex='0'
                @keyup.enter='mode = "acre"'
                @click='mode = "acre"'
            >ac</span>
        </div>
    </div>
</template>

<script setup lang='ts'>
import { ref, computed, watch } from 'vue';
import { area } from '@turf/area';
import CopyField from './CopyField.vue';
import COT from '../../../base/cot.ts';
import {
    IconPolygon
} from '@tabler/icons-vue';

const props = defineProps({
    cot: {
        type: COT,
        required: true
    },
    unit: {
        type: String,
        default: 'sqmeter'
    }
})

const mode = ref(props.unit || 'sqmeter');

// Watch for prop changes and update mode accordingly
watch(() => props.unit, (newUnit) => {
    mode.value = newUnit || 'sqmeter';
});

const inMode = computed(() => {
    const cotArea = area(props.cot.geometry);

    if (mode.value === 'sqmeter') {
        return cotArea;
    } else if (mode.value === 'sqkm') {
        return cotArea * 0.000001;
    } else if (mode.value === 'ha') {
        return cotArea * 0.0001;
    } else if (mode.value === 'sqfeet') {
        return cotArea * 10.7639;
    } else if (mode.value === 'sqmiles') {
        return cotArea * 3.861e-7;
    } else if (mode.value === 'acre') {
        return cotArea * 0.000247105;
    } else {
        return 'UNKNOWN';
    }
})
</script>
