<template>
    <div
        class='page page-center cloudtak-gradient position-relative'
        style='overflow: auto;'
    >
        <img
            class='position-absolute d-none d-md-inline user-select-none'
            draggable='false'
            style='
                height: 48px;
                bottom: 24px;
                left: 24px;
            '
            src='/CloudTAKLogoText.svg'
            alt='CloudTAK Logo'
        >

        <div class='container container-normal py-4'>
            <div class='row align-items-center g-4'>
                <div class='col-lg'>
                    <div class='container-tight'>
                        <div class='card card-md'>
                            <div
                                v-if='!brandStore || !brandStore.loaded'
                                class='card-body'
                                style='height: 400px;'
                            >
                                <div class='col-12 d-flex justify-content-center pb-4'>
                                    <img
                                        class='user-select-none'
                                        draggable='false'
                                        style='
                                            height: 64px;
                                        '
                                        src='/CloudTAKLogo.svg'
                                        alt='CloudTAK Logo'
                                    >
                                </div>
                                <div class='col-12 d-flex justify-content-center pb-4'>
                                    <h2 class='h2 text-center mb-4'>
                                        Loading CloudTAK
                                    </h2>
                                </div>
                                <TablerLoading />
                            </div>
                            <div
                                v-else
                                class='card-body'
                            >
                                <div
                                    class='text-center'
                                    style='margin-bottom: 24px;'
                                >
                                    <img
                                        :src='brandStore.login && brandStore.login.logo ? brandStore.login.logo : "/CloudTAKLogo.svg"'
                                        style='height: 150px;'
                                        draggable='false'
                                        class='user-select-none'
                                        alt='CloudTAK System Logo'
                                    >
                                </div>
                                <h2 class='h2 text-center mb-4'>
                                    Login to your account
                                </h2>
                                
                                <!-- OIDC Login Section -->
                                <div v-if='oidcEnabled' class='mb-4'>
                                    <button
                                        :disabled='loading'
                                        type='button'
                                        class='btn btn-outline-primary w-100 mb-3'
                                        @click='loginWithOIDC'
                                    >
                                        Sign in with {{ oidcConfig?.provider_name || 'SSO' }}
                                    </button>
                                    
                                    <div class='hr-text'>
                                        or
                                    </div>
                                </div>
                                
                                <!-- Traditional Login Form -->
                                <TablerLoading
                                    v-if='loading'
                                    desc='Logging in'
                                />
                                <template v-else>
                                    <div class='mb-3'>
                                        <TablerInput
                                            v-model='body.username'
                                            icon='user'
                                            label='Username or Email'
                                            placeholder='your@email.com'
                                            @keyup.enter='createLogin'
                                        />
                                    </div>
                                    <div class='mb-2'>
                                        <div class='d-flex'>
                                            <label class='form-label mb-0'>
                                                Password
                                            </label>
                                            <span class='ms-auto'>
                                                <a
                                                    v-if='brandStore.login && brandStore.login.forgot'
                                                    tabindex='-1'
                                                    class='cursor-pointer'
                                                    :href='brandStore.login.forgot'
                                                >Forgot Password</a>
                                            </span>
                                        </div>
                                        <TablerInput
                                            v-model='body.password'
                                            icon='lock'
                                            type='password'
                                            placeholder='Your password'
                                            @keyup.enter='createLogin'
                                        />
                                    </div>
                                    <div class='form-footer'>
                                        <button
                                            type='submit'
                                            class='btn btn-primary w-100'
                                            @click='createLogin'
                                        >
                                            Sign In
                                        </button>
                                    </div>
                                </template>
                            </div>
                        </div>
                        <div
                            v-if='brandStore.login && brandStore.login.signup'
                            class='text-center text-muted mt-3'
                        >
                            Don't have an account yet?
                            <a
                                tabindex='-1'
                                class='cursor-pointer'
                                :href='brandStore.login.signup'
                            >Sign Up</a>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>

<script setup lang='ts'>
// Component name for linting
defineOptions({
    name: 'LoginPage'
});

import type { Login_Create, Login_CreateRes, OIDC_Config, OIDC_AuthorizeResponse } from '../types.ts'
import { ref, onMounted, computed } from 'vue';
import { useBrandStore } from '../stores/brand.ts';
import { useRouter, useRoute } from 'vue-router'
import { std } from '../std.ts';
import {
    TablerLoading,
    TablerInput
} from '@tak-ps/vue-tabler'

const emit = defineEmits([ 'login' ]);

const route = useRoute();
const router = useRouter();
const brandStore = useBrandStore();

const loading = ref(false);
const oidcConfig = ref<OIDC_Config | null>(null);
const body = ref<Login_Create>({
    username: '',
    password: ''
});

const oidcEnabled = computed(() => {
    return oidcConfig.value && oidcConfig.value.enabled;
});

onMounted(async () => {
    await brandStore.init();
    await loadOIDCConfig();
    
    // Handle OIDC callback
    if (route.query.code) {
        await handleOIDCCallback();
    }
});

async function loadOIDCConfig() {
    try {
        const config = await std('/api/auth/oidc/config') as OIDC_Config;
        oidcConfig.value = config;
    } catch {
        console.log('OIDC not configured');
        oidcConfig.value = { enabled: false };
    }
}

async function loginWithOIDC() {
    loading.value = true;
    
    try {
        const authResponse = await std('/api/auth/oidc/authorize', {
            method: 'POST',
            body: {
                redirect_uri: `${window.location.origin}/login`
            }
        }) as OIDC_AuthorizeResponse;
        
        // Redirect to OIDC provider
        window.location.href = authResponse.url;
    } catch (err) {
        loading.value = false;
        throw err;
    }
}

async function handleOIDCCallback() {
    loading.value = true;
    
    try {
        const login = await std('/api/auth/oidc/callback', {
            method: 'POST',
            body: {
                code: route.query.code,
                state: route.query.state,
                redirect_uri: `${window.location.origin}/login`
            }
        }) as Login_CreateRes;

        localStorage.token = login.token;
        emit('login');

        if (route.query.redirect && !String(route.query.redirect).includes('/login')) {
            router.push(String(route.query.redirect));
        } else {
            router.push("/");
        }
    } catch (err) {
        loading.value = false;
        // Clear URL params on error
        router.replace('/login');
        throw err;
    }
}

async function createLogin() {
    loading.value = true;

    try {
        const login = await std('/api/login', {
            method: 'POST',
            body: {
                username: body.value.username.match(/[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?/)
                    ? body.value.username.toLowerCase()
                    : body.value.username,
                password: body.value.password
             }
        }) as Login_CreateRes

        localStorage.token = login.token;

        emit('login');

        if (route.query.redirect && !String(route.query.redirect).includes('/login')) {
            router.push(String(route.query.redirect));
        } else {
            router.push("/");
        }
    } catch (err) {
        loading.value = false;
        throw err;
    }
}
</script>
