<template>
    <div class='col-12'>
        <SlideDownHeader
            v-model='expanded'
            label='Author'
        >
            <template #icon>
                <IconUser
                    :size='18'
                    stroke='1'
                    color='#6b7990'
                    class='ms-2 me-1'
                />
            </template>

            <div class='mx-2 pt-2'>
                <CopyField :model-value='props.username' />
            </div>
        </SlideDownHeader>
    </div>
</template>

<script setup lang='ts'>
import { ref } from 'vue';
import CopyField from '../util/CopyField.vue';
import SlideDownHeader from '../util/SlideDownHeader.vue';
import {
    IconUser
} from '@tabler/icons-vue';

const props = defineProps<{
    username: string;
}>();

const expanded = ref(false);
</script>
