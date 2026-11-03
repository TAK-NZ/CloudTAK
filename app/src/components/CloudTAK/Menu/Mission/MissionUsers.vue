<template>
    <MenuTemplate
        name='Mission Subscribers'
        :back='false'
        :border='false'
        :loading='loading'
        :standalone='false'
    >
        <template #buttons>
            <TablerDropdown
                v-if='canInvite'
            >
                <TablerIconButton
                    title='Invite User'
                >
                    <IconPlus
                        :size='32'
                        stroke='1'
                    />
                </TablerIconButton>
                <template #dropdown>
                    <div
                        class='px-2 py-2'
                        style='min-width: 250px;'
                    >
                        <span class='strong'>Invite User</span>
                        <UserClientSelect
                            v-model='inviteUsername'
                            :input='true'
                            placeholder='Username'
                            :groups='typeof subscription.meta.groups === "string" ? [subscription.meta.groups] : subscription.meta.groups'
                            :exclude-uids='excludedUids'
                            :exclude-callsigns='invitedCallsigns'
                            @click.stop
                            @select='inviteUser($event)'
                        />
                        <button
                            class='btn btn-primary w-100 mt-2'
                            :disabled='!inviteUsername'
                            @click.stop='inviteUser()'
                        >
                            Invite
                        </button>
                    </div>
                </template>
            </TablerDropdown>
        </template>

        <div
            v-if='error'
            class='col-12 px-2 py-2'
        >
            <TablerAlert :err='error' />
        </div>

        <div class='col-12 px-2 py-2'>
            <TablerInput
                v-model='filter'
                icon='search'
                placeholder='Filter'
            />
        </div>

        <Offline v-if='isOffline' />
        <template v-else>
            <div
                v-if='invites.length'
                class='col-12 px-2 py-2'
            >
                <StandardItem
                    class='d-flex flex-column px-2 py-2'
                    @click='showInvites = !showInvites'
                >
                    <div class='d-flex align-items-center gap-2'>
                        <IconMail
                            :size='24'
                            stroke='1'
                        />
                        <span class='fw-bold'>Pending Invites</span>
                        <TablerBadge
                            class='rounded-pill small ms-auto'
                            background-color='var(--tblr-red-lt)'
                            border-color='var(--tblr-red)'
                            text-color='var(--tblr-red)'
                        >
                            {{ invites.length }}
                        </TablerBadge>
                        <IconChevronDown
                            v-if='!showInvites'
                            :size='20'
                            stroke='1'
                            class='ms-2'
                        />
                        <IconChevronUp
                            v-else
                            :size='20'
                            stroke='1'
                            class='ms-2'
                        />
                    </div>

                    <transition name='menu-overlays-fade'>
                        <div
                            v-if='showInvites'
                            class='mt-2 pt-2 px-3 rounded-3 border cloudtak-accent'
                            @click.stop
                        >
                            <div
                                v-for='invite in invites'
                                :key='invite.invitee'
                                class='d-flex align-items-center justify-content-between mb-2'
                            >
                                <div class='d-flex flex-column'>
                                    <div v-text='invite.invitee' />
                                    <div
                                        class='small text-muted'
                                        v-text='invite.role ? invite.role.name : "Unknown Role"'
                                    />
                                </div>
                                <TablerDelete
                                    label='Revoke Invite'
                                    displaytype='icon'
                                    @delete='removeInvite(invite)'
                                />
                            </div>
                        </div>
                    </transition>
                </StandardItem>
            </div>

            <TablerNone
                v-if='!filteredSubscriptions.length'
                :create='false'
                label='No Mission Subscribers'
            />
            <div
                v-for='sub of filteredSubscriptions'
                v-else
                :key='sub.clientUid'
                class='col-lg-12'
            >
                <Contact
                    :contact='toContact(sub)'
                    @chat='router.push(`/menu/chats/new?callsign=${$event.callsign}&uid=${$event.uid}`)'
                >
                    <template
                        v-if='canManageRoles'
                        #actions
                    >
                        <div class='d-flex align-items-center gap-2'>
                            <TablerIconButton
                                title='Edit User'
                                @click.stop='toggleEdit(sub.clientUid)'
                            >
                                <IconPencil
                                    :size='20'
                                    stroke='1'
                                />
                            </TablerIconButton>
                            <TablerDelete
                                label='Remove User'
                                displaytype='icon'
                                @delete='removeUser(sub)'
                            />
                        </div>
                    </template>

                    <template
                        v-if='canManageRoles && editingUid === sub.clientUid'
                        #expanded
                    >
                        <div class='d-flex flex-column align-items-start gap-1'>
                            <select
                                class='form-select form-select-sm'
                                style='width: auto;'
                                :value='sub.role.type'
                                @change='changeRole(sub, $event.target as HTMLSelectElement)'
                            >
                                <option
                                    v-for='option of roleOptions'
                                    :key='option.value'
                                    :value='option.value'
                                    :disabled='!!roleDisabledReason(sub, option.value)'
                                    :title='roleDisabledReason(sub, option.value)'
                                >
                                    {{ option.label }}
                                </option>
                            </select>
                            <small
                                v-if='lowerRolesBlockedReason'
                                class='text-secondary'
                                v-text='lowerRolesBlockedReason'
                            />
                        </div>
                    </template>
                </Contact>
            </div>
        </template>
    </MenuTemplate>
