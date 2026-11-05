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
                v-if='!groupedSubscriptions.length'
                :create='false'
                label='No Mission Subscribers'
            />
            <div
                v-for='group of groupedSubscriptions'
                v-else
                :key='group.key'
                class='col-lg-12'
            >
                <Contact
                    :contact='toGroupContact(group)'
                    :button-chat='group.subs.length === 1'
                    :fly-to-click='group.subs.length === 1'
                    @chat='router.push(`/menu/chats/new?callsign=${$event.callsign}&uid=${$event.uid}`)'
                >
                    <template
                        v-if='canManageRoles'
                        #actions
                    >
                        <div class='d-flex align-items-center gap-2'>
                            <TablerIconButton
                                title='Edit User'
                                @click.stop='toggleEdit(group.key)'
                            >
                                <IconPencil
                                    :size='20'
                                    stroke='1'
                                />
                            </TablerIconButton>
                            <TablerDelete
                                v-if='group.subs.length === 1'
                                label='Remove User'
                                displaytype='icon'
                                :disabled='isLastOwnerClient(group.subs[0])'
                                @delete='removeClient(group.subs[0], group)'
                            />
                        </div>
                    </template>

                    <template
                        v-if='canManageRoles && editingKey === group.key'
                        #expanded
                    >
                        <div class='d-flex flex-column align-items-start gap-1'>
                            <select
                                class='form-select form-select-sm'
                                style='width: auto;'
                                :value='group.role'
                                @change='changeRole(group, $event.target as HTMLSelectElement)'
                            >
                                <option
                                    v-if='!group.role'
                                    value=''
                                    disabled
                                >
                                    Mixed roles
                                </option>
                                <option
                                    v-for='option of roleOptions'
                                    :key='option.value'
                                    :value='option.value'
                                    :disabled='!!roleDisabledReason(group, option.value)'
                                    :title='roleDisabledReason(group, option.value)'
                                >
                                    {{ option.label }}
                                </option>
                            </select>
                            <small
                                v-if='group.subs.length > 1'
                                class='text-secondary'
                                v-text='`Applies to all ${group.subs.length} clients of this user`'
                            />
                            <small
                                v-if='isLastOwnerUser(group)'
                                class='text-secondary'
                                v-text='"This is the only owner. Make someone else an owner before changing this role or removing the user"'
                            />
                            <small
                                v-else-if='lowerRolesBlockedReason'
                                class='text-secondary'
                                v-text='lowerRolesBlockedReason'
                            />
                        </div>
                    </template>
                </Contact>

                <div
                    v-if='group.subs.length > 1'
                    class='ms-4 ps-2 border-start'
                >
                    <Contact
                        v-for='sub of group.subs'
                        :key='sub.clientUid'
                        :contact='toClientContact(sub, group)'
                        :compact='true'
                        @chat='router.push(`/menu/chats/new?callsign=${$event.callsign}&uid=${$event.uid}`)'
                    >
                        <template
                            v-if='canManageRoles'
                            #actions
                        >
                            <TablerDelete
                                label='Remove Client'
                                displaytype='icon'
                                :disabled='isLastOwnerClient(sub)'
                                @delete='removeClient(sub, group)'
                            />
                        </template>
                    </Contact>
                </div>
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
const callsigns = ref<Map<string, string>>(new Map());
const clients = ref<Map<string, string>>(new Map());
const invites = ref<MissionInvite[]>([]);
const inviteUsername = ref('');
const showInvites = ref(false);
const editingKey = ref<string | null>(null);
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

// TAK Server lets the last owner demote or remove themselves, which leaves
// nobody able to manage the Data Sync, so the API refuses it and we grey it out
const ownerClientCount = computed(() => {
    return subscriptions.value.filter((sub) => sub.role.type === 'MISSION_OWNER').length;
});

const ownerKeys = computed(() => {
    return new Set(
        subscriptions.value
            .filter((sub) => sub.role.type === 'MISSION_OWNER')
            .map((sub) => sub.username || sub.clientUid)
    );
});

// Demoting a user changes all of their clients, so it removes the last owner
// when this is the only user with an owner client
function isLastOwnerUser(group: UserGroup): boolean {
    return ownerKeys.value.has(group.key) && ownerKeys.value.size <= 1;
}

// Removing a client only removes that client
function isLastOwnerClient(sub: MissionSubscriptions[number]): boolean {
    return sub.role.type === 'MISSION_OWNER' && ownerClientCount.value <= 1;
}

function roleDisabledReason(group: UserGroup, role: MissionRoleType): string | undefined {
    if (role === group.role) return undefined;

    if (role !== 'MISSION_OWNER' && isLastOwnerUser(group)) {
        return 'A Data Sync must keep at least one owner';
    }

    if (roleRank[role] > roleRank[props.subscription.role.type]) {
        return `Your own role can't grant ${roleLabel(role)}`;
    }

    if (roleFloor.value && roleRank[role] < roleRank[roleFloor.value]) {
        return `Below the default role (${roleLabel(roleFloor.value)}), only allowed on password protected Data Syncs`;
    }

    return undefined;
}

