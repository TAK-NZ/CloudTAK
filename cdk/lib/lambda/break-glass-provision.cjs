'use strict';
/**
 * Break-glass provisioning, run by CloudFormation on every deploy (CloudTAK stack, BreakGlass construct).
 *
 * It makes sure that the CloudTAK break-glass account exists in Authentik and is set up so that it can be
 * rotated, and it never changes the account's password once the account exists:
 *
 *   1. The account (`ckadmin`) exists. It is created, with the password from the sealed secret, only when it
 *      is missing. An existing account keeps whatever password it has.
 *   2. The account is a member of `tak-break-glass`, which the web login flows refuse.
 *   3. A service account (`tak-break-glass-rotator`) exists whose only permission is to reset the password of
 *      that one account. Authentik grants object permissions to roles only, so the permission sits on a role,
 *      the role on a group, and the service account in the group (object permissions can only be assigned
 *      through the API, not a blueprint).
 *   4. The token of that service account is stored in the rotation secret, readable by the rotation function
 *      only, together with the primary key of the account to rotate.
 *
 * Nothing here reads the sealed secret unless the account has to be created. This function's role is excluded
 * from the "secret was read" alarm, so a deploy never raises it.
 *
 * Written as a factory so that it can be tested with fake dependencies (see test/unit/lambda).
 */
