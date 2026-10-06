<template>
    <SlideDownHeader
        v-model='isOpen'
        label='Login Page'
    >
        <template #icon>
            <IconLogin2
                :size='18'
                stroke='1'
                color='#6b7990'
                class='ms-2 me-1'
            />
        </template>
        <template #right>
            <TablerIconButton
                v-if='!edit && isOpen'
                title='Edit'
                @click.stop='edit = true'
            >
                <IconPencil stroke='1' />
            </TablerIconButton>
            <div
                v-else-if='edit && isOpen'
                class='d-flex gap-1'
            >
                <TablerIconButton
                    color='rgba(var(--tblr-primary-rgb), 0.14)'
                    title='Save'
                    @click.stop='save'
                >
                    <IconDeviceFloppy
                        color='rgb(var(--tblr-primary-rgb))'
                        stroke='1'
                    />
                </TablerIconButton>
                <TablerIconButton
                    title='Cancel'
                    @click.stop='edit = false; fetch()'
                >
                    <IconX stroke='1' />
                </TablerIconButton>
            </div>
        </template>
        <div class='col-lg-12 py-2 px-2'>
            <TablerLoading v-if='loading' />
            <template v-else>
                <TablerAlert
                    v-if='err'
                    :err='err'
                />
                <div class='row'>
                    <div class='col-lg-12'>
                        <TablerInput
                            v-model='config["login::name"]'
                            :disabled='!edit'
                            label='Login Page Title'
                            placeholder='CloudTAK'
                        />

                        <TablerInput
                            v-model='config["login::signup"]'
                            :disabled='!edit'
                            :error='validateURL(config["login::signup"])'
                            label='TAK Server Signup Link'
                        />

                        <TablerInput
                            v-model='config["login::forgot"]'
                            :disabled='!edit'
                            :error='validateURL(config["login::forgot"])'
                            label='TAK Server Password Reset Link'
                        />

                        <TablerInput
                            v-model='config["login::username"]'
                            :disabled='!edit'
                            label='Username Label'
                            desc='Label for the username field on the login page ie: Email, Callsign, etc.'
                        />

                        <TablerUploadLogo
                            v-model='config["login::logo"]'
                            label='Login Logo'
                            :disabled='!edit'
                        />

                        <TablerEnum
                            v-model='config["login::brand::enabled"]'
                            :disabled='!edit'
                            label='Enable Large Brand Logo'
                            :options='[
                                "default",
                                "enabled",
                                "disabled"
                            ]'
                        />

                        <TablerUploadLogo
                            v-if='config["login::brand::enabled"] === "enabled"'
                            v-model='config["login::brand::logo"]'
                            label='Large Brand Logo'
                            :disabled='!edit'
                        />

                        <TablerToggle
                            v-model='config["login::background::enabled"]'
                            label='Enable Custom Background'
                            :disabled='!edit'
                        />
                        <TablerInput
                            v-if='config["login::background::enabled"]'
                            v-model='config["login::background::color"]'
                            type='color'
                            label='Background Colour'
                            :disabled='!edit'
                        />

                        <TablerInlineAlert
                            class='mt-3'
                            title='SSO / OIDC Configuration'
                            description='Single Sign-On is configured via CDK deployment settings (cloudtak.oidcEnabled and related keys in cdk.json), not here. See docs/OIDC_AUTHENTICATION.md.'
                            severity='info'
                        />

                        <TablerToggle
                            v-model='config["passkey::enabled"]'
                            class='mt-3'
                            label='Enable Passkey Authentication'
                            :disabled='!edit'
                        />

                        <TablerInput
                            v-model='config["login::token::expiry"]'
                            class='mt-3'
                            type='number'
                            :min='1'
                            label='Login Token Lifetime (hours)'
                            desc='How long a login token is valid before the client must refresh it - default 192 (8 days)'
                            :disabled='!edit'
                        />

                        <TablerInput
                            v-model='config["login::refresh::expiry"]'
                            type='number'
                            :min='1'
                            label='Session Inactivity Timeout (hours)'
                            desc='A session expires after this long without a refresh - each refresh extends it by this much - default 720 (30 days)'
                            :disabled='!edit'
                        />
                    </div>
                </div>
            </template>
        </div>
    </SlideDownHeader>
