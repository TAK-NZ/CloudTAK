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
                class='d-flex flex-column h-100 overflow-hidden'
            >
                <div
                    ref='scrollContainer'
                    class='flex-grow-1 position-relative'
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
                                        <span v-text='item.sender || "Unknown"' />
                                    </div>
                                    <div v-text='item.message' />
                                    <div
                                        class='text-end'
                                        style='font-size: 0.75rem; opacity: 0.75;'
                                        v-text='formatTime(item.created)'
                                    />
                                </div>
                                <div
                                    v-else
                                    class='ms-auto bg-accent px-2 py-2 rounded'
                                >
                                    <div v-text='item.message' />
                                    <div
                                        class='text-end'
                                        style='font-size: 0.75rem; opacity: 0.75;'
                                        v-text='formatTime(item.created)'
                                    />
                                </div>
                            </div>
                        </template>
                    </GenericSelect>
                </div>

                <div class='flex-shrink-0 border-top position-relative pt-1'>
                    <button
                        v-if='chats.length && !atBottom'
                        class='btn btn-primary rounded-circle position-absolute start-50 p-1 scroll-bottom-btn'
                        style='z-index: 10; top: -56px; width: 44px; height: 44px;'
                        title='Scroll to bottom'
                        @click='scrollToBottom'
                    >
                        <IconArrowDown
                            :size='24'
                            stroke='2.5'
                        />
                    </button>
                    <div class='d-flex align-items-center mx-2 mb-2 mt-1'>
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
const name = ref(route.params.chatroom === 'new' ? String(route.query.callsign || '') : String(route.params.chatroom || ''));
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
                    if (room.value?.chats?.markRead) await room.value.chats.markRead();
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
        name.value = String(route.query.callsign || '');
    } else {
        name.value = String(newChatroom || '');
    }
    room.value = new Chatroom(name.value);
    await fetchChats({ skipRefresh: history.state?.skipRefresh });
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
            params: { chatroom: name.value },
            state: { skipRefresh: true }
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

async function fetchChats(opts = {}) {
    loading.value = true;

    if (route.params.chatroom !== 'new' && room.value && !opts.skipRefresh) {
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
    const wasAtBottom = atBottom.value;
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
    atBottom.value = isAtBottom;
    if (!wasAtBottom && isAtBottom && room.value?.chats?.markRead) {
        room.value.chats.markRead();
    }
}

function scrollToBottom() {
    const el = scrollContainer.value;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    atBottom.value = true;
    if (room.value?.chats?.markRead) {
        room.value.chats.markRead();
    }
}
function formatTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const month = d.toLocaleString('default', { month: 'short' });
    const day = d.getDate();
    const hour = String(d.getHours()).padStart(2, '0');
    const minute = String(d.getMinutes()).padStart(2, '0');
    return `${month} ${day}, ${hour}:${minute}`;
}
</script>

<style scoped>
@keyframes float {
    0% { transform: translateX(-50%) translateY(0); }
    50% { transform: translateX(-50%) translateY(-6px); }
    100% { transform: translateX(-50%) translateY(0); }
}

.scroll-bottom-btn {
    opacity: 0.9;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25) !important;
    animation: float 2.5s ease-in-out infinite;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: opacity 0.2s ease, background-color 0.2s ease;
}

.scroll-bottom-btn:hover {
    opacity: 1;
    background-color: var(--bs-primary-dark, #0b5ed7);
    animation: none;
    transform: translateX(-50%) translateY(0);
}
</style>
