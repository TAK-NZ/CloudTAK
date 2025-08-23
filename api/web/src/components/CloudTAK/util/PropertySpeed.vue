<template>
    <div class='col-12'>
        <IconBrandSpeedtest
            :size='18'
            stroke='1'
            color='#6b7990'
            class='ms-2 me-1'
        />
        <label class='subheader user-select-none'>Speed</label>
        <div class='mx-2'>
            <CopyField
                v-model='inMode'
                :size='24'
            />
            <span
                v-tooltip='"Kilometers Per Hour"'
                class='my-1 px-2 user-select-none'
                :class='{
                    "bg-gray-500 rounded-bottom text-blue": mode === "km/h",
                    "cursor-pointer": mode !== "km/h",
                }'
                role='menuitem'
                tabindex='0'
                @keyup.enter='mode = "km/h"'
                @click='mode = "km/h"'
            >KM/H</span>
            <span
                v-tooltip='"Miles Per Hour"'
                class='my-1 px-2 user-select-none'
                :class='{
                    "bg-gray-500 rounded-bottom text-blue": mode === "mi/h",
                    "cursor-pointer": mode !== "mi/h",
                }'
                role='menuitem'
                tabindex='0'
                @keyup.enter='mode = "mi/h"'
                @click='mode = "mi/h"'
            >MPH</span>
            <span
                v-tooltip='"Meters Per Second"'
                class='my-1 px-2 user-select-none'
                :class='{
                    "bg-gray-500 rounded-bottom text-blue": mode === "m/s",
                    "cursor-pointer": mode !== "m/s",
                }'
                role='menuitem'
                tabindex='0'
                @keyup.enter='mode = "m/s"'
                @click='mode = "m/s"'
            >M/S</span>
        </div>
    </div>
</template>

<script setup lang='ts'>
import { ref, computed, watch } from 'vue';
import CopyField from './CopyField.vue';
import {
    IconBrandSpeedtest
} from '@tabler/icons-vue';

const props = defineProps({
    speed: {
        type: Number,
        required: true
    },
    unit: {
        type: String,
        default: 'mi/h'
    }
});

const mode = ref(props.unit);

// Watch for prop changes and update mode accordingly
watch(() => props.unit, (newUnit) => {
    mode.value = newUnit;
});

const inMode = computed(() => {
    if (mode.value === 'm/s') return Math.round(props.speed * 1000) / 1000;
    else if (mode.value === 'mi/h') return Math.round(props.speed * 2.23694 * 100) / 100;
    else if (mode.value === 'km/h') return Math.round(props.speed * 3.6 * 100) / 100;
    return 'UNKNOWN';
});
</script>
