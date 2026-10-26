<template>
    <PropertyFactRow
        label='Author'
        class='py-1'
    >
        <span
            class='d-block text-truncate'
            :title='props.username'
            v-text='props.username'
        />
    </PropertyFactRow>
</template>

<script setup lang='ts'>
// TAK.NZ: identifies the author by username rather than assuming it is an email
// address (Authentik usernames need not be one), so no mailto: link.
import PropertyFactRow from '../util/PropertyFactRow.vue';

const props = defineProps<{
    username: string;
}>();
</script>
