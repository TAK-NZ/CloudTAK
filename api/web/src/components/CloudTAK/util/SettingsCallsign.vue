<template>
    <TablerLoading v-if='loading || !profile' />
    <template v-else>
        <div class='col-12 d-flex flex-column gap-2 py-2'>
            <TablerInput
                v-model='search'
                icon='search'
                placeholder='Search settings...'
            />

            <div class='d-flex flex-column gap-2'>
                <StandardItem
                    v-for='item of filteredSettings'
                    :key='item.key'
                    :hover='false'
                    class='position-relative'
                >
                    <Transition name='saved-fade'>
                        <div
                            v-if='savedKey === item.key'
                            class='saved-indicator position-absolute d-flex align-items-center gap-1'
                        >
                            <IconCircleCheck
                                :size='16'
                                stroke='1.5'
                                class='text-success'
                            />
                            <span class='text-success small fw-medium'>Saved</span>
                        </div>
                    </Transition>
                    <div class='d-flex flex-column gap-2 px-3 py-3'>
                        <div class='d-flex align-items-center gap-3'>
                            <div
                                class='d-flex align-items-center justify-content-center rounded-circle bg-black bg-opacity-25 flex-shrink-0'
                                style='width: 40px; height: 40px;'
                            >
                                <component
                                    :is='item.icon'
                                    :size='24'
                                    stroke='1.5'
                                />
                            </div>
                            <div class='fw-bold text-white'>
                                {{ item.label }}
                            </div>
                        </div>
                        <div class='col-12'>
                            <TablerInput
                                v-if='item.type === "input"'
                                v-model='(profile as any)[item.key]'
                                :disabled='item.locked'
                                :error='item.key === "tak_callsign" && !item.locked ? validateTextNotEmpty(profile.tak_callsign) : ""'
                                :required='item.key === "tak_callsign"'
                            />
                            <TablerEnum
                                v-else-if='item.type === "enum"'
                                v-model='(profile as any)[item.key]'
                                :disabled='item.locked'
                                :options='item.options'
                            />
                            <CoordinateType
                                v-else-if='item.type === "coordinate"'
                                v-model='profile.tak_type'
                                :size='24'
                            />
                        </div>
                        <div
                            v-if='item.locked'
                            class='d-flex align-items-center gap-1 text-secondary'
                        >
                            <IconLock
                                :size='14'
                                stroke='1.5'
                            />
                            <span class='small'>Managed by your single sign-on account and cannot be changed here</span>
                        </div>
                        <div
                            v-if='item.type === "input" && !item.locked && hasChanged(item.key)'
                            class='d-flex justify-content-end'
                        >
                            <button
                                class='btn btn-primary btn-sm'
                                :disabled='item.key === "tak_callsign" && !!validateTextNotEmpty(profile.tak_callsign)'
                                @click='saveField(item.key)'
                            >
                                Save
                            </button>
                        </div>
                    </div>
                </StandardItem>

                <div
                    v-if='filteredSettings.length === 0'
                    class='text-center text-secondary py-4'
                >
                    No settings match "{{ search }}"
                </div>
            </div>
        </div>
    </template>
</template>

<script setup lang='ts'>
import { ref, computed, onMounted, watch } from 'vue';
import type { Component } from 'vue';
import {
    IconUser,
    IconUsers,
    IconShield,
    IconClock,
    IconMapPin,
    IconCircleCheck,
    IconLock,
} from '@tabler/icons-vue';
import CoordinateType from './CoordinateType.vue';
import StandardItem from './StandardItem.vue';
import type { Profile } from '../../../../src/types.ts';
import Config from '../../../base/config.ts';
import type { FullConfig } from '../../../base/config.ts';
import {
    TablerInput,
    TablerEnum,
    TablerLoading
} from '@tak-ps/vue-tabler';
import { validateTextNotEmpty } from '../../../base/validators.ts';
import { useMapStore } from '../../../stores/map.ts';
import ProfileConfig from '../../../base/profile.ts';
const mapStore = useMapStore();