// One person can be subscribed from several clients, each with its own client UID
const groupedSubscriptions = computed<UserGroup[]>(() => {
    const groups = new Map<string, UserGroup>();

    for (const sub of subscriptions.value) {
        const key = sub.username || sub.clientUid;
        const group = groups.get(key);

        if (group) {
            group.subs.push(sub);
            if (group.role !== sub.role.type) group.role = '';
        } else {
            groups.set(key, { key, username: sub.username, subs: [sub], role: sub.role.type });
        }
    }

    const list = Array.from(groups.values());
    if (!filter.value) return list;

    const needle = filter.value.toLowerCase();
    return list.filter((group) => {
        return group.username.toLowerCase().includes(needle)
            || group.subs.some((sub) => (callsigns.value.get(sub.clientUid) || '').toLowerCase().includes(needle));
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

function toggleEdit(key: string) {
    editingKey.value = editingKey.value === key ? null : key;
}

async function removeClient(sub: MissionSubscriptions[number], group: UserGroup) {
    error.value = undefined;

    try {
        await props.subscription.removeUser(sub.clientUid);
        if (editingKey.value === group.key && group.subs.length <= 1) editingKey.value = null;
    } catch (err) {
        fail(err);
    }

    await fetchSubscriptions();
}

async function changeRole(group: UserGroup, select: HTMLSelectElement) {
    const role = select.value as MissionRoleType;
    if (!role || role === group.role) return;

    error.value = undefined;

    try {
        // With a username TAK Server changes every client of the user,
        // without one only the client that is given
        await props.subscription.changeRole({
            clientUid: group.subs[0].clientUid,
            username: group.username
        }, role);
    } catch (err) {
        // The list is unchanged so Vue will not reset what the user picked
        select.value = group.role;
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
    const nextCallsigns = new Map<string, string>();
    const nextClients = new Map<string, string>();

    // The current user is never stored as a contact, their team is a profile setting
    try {
        const selfUid = await mapStore.worker.profile.uid();
        const takGroup = (await ProfileConfig.get('tak_group'))?.value;

        if (typeof takGroup === 'string' && takGroup && subs.some((sub) => sub.clientUid === selfUid)) {
            next.set(selfUid, takGroup);
        }

        const takCallsign = (await ProfileConfig.get('tak_callsign'))?.value;
        if (typeof takCallsign === 'string' && takCallsign && subs.some((sub) => sub.clientUid === selfUid)) {
            nextCallsigns.set(selfUid, takCallsign);
        }
    } catch (err) {
        console.error(err);
    }

    await Promise.all(subs.map(async (sub) => {
        try {
            const contact = await ContactManager.from(sub.clientUid);
            if (!contact) return;
            if (contact.team && !next.has(sub.clientUid)) next.set(sub.clientUid, contact.team);
            if (contact.callsign && !nextCallsigns.has(sub.clientUid)) nextCallsigns.set(sub.clientUid, contact.callsign);
            if (contact.takv) nextClients.set(sub.clientUid, String(contact.takv));
        } catch (err) {
            console.error(err);
        }
    }));

    teams.value = next;
    callsigns.value = nextCallsigns;
    clients.value = nextClients;
}

// One person can be subscribed from several clients (each has its own client UID),
// so say which client a row is and when it joined to tell the rows apart
function clientLabel(sub: MissionSubscriptions[number]): string {
    if (sub.clientUid.includes('CloudTAK')) return 'CloudTAK';

    const takv = clients.value.get(sub.clientUid);
    if (takv) return takv;

    return `Client ${sub.clientUid.slice(-6)}`;
}

function joinedLabel(sub: MissionSubscriptions[number]): string {
    const date = new Date(sub.createTime);
    return isNaN(date.getTime()) ? '' : `joined ${date.toLocaleDateString()}`;
}

type UserGroup = {
    /** The TAK Server username, empty when the server did not record one */
    username: string;
    key: string;
    subs: MissionSubscriptions;
    /** Empty when the clients of the user have different roles */
    role: MissionRoleType | '';
};

function groupCallsign(group: UserGroup): string {
    for (const sub of group.subs) {
        const callsign = callsigns.value.get(sub.clientUid);
        if (callsign) return callsign;
    }

    return group.username || group.subs[0].clientUid;
}

function groupRoleLabel(group: UserGroup): string {
    return group.role ? roleLabel(group.role) : 'Mixed roles';
}

// The row of a user, or the only client of a user. Roles are changed per user
// (TAK Server changes every client of a username together) but chatting with
// and removing a client act on its client UID, so users with several clients
// get one row per client underneath.
function toGroupContact(group: UserGroup): ContactType {
    const callsign = groupCallsign(group);
    const single = group.subs.length === 1 ? group.subs[0] : undefined;

    return {
        uid: single ? single.clientUid : `user:${group.key}`,
        callsign,
        role: groupRoleLabel(group),
        notes: single
            ? [
                groupRoleLabel(group),
                group.username && callsign !== group.username ? group.username : '',
                clientLabel(single),
                joinedLabel(single),
            ].filter(Boolean).join(' · ')
            : [
                groupRoleLabel(group),
                group.username && callsign !== group.username ? group.username : '',
                `${group.subs.length} clients`,
            ].filter(Boolean).join(' · '),
        team: group.subs.map((sub) => teams.value.get(sub.clientUid)).find(Boolean) || '',
        takv: '',
        filterGroups: null
    };
}

function toClientContact(sub: MissionSubscriptions[number], group: UserGroup): ContactType {
    return {
        uid: sub.clientUid,
        callsign: callsigns.value.get(sub.clientUid) || group.username || sub.clientUid,
        role: roleLabel(sub.role.type),
        notes: [
            clientLabel(sub),
            joinedLabel(sub),
            group.role ? '' : roleLabel(sub.role.type),
        ].filter(Boolean).join(' · '),
        team: teams.value.get(sub.clientUid) || '',
        takv: '',
        filterGroups: null
    };
}
</script>
