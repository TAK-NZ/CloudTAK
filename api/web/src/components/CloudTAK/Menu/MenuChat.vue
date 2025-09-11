<template>
    <MenuTemplate
        :name='name'
        :loading='loading'
    >
        <template #buttons>
            <TablerRefreshButton
                :loading='loading'
                @click='fetchChats'
            />
        </template>
        <template #default>
            <!-- Messages Section -->
            <div class='messages-container' style='padding-bottom: 120px;'>
                <div
                    v-for='chat in chats.items'
                    :key='chat.message_id || chat.message'
                    class='col-12 d-flex my-2 px-2'
                >
                    <div
                        v-if='chat.sender_uid !== id'
                        class='bg-blue px-2 py-2 rounded'
                    >
                        <span v-text='chat.message' />
                    </div>
                    <div
                        v-else
                        class='ms-auto bg-gray-400 px-2 py-2 rounded'
                    >
                        <span v-text='chat.message' />
                    </div>
                </div>
            </div>

            <!-- Compose Section -->
            <div class='compose-container border-top border-blue position-absolute start-0 bottom-0 end-0'>
                <div class='row mx-2 mt-2'>
                    <div class='col-12'>
                        <TablerInput
                            v-model='message'
                            @keyup.enter='sendMessage'
                        />
                    </div>
                    <div class='col-12 my-2'>
                        <button
                            class='w-100 btn btn-primary'
                            @click='sendMessage'
                        >
                            Send
                        </button>
                    </div>
                </div>
            </div>
        </template>
    </MenuTemplate>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { useRoute } from 'vue-router';
import { std } from '../../../std.ts';
import {
    TablerRefreshButton,
    TablerInput,
} from '@tak-ps/vue-tabler';
import MenuTemplate from '../util/MenuTemplate.vue';
import { useMapStore } from '../../../stores/map.ts';
const mapStore = useMapStore();

const route = useRoute();

const id = ref('')
const callsign = ref('');
const loading = ref(true);
const name = ref(route.params.chatroom === 'new' ? route.query.callsign : route.params.chatroom);
const chats = ref({
    total: 0,
    items: []
});

const message = ref('');
let refreshInterval;

onMounted(async () => {
    const profile = await mapStore.worker.profile.load();
    id.value = await mapStore.worker.profile.uid()
    callsign.value = profile.tak_callsign;

    await fetchChats();
    
    // Start automatic refresh every 3 seconds
    refreshInterval = setInterval(silentRefresh, 3000);
});

onBeforeUnmount(() => {
    if (refreshInterval) {
        clearInterval(refreshInterval);
    }
});

async function sendMessage() {
    if (!message.value.trim().length) return;
    const chat = {
        sender_uid: id.value,
        message: message.value
    };
    chats.value.items.push(chat)
    message.value = ''

    let single;
    if (route.query.uid && route.query.callsign) {
        single = {
            sender_uid: route.query.uid,
            sender_callsign: route.query.callsign
        }
    } else {
        single = chats.value.items.filter((chat) => {
            return chat.sender_uid !== id.value
        })[0];
    }

    if (!single) throw new Error('Error sending Chat - Contact is not defined');

    await mapStore.worker.conn.sendCOT({
        chatroom: callsign.value,
        to: {
            uid: single.sender_uid,
            callsign: single.sender_callsign
        },
        from: {
            uid: id.value,
            callsign: callsign.value
        },
        message: chat.message
    }, 'chat');
}

async function fetchChats() {
    loading.value = true;
    await loadChatData();
    loading.value = false;
}

async function silentRefresh() {
    await loadChatData();
}

async function loadChatData() {
    if (route.params.chatroom === 'new') {
        chats.value = await std(`/api/profile/chat/${encodeURIComponent(route.query.callsign)}`);
    } else {
        chats.value = await std(`/api/profile/chat/${encodeURIComponent(route.params.chatroom)}`);
    }
}
</script>