const props = defineProps({
    mode: {
        type: String,
        default: 'router'
    },
    forceCallsign: {
        type: Boolean,
        default: false
    }
})

const emit = defineEmits([ 'update' ]);

type SettingItem = {
    key: string;
    label: string;
    icon: Component;
    type: 'input' | 'enum' | 'coordinate';
    options?: string[];
    routerOnly?: boolean;
    /** Owned by the identity provider - rendered read-only and never saved */
    locked?: boolean;
};

const loading = ref(true);
const profile = ref<Profile | undefined>();
const groups = ref<Record<string, string>>({});
/**
 * Fields the IdP supplies (and re-applies on every login), reported by the API as
 * `tak_*_locked` on the profile. Editing them locally would be silently reverted,
 * so the inputs are disabled and both save paths skip them.
 */
const locked = ref<Record<string, boolean>>({});
const search = ref('');
const savedKey = ref<string | undefined>();
const changedFields = ref<Set<string>>(new Set());
let previousValues: Record<string, unknown> = {};
let saveTimeout: ReturnType<typeof setTimeout> | undefined;

const roles = ['Team Member', 'Team Lead', 'HQ', 'Sniper', 'Medic', 'Forward Observer', 'RTO', 'K9'];

const tak_groups = computed(() => {
    const result = [];
    for (const g in groups.value) {
        if (groups.value[g]) {
            result.push(`${g} - ${groups.value[g]}`);
        } else {
            result.push(g);
        }
    }

    return result;
});

const settings = computed<SettingItem[]>(() => {
    const items: SettingItem[] = [
        {
            key: 'tak_callsign',
            label: 'User Callsign',
            icon: IconUser,
            type: 'input',
            locked: locked.value.tak_callsign,
        },
        {
            key: 'tak_group',
            label: 'User Group',
            icon: IconUsers,
            type: 'enum',
            options: tak_groups.value,
            locked: locked.value.tak_group,
        },
        {
            key: 'tak_role',
            label: 'User Role',
            icon: IconShield,
            type: 'enum',
            options: roles,
            locked: locked.value.tak_role,
        },
        {
            key: 'tak_loc_freq',
            label: 'Location Reporting Frequency (ms)',
            icon: IconClock,
            type: 'input',
            routerOnly: true,
        },
        {
            key: 'tak_type',
            label: 'Default Point Type',
            icon: IconMapPin,
            type: 'coordinate',
        },
    ];

    return items.filter(item => !item.routerOnly || props.mode === 'router');
});

const filteredSettings = computed(() => {
    const query = search.value.trim().toLowerCase();
    if (!query) return settings.value;
    return settings.value.filter((item) =>
        item.label.toLowerCase().includes(query)
    );
});

function hasChanged(key: string): boolean {
    return changedFields.value.has(key);
}

onMounted(async () => {
    loading.value = true;
    await fetchConfig();

    // Refresh the cached profile before reading it. ProfileConfig.sync() is a no-op
    // once the local store is populated, so without forcing it a session that
    // predates the lock flags (or whose IdP attributes changed on a later login)
    // would render the fields as editable when they are not.
    await ProfileConfig.sync({ refresh: true });

    locked.value = {
        tak_callsign: Boolean((await ProfileConfig.get('tak_callsign_locked'))?.value),
        tak_group: Boolean((await ProfileConfig.get('tak_group_locked'))?.value),
        tak_role: Boolean((await ProfileConfig.get('tak_role_locked'))?.value),
    };

    const p = {
        tak_callsign: (await ProfileConfig.get('tak_callsign'))?.value,
        tak_group: (await ProfileConfig.get('tak_group'))?.value,
        tak_role: (await ProfileConfig.get('tak_role'))?.value,
        tak_type: (await ProfileConfig.get('tak_type'))?.value,
        tak_loc_freq: (await ProfileConfig.get('tak_loc_freq'))?.value
    } as Profile;

    if (p.tak_group && groups.value[p.tak_group]) {
        // @ts-expect-error We expect an enum of Colors
        p.tak_group = `${p.tak_group} - ${groups.value[p.tak_group]}`;
    }

    // The welcome wizard blanks the callsign to force the user to enter one. Skip
    // that when the IdP owns it, otherwise the wizard would demand a value the user
    // has no way to save and the Done button would never enable.
    if (props.forceCallsign && !locked.value.tak_callsign) {
        p.tak_callsign = '';
    }

    profile.value = p;

    // Snapshot initial values
    for (const item of settings.value) {
        previousValues[item.key] = (profile.value as Profile)[item.key as keyof Profile];
    }

    loading.value = false;

    // The welcome wizard gates its Done button on a tak_callsign update event. A
    // locked callsign can never emit one, so report it as already satisfied.
    if (props.mode === 'emit' && locked.value.tak_callsign) {
        emit('update', 'tak_callsign');
    }
});