</template>

<script setup lang='ts'>
import { ref, onMounted, computed } from 'vue';
import { useRouter } from 'vue-router';
import { TablerAlert, TablerBadge, TablerNone, TablerInput, TablerDropdown, TablerIconButton, TablerDelete } from '@tak-ps/vue-tabler';
import { IconPlus, IconMail, IconChevronDown, IconChevronUp, IconPencil } from '@tabler/icons-vue';
import type { MissionSubscriptions, Contact as ContactType, MissionInvite, MissionRoleType } from '../../../../types.ts';
import Subscription from '../../../../base/subscription.ts';
import ContactManager from '../../../../base/contact.ts';
import ProfileConfig from '../../../../base/profile.ts';
import { useMapStore } from '../../../../stores/map.ts';
import MenuTemplate from '../../util/MenuTemplate.vue';
import StandardItem from '../../util/StandardItem.vue';
import UserClientSelect from '../../util/UserClientSelect.vue';
import Contact from '../../util/Contact.vue';
import Offline from '../../../util/Offline.vue';
import { useDeviceStore } from '../../../../stores/device.ts';

const props = defineProps<{
    subscription: Subscription
}>();

const router = useRouter();
const deviceStore = useDeviceStore();
const mapStore = useMapStore();
const loading = ref(false);
const filter = ref('');
const subscriptions = ref<MissionSubscriptions>([])
const teams = ref<Map<string, string>>(new Map());
const invites = ref<MissionInvite[]>([]);
const inviteUsername = ref('');
const showInvites = ref(false);
const editingUid = ref<string | null>(null);
const error = ref<Error | undefined>(undefined);

function fail(err: unknown): void {
    error.value = err instanceof Error ? err : new Error(String(err));
}

const roleOptions: Array<{ value: MissionRoleType, label: string }> = [
    { value: 'MISSION_OWNER', label: 'Owner' },
    { value: 'MISSION_SUBSCRIBER', label: 'Subscriber' },
    { value: 'MISSION_READONLY_SUBSCRIBER', label: 'Read Only' },
];

const roleRank: Record<MissionRoleType, number> = {
    MISSION_READONLY_SUBSCRIBER: 0,
    MISSION_SUBSCRIBER: 1,
    MISSION_OWNER: 2,
};

function roleLabel(role: MissionRoleType): string {
    return roleOptions.find((option) => option.value === role)?.label || role;
}

const isOffline = computed(() => !deviceStore.network.isOnline);

const canInvite = computed(() => {
    if (!props.subscription.role) return false;
    return props.subscription.role.type === 'MISSION_OWNER'
        || props.subscription.role.permissions.includes('MISSION_WRITE');
});

const canManageRoles = computed(() => {
    if (!props.subscription.role) return false;
    return props.subscription.role.type === 'MISSION_OWNER'
        || props.subscription.role.permissions.includes('MISSION_SET_ROLE');
});

// TAK Server refuses to assign a role below the default role of a Mission,
// unless the Mission is password protected
const roleFloor = computed<MissionRoleType | undefined>(() => {
    if (props.subscription.meta.passwordProtected) return undefined;
    return props.subscription.meta.defaultRole?.type;
});

const lowerRolesBlockedReason = computed(() => {
    if (!roleFloor.value || roleRank[roleFloor.value] === 0) return undefined;
    return `Roles below ${roleLabel(roleFloor.value)} (the default role) can't be assigned unless the Data Sync is password protected or its default role is lowered`;
});