</template>

<script setup lang="ts">
import SlideDownHeader from '../../CloudTAK/util/SlideDownHeader.vue';
import { ref, watch, onMounted } from 'vue';
import { server } from '../../../std.ts';
import { validateURL } from '../../../utils/validators.ts';
import {
    TablerLoading,
    TablerInput,
    TablerEnum,
    TablerIconButton,
    TablerAlert,
    TablerInlineAlert,
    TablerToggle,
    TablerUploadLogo
} from '@tak-ps/vue-tabler';
import {
    IconPencil,
    IconDeviceFloppy,
    IconX,
    IconLogin2
} from '@tabler/icons-vue';

interface LoginConfig {
    'login::name': string;
    'login::logo': string;
    'login::forgot': string;
    'login::signup': string;
    'login::username': string;
    'login::brand::enabled': 'default' | 'enabled' | 'disabled';
    'login::brand::logo': string;
    'login::background::enabled': boolean;
    'login::background::color': string;
    'passkey::enabled': boolean;
    'login::token::expiry': number;
    'login::refresh::expiry': number;
}

const isOpen = ref<boolean>(false);
const loading = ref<boolean>(false);
const edit = ref<boolean>(false);
const err = ref<Error | null>(null);

const config = ref<LoginConfig>({
    'login::name': '',
    'login::logo': '',
    'login::forgot': '',
    'login::signup': '',
    'login::username': 'Username or Email',
    'login::brand::enabled': 'default',
    'login::brand::logo': '',
    'login::background::enabled': false,
    'login::background::color': '#000000',
    'passkey::enabled': true,
    'login::token::expiry': 192,
    'login::refresh::expiry': 720,
});

onMounted(() => {
     if (isOpen.value) void fetch();
});

watch(isOpen, (newState) => {
    if (newState && !edit.value) void fetch();
});

async function fetch(): Promise<void> {
    loading.value = true;
    err.value = null;
    try {
        const { data, error } = await server.GET('/api/config', {
            params: {
                query: {
                    keys: Object.keys(config.value).join(',')
                }
            }
        });
        if (error) throw new Error(error.message);

        config.value = {
            'login::name': data['login::name'] ?? '',
            'login::logo': data['login::logo'] ?? '',
            'login::forgot': data['login::forgot'] ?? '',
            'login::signup': data['login::signup'] ?? '',
            'login::username': data['login::username'] ?? 'Username or Email',
            'login::brand::enabled': data['login::brand::enabled'] ?? 'default',
            'login::brand::logo': data['login::brand::logo'] ?? '',
            'login::background::enabled': data['login::background::enabled'] ?? false,
            'login::background::color': data['login::background::color'] ?? '#000000',
            'passkey::enabled': data['passkey::enabled'] ?? true,
            'login::token::expiry': data['login::token::expiry'] ?? 192,
            'login::refresh::expiry': data['login::refresh::expiry'] ?? 720,
        };
    } catch (error) {
        err.value = error instanceof Error ? error : new Error(String(error));
    }
    loading.value = false;
}

async function save(): Promise<void> {
    loading.value = true;
    err.value = null;
    try {
        const { error } = await server.PUT('/api/config', {
            body: {
                ...config.value,
                'login::token::expiry': Number(config.value['login::token::expiry']),
                'login::refresh::expiry': Number(config.value['login::refresh::expiry']),
            }
        });
        if (error) throw new Error(error.message);

        edit.value = false;
    } catch (error) {
        err.value = error instanceof Error ? error : new Error(String(error));
        console.error('Failed to save login config:', error);
    }
    loading.value = false;
}
</script>
