<template>
    <MenuTemplate
        :name='name'
        :loading='loading'
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
            <TablerLoading v-if='loading' />
            <div
                v-else
                class='col-12 d-flex flex-column'
                style='height: 100%; overflow: hidden;'
            >
                <div
                    ref='scrollContainer'
                    class='flex-grow-1'
                    style='min-height: 0; overflow-y: auto;'
                    @scroll='onScroll'
                >
                    <GenericSelect
                        ref='select'
                        role='menu'
                        :disabled='!multiselect'
                        :items='chats'
                    >
                        <template #buttons='{disabled}'>
                            <TablerDelete
                                :disabled='disabled'
                                displaytype='icon'
                                @delete='deleteChats'
                            />
                        </template>
                        <template #item='{item}'>
                            <div class='w-100 d-flex my-2 px-2'>
                                <div
                                    v-if='item.sender_uid !== id'
                                    class='bg-blue px-2 py-2 rounded'
                                >
                                    <div class='fw-bold small mb-1'>
                                        <span v-text='item.sender' />
                                    </div>
                                    <span v-text='item.message' />
                                </div>
                                <div
                                    v-else
                                    class='ms-auto bg-accent px-2 py-2 rounded'
                                >
                                    <div class='fw-bold small mb-1 text-end'>
                                        Me
                                    </div>
                                    <span v-text='item.message' />
                                </div>
                            </div>
                        </template>
                    </GenericSelect>
                </div>

                <div class='col-12 flex-shrink-0 border-top position-relative'>
                    <button
                        v-if='!atBottom'
                        class='position-absolute top-0 start-50 translate-middle btn btn-secondary btn-sm rounded-circle opacity-75'
                        style='z-index: 10;'
                        @click='scrollToBottom'
                    >
                        <IconArrowDown
                            :size='16'
                            stroke='2'
                        />
                    </button>
                    <div class='d-flex align-items-center mx-2 my-2'>
                        <div class='flex-grow-1 me-2'>
                            <TablerInput
                                v-model='message'
                                @keyup.enter='sendMessage'
                            />
                        </div>
                        <div>
                            <TablerIconButton
                                title='Send Message'
                                @click='sendMessage'
                            >
                                <IconSend
                                    :size='32'
                                    stroke='1'
                                />
                            </TablerIconButton>
                        </div>
                    </div>
                </div>
            </div>
        </template>
    </MenuTemplate>
</template>

<script setup>
import { ref, onMounted, shallowRef, watch, onUnmounted, nextTick } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Chatroom from '../../../base/chatroom.ts';
import GenericSelect from '../util/GenericSelect.vue';
import { liveQuery } from 'dexie';
import {
    IconListCheck,
    IconSend,
    IconArrowDown,
} from '@tabler/icons-vue';
import {
    TablerRefreshButton,
    TablerDelete,
    TablerIconButton,
    TablerInput,
    TablerLoading,
} from '@tak-ps/vue-tabler';
import MenuTemplate from '../util/MenuTemplate.vue';
import { useMapStore } from '../../../stores/map.ts';
const mapStore = useMapStore();

const route = useRoute();
const router = useRouter();

const id = ref('')
const callsign = ref('');
const loading = ref(true);
const select = ref(null);
const scrollContainer = ref(null);
const atBottom = ref(true);
const multiselect = ref(false);
const name = ref(route.params.chatroom === 'new' ? route.query.callsign : route.params.chatroom);
const room = shallowRef();

// Preserve recipient uid/callsign across the /new -> /:chatroom navigation.
// route.query.uid is only present on the /new route; once we navigate away it
// is lost, so we capture it into component state on mount.
const recipientUid = ref(route.query.uid ? String(route.query.uid) : '');
const recipientCallsign = ref(route.query.callsign ? String(route.query.callsign) : '');

const chats = ref([]);
let subscription;

watch([room, () => route.params.chatroom], ([newRoom]) => {
    if (subscription) {
        subscription.unsubscribe();
        subscription = null;
    }

    // Subscribe to liveQuery for both the /new route and named chatrooms so
    // that a sent message appears immediately without waiting for navigation.
    if (newRoom) {
        const obs = liveQuery(() => newRoom.chats.list());
        subscription = obs.subscribe({
            next: async (val) => {
                chats.value = val;
                if (atBottom.value) {
                    await nextTick();
                    scrollToBottom();
                }
            },
            error: (err) => {
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

const message = ref('');

onMounted(async () => {
    const profile = await mapStore.worker.profile.load();
    id.value = `ANDROID-CloudTAK-${profile.username}`
    callsign.value = profile.tak_callsign;

    room.value = new Chatroom(name.value);

    await fetchChats();
});

watch(() => route.params.chatroom, async (newChatroom) => {
    if (newChatroom === 'new') {
        name.value = route.query.callsign;
    } else {
        name.value = newChatroom;
    }
    room.value = new Chatroom(name.value);
    await fetchChats();
});

async function sendMessage() {
    if (!message.value.trim().length) return;
    if (!room.value) return;

    // Use the captured recipient state, which survives the /new -> /:chatroom
    // navigation. Fall back to route query params if state was not yet set
    // (e.g. component mounted directly on a named chatroom route).
    let recipient;
    const rUid = recipientUid.value || (route.query.uid ? String(route.query.uid) : '');
    const rCallsign = recipientCallsign.value || (route.query.callsign ? String(route.query.callsign) : '');
    if (rUid && rCallsign) {
        recipient = { uid: rUid, callsign: rCallsign };
    }

    try {
        await room.value.chats.send(
            message.value,
            { uid: id.value, callsign: callsign.value },
            mapStore.worker,
            recipient
        );
    } catch (err) {
        console.error('Failed to send chat message:', err);
        return;
    }

    message.value = ''

    if (route.params.chatroom === 'new') {
        await router.push({
            name: 'home-menu-chat',
            params: { chatroom: name.value }
        });
    }
}

async function deleteChats() {
    if (!select.value) return;
    if (!room.value) return;
    const selected = select.value.selected;

    loading.value = true;

    try {
        await room.value.deleteChats(Array.from(selected.values()));
    } catch (err) {
        loading.value = false;
        throw new Error(err.message);
    }

    await fetchChats();
}

async function fetchChats() {
    loading.value = true;

    if (route.params.chatroom !== 'new' && room.value) {
        try {
            await Chatroom.load(room.value.name, { reload: false });
            await room.value.chats.refresh();
        } catch (err) {
            console.error(err);
        }
    }

    loading.value = false;
}

function onScroll() {
    const el = scrollContainer.value;
    if (!el) return;
    atBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
}

function scrollToBottom() {
    const el = scrollContainer.value;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
}
</script>
