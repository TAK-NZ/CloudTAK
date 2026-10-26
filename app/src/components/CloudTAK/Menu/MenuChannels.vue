<template>
    <MenuTemplate name='Channels'>
        <template #buttons>
            <TablerIconButton
                v-if='channels.length && mapStore.hasNoChannels'
                title='All Channels On'
                @click='setAllStatus(true)'
            >
                <IconEyePlus
                    :size='32'
                    stroke='1'
                />
            </TablerIconButton>
            <TablerIconButton
                v-if='channels.length && !mapStore.hasNoChannels'
                title='All Channels Off'
                @click='setAllStatus(false)'
            >
                <IconEyeX
                    :size='32'
                    stroke='1'
                />
            </TablerIconButton>

            <TablerIconButton
                v-if='hasFolders && !isFiltering'
                :title='allExpanded ? "Collapse All Folders" : "Expand All Folders"'
                @click='allExpanded ? collapseAll() : expandAll()'
            >
                <component
                    :is='allExpanded ? IconChevronsUp : IconChevronsDown'
                    :size='32'
                    stroke='1'
                />
            </TablerIconButton>

            <TablerRefreshButton
                :loading='syncing'
                @click='refresh'
            />
        </template>
        <template #default>
            <div class='my-2'>
                <SearchSortFilter
                    v-model='paging.filter'
                    v-model:sort='sort'
                    :sort-options='sortOptions'
                    :active-filters='activeFilterCount'
                    placeholder='Filter'
                >
                    <template #sort-icon>
                        <component
                            :is='sortTypeIcon'
                            :size='20'
                            stroke='1'
                        />
                        <component
                            :is='sortDirectionIcon'
                            :size='20'
                            stroke='1'
                        />
                    </template>
                    <template #filters>
                        <div class='d-flex flex-column'>
                            <div class='d-flex align-items-center justify-content-between px-3 py-2'>
                                <strong class='small text-uppercase text-white-50'>Filters</strong>
                                <button
                                    v-if='activeFilterCount > 0'
                                    type='button'
                                    class='btn btn-link btn-sm p-0'
                                    @click='clearFilters'
                                >
                                    Clear
                                </button>
                            </div>
                            <div class='px-3 pb-2 d-flex flex-column gap-2'>
                                <div class='small text-uppercase text-white-50 mb-1'>
                                    Status
                                </div>
                                <label class='form-check mb-1'>
                                    <input
                                        class='form-check-input'
                                        type='checkbox'
                                        :checked='filterActive === true'
                                        @change='toggleStatusFilter(true)'
                                    >
                                    <span class='form-check-label'>Active</span>
                                </label>
                                <label class='form-check mb-1'>
                                    <input
                                        class='form-check-input'
                                        type='checkbox'
                                        :checked='filterActive === false'
                                        @change='toggleStatusFilter(false)'
                                    >
                                    <span class='form-check-label'>Inactive</span>
                                </label>
                            </div>
                        </div>
                    </template>
                </SearchSortFilter>
            </div>

            <EmptyInfo
                v-if='mapStore.hasNoChannels'
                :button='false'
            />

            <TablerNone
                v-if='!tree.length'
                :create='false'
            />
            <div
                v-else
                class='col-12 d-flex flex-column gap-2 py-3'
            >
                <ChannelTreeItem
                    v-for='node in tree'
                    :key='node.path'
                    :node='node'
                    :expanded='expanded'
                    :force-expanded='isFiltering'
                    @toggle-expand='toggleExpanded'
                    @toggle-channel='toggleChannel'
                    @toggle-folder='toggleFolder'
                />
            </div>
        </template>
    </MenuTemplate>
</template>

<script setup lang='ts'>
import { ref, computed, onMounted } from 'vue';
import type { Ref } from 'vue';
import { from } from 'rxjs';
import { useObservable } from '@vueuse/rxjs';
import type { GroupChannel } from '../../../../src/types.ts';
import GroupManager from '../../../base/group.ts';
import { server } from '../../../std.ts';
import {
    TablerNone,
    TablerIconButton,
    TablerRefreshButton,
} from '@tak-ps/vue-tabler';
import MenuTemplate from '../util/MenuTemplate.vue';
import SearchSortFilter from '../util/SearchSortFilter.vue';
import ChannelTreeItem from '../util/ChannelTreeItem.vue';
import EmptyInfo from '../util/EmptyInfo.vue';
import {
    CHANNEL_FOLDER_SEPARATOR,
    buildChannelTree,
    filterChannelTree,
    folderPaths,
} from '../../../utils/channel-tree.ts';
import {
    IconEyeX,
    IconEyePlus,
    IconLetterCase,
    IconArrowUp,
    IconArrowDown,
    IconChevronsDown,
    IconChevronsUp,
} from '@tabler/icons-vue';
import { useMapStore } from '../../../stores/map.ts';
const mapStore = useMapStore();

