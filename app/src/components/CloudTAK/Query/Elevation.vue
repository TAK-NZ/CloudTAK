<template>
    <div class='col-12 row g-0'>
        <div class='col-12'>
            <label class='subheader mx-2'>Elevation</label>
        </div>
        <TablerLoading
            v-if='loading'
            desc='Loading elevation...'
        />
        <TablerAlert
            v-else-if='error'
            :err='error'
        />
        <div
            v-else-if='elevation'
            class='col-12 d-flex align-items-center py-2 px-2 rounded'
            style='border: 1px solid var(--tblr-border-color);'
        >
            <IconMountain
                size='32'
                stroke='1'
            />
            <div class='mx-2'>
                <div
                    class='h3 mb-0'
                    v-text='elevation'
                />
            </div>
        </div>
        <div
            v-else
            class='col-12 d-flex py-2 px-2'
        >
            <div
                class='mx-2'
                style='font-size: 20px;'
            >
                No Elevation Data
            </div>
        </div>
    </div>
</template>

<script setup lang='ts'>
import { ref, onMounted } from 'vue';
import type { SearchReverseElevation } from '../../../types.ts';
import { server } from '../../../std.ts';
import {
    IconMountain
} from '@tabler/icons-vue';
import {
    TablerLoading,
    TablerAlert
} from '@tak-ps/vue-tabler';

const props = defineProps<{
    longitude: number;
    latitude: number;
}>();

const loading = ref(true);
const error = ref<Error | undefined>();
const elevation = ref<SearchReverseElevation['elevation']>(null);

// Elevation is looked up server-side by decoding the configured terrain
// basemap's raster-dem tile directly (see api/lib/terrain.ts). This
// deliberately avoids MapLibre GL's queryTerrainElevation(), which only
// returns a value once 3D terrain rendering (map.setTerrain()) is active -
// a GPU-heavy mode not otherwise needed for a one-off lookup, and unreliable
// on constrained hardware.
onMounted(async () => {
    try {
        const { data, error: reqError } = await server.GET('/api/search/reverse/{:longitude}/{:latitude}/elevation', {
            params: {
                path: { ':longitude': props.longitude, ':latitude': props.latitude },
            },
        });

        if (reqError) throw new Error(String(reqError));
        elevation.value = data.elevation;
    } catch (err) {
        error.value = err instanceof Error ? err : new Error(String(err));
    } finally {
        loading.value = false;
    }
});
</script>
