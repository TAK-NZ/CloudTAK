<template>
    <MenuTemplate
        :name='name'
        :loading='loading'
        :scroll='false'
    >
        <template #buttons>
            <TablerIconButton
                title='Select Chats'
                @click='multiselect = !multiselect'
            >
                <IconListCheck
                    :size='32'
                    stroke='1'
                />
            </TablerIconButton>
            <TablerRefreshButton
                :loading='loading'
                @click='fetchChats'
            />
        </template>
        <template #default>
            <GenericChat
                :chats='chats'
                :my-u-i-d='id'
                :loading='loading'
                :can-send='true'
                :can-delete='true'
                :multiselect='multiselect'
                placeholder='Send Message...'
                @send='sendMessage'
                @delete='deleteChats'
                @at-bottom='onAtBottom'
            />
        </template>
    </MenuTemplate>
</template>

<script setup lang="ts">
import { ref, onMounted, shallowRef, watch, onUnmounted, nextTick } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Chatroom from '../../../base/chatroom.ts';
import { liveQuery, type Subscription } from 'dexie';
import type { DBChatroomChat } from '../../../database.ts';
import { IconListCheck } from '@tabler/icons-vue';
import {
    TablerRefreshButton,
    TablerIconButton,
} from '@tak-ps/vue-tabler';
import MenuTemplate from '../util/MenuTemplate.vue';
import GenericChat from '../util/GenericChat.vue';
import { useMapStore } from '../../../stores/map.ts';
import ProfileConfig from '../../../base/profile.ts';

const mapStore = useMapStore();
const atBottom = ref(true);

function normalizeRouteParam(param: string | string[]): string {
    return Array.isArray(param) ? (param[0] ?? '') : param;
}

function normalizeRouteQuery(query: string | null | (string | null)[]): string {
    if (Array.isArray(query)) return query[0] ?? '';
    return query ?? '';
}

function onAtBottom(isAtBottom: boolean): void {
    atBottom.value = isAtBottom;

    if (isAtBottom) {
        void room.value?.chats.markRead();
    }
}

const route = useRoute();
const router = useRouter();

const id = ref('');
const callsign = ref('');
const loading = ref(true);
const multiselect = ref(false);

const initialName = route.params.chatroom === 'new'
    ? normalizeRouteQuery(route.query.callsign)
    : normalizeRouteParam(route.params.chatroom);
const name = ref<string>(initialName);
const room = shallowRef<Chatroom | undefined>(undefined);

const chats = ref<DBChatroomChat[]>([]);
let subscription: Subscription | undefined;

// Set just before navigating from the /new route to the named chatroom
// route right after sending the first message. The route-param watcher
// below always calls fetchChats() on navigation, but a network refresh()
// at that moment can pull back a stale server-side "updated" timestamp
// for the chatroom (the just-sent message may not have echoed back from
// TAK Server yet), rolling back the optimistic local state set by send().
// Consumed and reset by the watcher on the next chatroom-param change.
let skipNextRefresh = false;

watch([room, () => route.params.chatroom], ([newRoom]) => {
    if (subscription) {
        subscription.unsubscribe();
        subscription = undefined;
    }

    // Key off the resolved chatroom name, not the literal 'new' URL segment.
    // '/menu/chats/new?callsign=...' is only a routing convention for
    // "resolve the name from query params instead of the route param" — it
    // does not mean no conversation history exists yet. Contacts with prior
    // history are routed here too (e.g. from the contacts list), so gating
    // on the URL segment instead of newRoom.name showed an empty chat until
    // the user navigated away and back via the named route.
    if (newRoom && newRoom.name) {
        const obs = liveQuery(() => newRoom.chats.list());
        subscription = obs.subscribe({
            next: async (val) => {
                chats.value = val;
                if (atBottom.value) {
                    await nextTick();
                    await newRoom.chats.markRead();
                }
            },
            error: (err: unknown) => {
                console.error(err);
            }
        });
    } else {
        chats.value = [];
    }
}, { immediate: true });

onUnmounted(() => {
    if (subscription) subscription.unsubscribe();
});

onMounted(async () => {
    const username = (await ProfileConfig.get('username'))?.value;
    const tak_callsign = (await ProfileConfig.get('tak_callsign'))?.value;

    if (!username) {
        throw new Error('Username not set in profile config');
    }

    id.value = `ANDROID-CloudTAK-${username}`;
    callsign.value = String(tak_callsign ?? '');

    room.value = new Chatroom(name.value);

    await fetchChats();
});

watch(() => route.params.chatroom, async (newChatroom) => {
    if (newChatroom === 'new') {
        name.value = normalizeRouteQuery(route.query.callsign);
    } else {
        name.value = normalizeRouteParam(newChatroom);
    }
    room.value = new Chatroom(name.value);

    const skipRefresh = skipNextRefresh;
    skipNextRefresh = false;
    await fetchChats({ skipRefresh });
});

async function sendMessage(message: string): Promise<void> {
    if (!message.trim().length) return;
    if (!room.value) return;

    let recipient: { uid: string; callsign: string } | undefined;
    if (route.query.uid && route.query.callsign) {
        recipient = {
            uid: normalizeRouteQuery(route.query.uid),
            callsign: normalizeRouteQuery(route.query.callsign)
        };
    }

    await room.value.chats.send(
        message,
        { uid: id.value, callsign: callsign.value },
        mapStore.worker,
        recipient
    );

    if (route.params.chatroom === 'new') {
        skipNextRefresh = true;
        await router.push({
            name: 'home-menu-chat',
            params: { chatroom: name.value }
        });
    }
}

async function deleteChats(ids: Array<string | number>): Promise<void> {
    if (!room.value || !ids.length) return;

    loading.value = true;

    try {
        await room.value.deleteChats(ids.map(String));
    } catch (err) {
        loading.value = false;
        throw new Error(err instanceof Error ? err.message : String(err), { cause: err });
    }

    await fetchChats();
}

async function fetchChats(opts: { skipRefresh?: boolean } = {}): Promise<void> {
    loading.value = true;

    // Same reasoning as the watcher above: gate on the resolved chatroom
    // name, not the literal 'new' URL segment, so existing history loads
    // even when arriving via /menu/chats/new?callsign=....
    if (room.value?.name && !opts.skipRefresh) {
        try {
            await Chatroom.load(room.value.name, { reload: false });
            await room.value.chats.refresh();
        } catch (err) {
            console.error(err);
        }
    }

    loading.value = false;

    if (atBottom.value) {
        await nextTick();
        await room.value?.chats.markRead();
    }
}


</script>