const syncing = ref(false);
const paging = ref({
    filter: ''
});

const sort = ref('A → Z');
const sortOptions = ['A → Z', 'Z → A'];
const sortTypeIcon = computed(() => IconLetterCase);
const sortDirectionIcon = computed(() => sort.value === 'A → Z' ? IconArrowUp : IconArrowDown);

const filterActive = ref<boolean | null>(null);
const activeFilterCount = computed(() => filterActive.value !== null ? 1 : 0);

function toggleStatusFilter(value: boolean): void {
    filterActive.value = filterActive.value === value ? null : value;
}

function clearFilters(): void {
    filterActive.value = null;
}

const channels = useObservable(
    from(GroupManager.liveList()),
    { initialValue: [] }
) as Ref<GroupChannel[]>;

// The server can override the separator (CHANNEL_FOLDER_SEPARATOR); until it
// answers, or if the request fails, the default is used
const separator = ref(CHANNEL_FOLDER_SEPARATOR);

async function loadSeparator(): Promise<void> {
    try {
        const { data } = await server.GET('/api/config/channels');
        if (data?.separator) separator.value = data.separator;
    } catch (err) {
        console.error('Failed to load the channel folder separator', err);
    }
}

onMounted(async () => {
    await Promise.all([refresh(), loadSeparator()]);
});

// Folders the user has opened, keyed by tree node path
const expanded = ref<Set<string>>(new Set());

// While filtering, every folder is shown open so the matches are visible
const isFiltering = computed(() => paging.value.filter !== '' || filterActive.value !== null);

const fullTree = computed(() => {
    // Plain copies: the observable list hands out reactive proxies that cannot be stored in the DB
    const copy: GroupChannel[] = JSON.parse(JSON.stringify(channels.value));

    return buildChannelTree(copy, {
        separator: separator.value,
        descending: sort.value === 'Z → A',
    });
});

const tree = computed(() => {
    const text = paging.value.filter.toLowerCase();

    return filterChannelTree(fullTree.value, (ch) => {
        if (!ch.name.toLowerCase().includes(text)) return false;
        if (filterActive.value !== null && ch.active !== filterActive.value) return false;
        return true;
    });
});

const allFolderPaths = computed(() => folderPaths(fullTree.value));
const hasFolders = computed(() => allFolderPaths.value.length > 0);
const allExpanded = computed(() => {
    return hasFolders.value && allFolderPaths.value.every((path) => expanded.value.has(path));
});

function toggleExpanded(path: string): void {
    const next = new Set(expanded.value);
    if (next.has(path)) {
        next.delete(path);
    } else {
        next.add(path);
    }
    expanded.value = next;
}

function expandAll(): void {
    expanded.value = new Set(allFolderPaths.value);
}

function collapseAll(): void {
    expanded.value = new Set();
}

async function refresh() {
    syncing.value = true;
    try {
        await GroupManager.sync();
    } finally {
        syncing.value = false;
    }
}

async function setAllStatus(active=true) {
    // Update UI state optimistically for immediate feedback while the API call is in flight
    const updates = channels.value.map((ch) => {
        const char = JSON.parse(JSON.stringify(ch));
        char.active = active;
        return char;
    });

    await GroupManager.put(updates);

    await mapStore.worker.profile.setAllChannels(active);
}

async function setStatus(channel: GroupChannel, active=false) {
    const update: GroupChannel = { ...channel, active };
    await GroupManager.put(update);

    await mapStore.worker.profile.setChannel(channel.name, active);
}

async function toggleChannel(channel: GroupChannel) {
    await setStatus(channel, !channel.active);
}

/**
 * Turn every channel in a folder on, or off if they are all already on
 */
async function toggleFolder(folderChannels: GroupChannel[]) {
    const active = !folderChannels.every((ch) => ch.active !== false);

    const names = folderChannels.map((ch) => ch.name);
    const updates = folderChannels.map((ch) => ({ ...ch, active }));

    await GroupManager.put(updates);

    await mapStore.worker.profile.setChannels(names, active);
}
</script>
