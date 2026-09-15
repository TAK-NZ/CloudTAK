<template>
    <MenuTemplate
        name='Login Sessions'
        :loading='loading'
    >
        <template #default>
            <LoginSessionsList
                v-if='username'
                :username='username'
            />
        </template>
    </MenuTemplate>
</template>

<script setup lang='ts'>
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import MenuTemplate from '../util/MenuTemplate.vue';
import LoginSessionsList from '../../util/LoginSessionsList.vue';
import { server } from '../../../std.ts';
import ProfileConfig from '../../../base/profile.ts';

const router = useRouter();

const loading = ref<boolean>(true);
const username = ref<string>('');

onMounted(async () => {
    // The backend's list-sessions endpoint is admin-only (Auth.as_user with
    // { admin: true }), so a non-admin always gets a generic 401 here.
    // MenuSettings.vue already hides the menu entry for non-admins, but this
    // page is still directly reachable by URL - bounce back rather than show
    // an error a regular user has no way to act on.
    const isSystemAdmin = await ProfileConfig.get('system_admin');
    if (!isSystemAdmin?.value) {
        router.replace('/menu/settings');
        return;
    }

    const res = await server.GET('/api/login');
    if (res.error) throw new Error(res.error.message);
    username.value = res.data.email;
    loading.value = false;
});
</script>