// Authentik hides an object the caller cannot view, so the reset permission needs view on the same account
const ROTATOR_PERMISSIONS = ['authentik_core.view_user', 'authentik_core.reset_user_password'];
function createHandler({ secrets, fetchFn, log = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  async function api(base, token, method, path, body, attempts = 3) {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await fetchFn(`${base}/api/v3${path}`, {
          method,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body)
        });
        const text = await response.text();
        if (response.status >= 500) {
          throw new Error(`${method} ${path} failed with ${response.status}`);
        }
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = text; }
        if (!response.ok) {
          const error = new Error(`${method} ${path} failed with ${response.status}: ${String(text).slice(0, 300)}`);
          error.status = response.status;
          error.permanent = true;
          throw error;
        }
        return data;
      } catch (error) {
        lastError = error;
        if (error.permanent || attempt === attempts) break;
        await sleep(1000 * attempt);
      }
    }
    throw lastError;
  }
  async function handler(event) {
    log('info', 'Break-glass provisioning started', { requestType: event.RequestType });
    if (event.RequestType === 'Delete') {
      // The accounts belong to Authentik and are never removed with this stack
      return { PhysicalResourceId: event.PhysicalResourceId };
    }
    const p = event.ResourceProperties || {};
    for (const key of ['AuthStackName', 'AdminSecretName', 'RotationSecretName', 'AuthentikUrl', 'AdminEmail', 'Username', 'GroupName', 'RotatorUsername', 'RotatorRoleName', 'RotatorGroupName', 'RotatorTokenIdentifier']) {
      if (!p[key]) throw new Error(`Missing required property: ${key}`);
    }
    const base = p.AuthentikUrl.replace(/\/+$/, '');
    const adminToken = String(await secrets.get(`${p.AuthStackName}/Authentik/Admin-API-Token`)).trim();
    const call = (method, path, body) => api(base, adminToken, method, path, body);
    const find = async (path, field, value) => {
      const list = await call('GET', path);
      return (list.results || []).find((item) => item[field] === value);
    };
    // 1. The break-glass account, created only when missing
    let user = await find(`/core/users/?username=${encodeURIComponent(p.Username)}`, 'username', p.Username);
    let created = false;
    if (!user) {
      const creds = JSON.parse(await secrets.get(p.AdminSecretName));
      user = await call('POST', '/core/users/', {
        username: p.Username,
        name: 'CloudTAK break-glass administrator',
        email: p.AdminEmail,
        is_active: true,
        type: 'internal',
        path: 'users'
      });
      await call('POST', `/core/users/${user.pk}/set_password/`, { password: creds.password });
      created = true;
      log('info', 'Break-glass account created', { username: p.Username, userPk: user.pk });
    } else {
      log('info', 'Break-glass account exists, password left alone', { username: p.Username, userPk: user.pk });
    }
    // 2. Membership of the group that the web login flows refuse
    const group = await find(`/core/groups/?name=${encodeURIComponent(p.GroupName)}`, 'name', p.GroupName);
    if (!group) {
      throw new Error(`Authentik group ${p.GroupName} does not exist. Deploy auth-infra first (it creates the group).`);
    }
    if (!(user.groups || []).includes(group.pk)) {
      await call('POST', `/core/groups/${group.pk}/add_user/`, { pk: user.pk });
      log('info', 'Added to the break-glass group', { group: p.GroupName });
    }
    // 3. The rotation service account and its one permission. Authentik grants object permissions to roles
    //    (there is no per-user assignment), and a role reaches a user through a group, so: a role that may reset
    //    the password of this one account, a group that carries the role, and the service account in the group.
    let rotator = await find(`/core/users/?username=${encodeURIComponent(p.RotatorUsername)}`, 'username', p.RotatorUsername);
    if (!rotator) {
      rotator = await call('POST', '/core/users/', {
        username: p.RotatorUsername,
        name: 'Break-glass password rotation',
        is_active: true,
        type: 'service_account',
        path: 'users'
      });
      log('info', 'Rotation service account created', { userPk: rotator.pk });
    }
    let role = await find(`/rbac/roles/?name=${encodeURIComponent(p.RotatorRoleName)}`, 'name', p.RotatorRoleName);
    if (!role) {
      role = await call('POST', '/rbac/roles/', { name: p.RotatorRoleName });
      log('info', 'Rotation role created', { role: p.RotatorRoleName });
    }
    // Assigning the same permission again is harmless. It is repeated so that a changed account pk is repaired.
    await call('POST', `/rbac/permissions/assigned_by_roles/${role.pk}/assign/`, {
      permissions: ROTATOR_PERMISSIONS,
      model: 'authentik_core.user',
      object_pk: String(user.pk)
    });
    let rotatorGroup = await find(`/core/groups/?name=${encodeURIComponent(p.RotatorGroupName)}`, 'name', p.RotatorGroupName);
    if (!rotatorGroup) {
      rotatorGroup = await call('POST', '/core/groups/', { name: p.RotatorGroupName, roles: [role.pk] });
      log('info', 'Rotation group created', { group: p.RotatorGroupName });
    } else if (!(rotatorGroup.roles || []).includes(role.pk)) {
      await call('PATCH', `/core/groups/${rotatorGroup.pk}/`, { roles: [...(rotatorGroup.roles || []), role.pk] });
    }
    if (!(rotator.groups || []).includes(rotatorGroup.pk)) {
      await call('POST', `/core/groups/${rotatorGroup.pk}/add_user/`, { pk: rotator.pk });
    }
    // 4. Its token, kept in the rotation secret
    let token = await find(`/core/tokens/?identifier=${encodeURIComponent(p.RotatorTokenIdentifier)}`, 'identifier', p.RotatorTokenIdentifier);
    if (!token) {
      await call('POST', '/core/tokens/', {
        identifier: p.RotatorTokenIdentifier,
        intent: 'api',
        user: rotator.pk,
        expiring: false,
        description: 'Resets the password of the break-glass account only'
      });
    }
    const key = (await call('GET', `/core/tokens/${encodeURIComponent(p.RotatorTokenIdentifier)}/view_key/`)).key;
    if (!key) throw new Error('Authentik returned no key for the rotation token');
    const wanted = JSON.stringify({ token: key, userPk: user.pk });
    let current = '';
    try { current = await secrets.get(p.RotationSecretName); } catch { current = ''; }
    let parsed = {};
    try { parsed = JSON.parse(current); } catch { parsed = {}; }
    if (parsed.token !== key || String(parsed.userPk) !== String(user.pk)) {
      await secrets.put(p.RotationSecretName, wanted);
      log('info', 'Rotation secret updated');
    }
    log('info', 'Break-glass provisioning completed', { created });
    return {
      PhysicalResourceId: `authentik-user-${p.Username}`,
      Data: { Username: p.Username, UserPk: String(user.pk), Created: String(created) }
    };
  }
  return { handler };
}
// The deployed function: real AWS SDK, global fetch, JSON logging without values
let deployed;
function getDeployed() {
  if (!deployed) {
    const { SecretsManagerClient, GetSecretValueCommand, PutSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
    const client = new SecretsManagerClient({ region: process.env.AWS_REGION });
    deployed = createHandler({
      secrets: {
        get: async (id) => (await client.send(new GetSecretValueCommand({ SecretId: id }))).SecretString,
        put: async (id, value) => { await client.send(new PutSecretValueCommand({ SecretId: id, SecretString: value })); }
      },
      fetchFn: fetch,
      log: (level, message, data = {}) => console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: level.toUpperCase(), message, ...data }))
    });
  }
  return deployed;
}
exports.createHandler = createHandler;
exports.handler = (event) => getDeployed().handler(event);