const groupKeys: (keyof FullConfig)[] = [
    'group::Yellow',
    'group::Cyan',
    'group::Green',
    'group::Red',
    'group::Purple',
    'group::Orange',
    'group::Blue',
    'group::Magenta',
    'group::White',
    'group::Maroon',
    'group::Dark Blue',
    'group::Teal',
    'group::Dark Green',
    'group::Brown',
];

async function fetchConfig() {
    const config = await Config.list(groupKeys);
    const result: Record<string, string> = {};
    for (const key of groupKeys) {
        const val = config[key];
        result[key.replace('group::', '')] = val ? String(val) : '';
    }
    groups.value = result;
}

async function saveField(key: string) {
    if (!profile.value) return;
    if (locked.value[key]) return;

    const p = JSON.parse(JSON.stringify(profile.value)) as Profile;
    p.tak_group = p.tak_group.replace(/\s-\s.*$/, '') as Profile["tak_group"];

    await mapStore.worker.profile.update({
        [key]: (p as Profile)[key as keyof Profile]
    });

    if (key === 'tak_type') {
        mapStore.defaultPointType = p.tak_type || 'u-d-p';
    }

    // Show saved indicator
    savedKey.value = key;
    changedFields.value.delete(key);
    previousValues[key] = (profile.value as Profile)[key as keyof Profile];

    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
        savedKey.value = undefined;
    }, 2000);

    if (props.mode === 'emit') {
        emit('update', key);
    }
}

// Watch for changes to auto-save non-input fields
watch(
    () => profile.value,
    async (newProfile) => {
        if (!newProfile || loading.value) return;

        // Detect which fields changed
        for (const item of settings.value) {
            // IdP-managed fields are never persisted from here. The inputs are
            // disabled, but this also covers programmatic mutation (e.g. the
            // tak_group display-label rewrite) reaching the auto-save branch.
            if (item.locked) continue;

            const current = (newProfile as Profile)[item.key as keyof Profile];
            if (current !== previousValues[item.key]) {
                if (item.type === 'input') {
                    // Track changed state for input fields (manual save)
                    changedFields.value.add(item.key);
                } else {
                    // Auto-save non-input fields
                    savedKey.value = item.key;

                    const p = JSON.parse(JSON.stringify(newProfile)) as Profile;
                    p.tak_group = p.tak_group.replace(/\s-\s.*$/, '') as Profile["tak_group"];

                    await mapStore.worker.profile.update({
                        [item.key]: (p as Profile)[item.key as keyof Profile]
                    });

                    if (item.key === 'tak_type') {
                        mapStore.defaultPointType = p.tak_type || 'u-d-p';
                    }

                    previousValues[item.key] = current;

                    if (saveTimeout) clearTimeout(saveTimeout);
                    saveTimeout = setTimeout(() => {
                        savedKey.value = undefined;
                    }, 2000);
                }
            }
        }
    },
    { deep: true }
);
</script>

<style scoped>
.saved-indicator {
    top: 10px;
    right: 12px;
    z-index: 1;
}

.saved-fade-enter-active {
    transition: opacity 0.2s ease-in;
}

.saved-fade-leave-active {
    transition: opacity 1.4s ease-out;
}

.saved-fade-enter-from,
.saved-fade-leave-to {
    opacity: 0;
}

.saved-fade-enter-to,
.saved-fade-leave-from {
    opacity: 1;
}
</style>