function roleDisabledReason(sub: MissionSubscriptions[number], role: MissionRoleType): string | undefined {
    if (role === sub.role.type) return undefined;

    if (roleRank[role] > roleRank[props.subscription.role.type]) {
        return `Your own role can't grant ${roleLabel(role)}`;
    }

    if (roleFloor.value && roleRank[role] < roleRank[roleFloor.value]) {
        return `Below the default role (${roleLabel(roleFloor.value)}), only allowed on password protected Data Syncs`;
    }

    return undefined;
}

const filteredSubscriptions = computed(() => {
    if (!filter.value) return subscriptions.value;
    return subscriptions.value.filter(sub => {
        return sub.username.toLowerCase().includes(filter.value.toLowerCase());
    });
});

onMounted(async () => {
    await fetchSubscriptions();
});

// Members and pending invites cannot be invited again, TAK Server answers with a bare 500
const excludedUids = computed<string[]>(() => {
    return [
        ...subscriptions.value.map((sub) => sub.clientUid),
        ...invites.value
            .filter((invite) => invite.type === 'clientUid' && invite.invitee)
            .map((invite) => String(invite.invitee)),
    ];
});

const invitedCallsigns = computed<string[]>(() => {
    return invites.value
        .filter((invite) => (invite.type === 'callsign' || !invite.type) && invite.invitee)
        .map((invite) => String(invite.invitee));
});

async function inviteUser(selection?: { callsign: string } | ContactType) {
    const invitee = selection ? selection.callsign : inviteUsername.value;
    if (!invitee) return;

    error.value = undefined;

    if (invitedCallsigns.value.some((callsign) => callsign.toLowerCase() === invitee.toLowerCase())) {
        fail(new Error(`${invitee} has already been invited`));
        return;
    }

    try {
        await props.subscription.invite(invitee);
        inviteUsername.value = '';
    } catch (err) {
        fail(err);
    }

    await fetchSubscriptions();
}

function toggleEdit(clientUid: string) {
    editingUid.value = editingUid.value === clientUid ? null : clientUid;
}

async function removeUser(sub: MissionSubscriptions[number]) {
    error.value = undefined;

    try {
        await props.subscription.removeUser(sub.clientUid);
        if (editingUid.value === sub.clientUid) editingUid.value = null;
    } catch (err) {
        fail(err);
    }

    await fetchSubscriptions();
}

async function changeRole(sub: MissionSubscriptions[number], select: HTMLSelectElement) {
    const role = select.value as MissionRoleType;
    if (role === sub.role.type) return;

    error.value = undefined;

    try {
        await props.subscription.changeRole(sub, role);
    } catch (err) {
        // The list is unchanged so Vue will not reset what the user picked
        select.value = sub.role.type;
        fail(err);
    }

    await fetchSubscriptions();
}

async function removeInvite(invite: MissionInvite) {
    if (!invite.invitee) return;
    await props.subscription.deleteInvite({
        type: invite.type || 'callsign',
        invitee: invite.invitee
    });
    await fetchSubscriptions();
}

async function fetchSubscriptions() {
    if (isOffline.value) return;
    loading.value = true;
    try {
        subscriptions.value = await props.subscription.subscriptions();
        await loadTeams(subscriptions.value);
        if (canInvite.value) {
            invites.value = await props.subscription.invites();
        }
    } catch (err) {
        console.error(err);
    } finally {
        loading.value = false;
    }
}

// The subscriptions API does not return a team, so look it up from the local
// contact records (populated from CoT presence markers), keyed by client UID.
async function loadTeams(subs: MissionSubscriptions) {
    const next = new Map<string, string>();

    // The current user is never stored as a contact, their team is a profile setting
    try {
        const selfUid = await mapStore.worker.profile.uid();
        const takGroup = (await ProfileConfig.get('tak_group'))?.value;

        if (typeof takGroup === 'string' && takGroup && subs.some((sub) => sub.clientUid === selfUid)) {
            next.set(selfUid, takGroup);
        }
    } catch (err) {
        console.error(err);
    }

    await Promise.all(subs.map(async (sub) => {
        if (next.has(sub.clientUid)) return;

        try {
            const contact = await ContactManager.from(sub.clientUid);
            if (contact && contact.team) next.set(sub.clientUid, contact.team);
        } catch (err) {
            console.error(err);
        }
    }));

    teams.value = next;
}

function toContact(sub: MissionSubscriptions[number]): ContactType {
    return {
        uid: sub.clientUid,
        callsign: sub.username,
        role: roleLabel(sub.role.type),
        notes: roleLabel(sub.role.type),
        team: teams.value.get(sub.clientUid) || '',
        takv: '',
        filterGroups: null
    };
}
</script>
