export {};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createHandler } = require('../../../lib/lambda/break-glass-provision.cjs');

const PROPS = {
  AuthStackName: 'TAK-Test-AuthInfra',
  AdminSecretName: 'admin-secret',
  RotationSecretName: 'rotation-secret',
  AuthentikUrl: 'https://account.example.test',
  AdminEmail: 'admin@example.test',
  Username: 'ckadmin',
  GroupName: 'tak-break-glass',
  RotatorUsername: 'tak-break-glass-rotator',
  RotatorRoleName: 'tak-break-glass-rotator',
  RotatorGroupName: 'tak-break-glass-rotator',
  RotatorTokenIdentifier: 'tak-break-glass-rotator-token'
};

interface World {
  users: Record<string, any>;
  groups: Record<string, any>;
  roles: Record<string, any>;
  assignments: { role: string; body: any }[];
  tokens: Record<string, { key: string }>;
  requests: { method: string; path: string; body?: any }[];
}

function build(world: World, secretsStore: Record<string, string>, failPath?: { path: RegExp; status: number }) {
  const fetchFn = jest.fn(async (url: string, init: any) => {
    const path = url.replace('https://account.example.test/api/v3', '');
    const body = init.body ? JSON.parse(init.body) : undefined;
    world.requests.push({ method: init.method, path, body });
    const respond = (data: unknown, status = 200) => ({ ok: status < 300, status, text: async () => JSON.stringify(data) });
    if (failPath && failPath.path.test(path)) return respond({ detail: 'nope' }, failPath.status);
    let m: RegExpMatchArray | null;
    if ((m = path.match(/^\/core\/users\/\?username=(.+)$/))) {
      const user = world.users[decodeURIComponent(m[1])];
      return respond({ results: user ? [user] : [] });
    }
    if (path === '/core/users/' && init.method === 'POST') {
      const pk = 100 + Object.keys(world.users).length;
      world.users[body.username] = { pk, username: body.username, groups: [], type: body.type };
      return respond(world.users[body.username], 201);
    }
    if ((m = path.match(/^\/core\/groups\/\?name=(.+)$/))) {
      const group = world.groups[decodeURIComponent(m[1])];
      return respond({ results: group ? [group] : [] });
    }
    if (path === '/core/groups/' && init.method === 'POST') {
      world.groups[body.name] = { pk: `group-${body.name}`, name: body.name, roles: body.roles || [] };
      return respond(world.groups[body.name], 201);
    }
    if ((m = path.match(/^\/core\/groups\/([^/]+)\/$/)) && init.method === 'PATCH') {
      const group = Object.values(world.groups).find((g: any) => g.pk === m![1]) as any;
      Object.assign(group, body);
      return respond(group);
    }
    if ((m = path.match(/^\/rbac\/roles\/\?name=(.+)$/))) {
      const role = world.roles[decodeURIComponent(m[1])];
      return respond({ results: role ? [role] : [] });
    }
    if (path === '/rbac/roles/' && init.method === 'POST') {
      world.roles[body.name] = { pk: `role-${body.name}`, name: body.name };
      return respond(world.roles[body.name], 201);
    }
    if ((m = path.match(/^\/rbac\/permissions\/assigned_by_roles\/(.+)\/assign\/$/))) {
      world.assignments.push({ role: m[1], body });
      return respond({}, 200);
    }
    if ((m = path.match(/^\/core\/groups\/(.+)\/add_user\/$/))) {
      const user = Object.values(world.users).find((u: any) => u.pk === body.pk) as any;
      if (!user.groups.includes(m[1])) user.groups.push(m[1]);
      return respond({}, 204);
    }
    if (path.startsWith('/core/users/') && path.endsWith('/set_password/')) return respond({}, 204);
    if ((m = path.match(/^\/core\/tokens\/\?identifier=(.+)$/))) {
      const id = decodeURIComponent(m[1]);
      return respond({ results: world.tokens[id] ? [{ identifier: id }] : [] });
    }
    if (path === '/core/tokens/' && init.method === 'POST') {
      world.tokens[body.identifier] = { key: 'generated-key' };
      return respond({}, 201);
    }
    if ((m = path.match(/^\/core\/tokens\/(.+)\/view_key\/$/))) return respond({ key: world.tokens[decodeURIComponent(m[1])].key });
    return respond({ detail: 'unexpected ' + path }, 500);
  });
  const secrets = {
    get: jest.fn(async (id: string) => {
      if (secretsStore[id] === undefined) throw new Error('no such secret ' + id);
      return secretsStore[id];
    }),
    put: jest.fn(async (id: string, value: string) => { secretsStore[id] = value; })
  };
  const { handler } = createHandler({ secrets, fetchFn, sleep: async () => {} });
  return { handler, secrets, fetchFn };
}

function freshWorld(): World {
  return { users: {}, groups: { 'tak-break-glass': { pk: 'group-uuid', name: 'tak-break-glass', roles: [] } }, roles: {}, assignments: [], tokens: {}, requests: [] };
}
const baseSecrets = () => ({
  'TAK-Test-AuthInfra/Authentik/Admin-API-Token': 'admin-token\n',
  'admin-secret': JSON.stringify({ username: 'ckadmin', password: 'sealed-password' }),
  'rotation-secret': '{}'
});
const event = (extra: object = {}) => ({ RequestType: 'Create', ResourceProperties: PROPS, ...extra });
const passwordSets = (world: World) => world.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/set_password/'));

describe('break-glass provisioning', () => {
  test('creates a missing account with the sealed password, groups it, and fills the rotation secret', async () => {
    const world = freshWorld();
    const store: Record<string, string> = baseSecrets();
    const { handler } = build(world, store);
    const result = await handler(event());
    expect(world.users.ckadmin).toBeDefined();
    expect(world.users.ckadmin.groups).toEqual(['group-uuid']);
    const sets = passwordSets(world);
    expect(sets).toHaveLength(1);
    expect(sets[0].body).toEqual({ password: 'sealed-password' });
    expect(JSON.parse(store['rotation-secret'])).toEqual({ token: 'generated-key', userPk: world.users.ckadmin.pk });
    expect(result.Data).toMatchObject({ Username: 'ckadmin', Created: 'true' });
  });

  test('never resets the password of an account that already exists', async () => {
    const world = freshWorld();
    world.users.ckadmin = { pk: 13, username: 'ckadmin', groups: [] };
    const { handler, secrets } = build(world, baseSecrets());
    const result = await handler(event());
    expect(passwordSets(world)).toHaveLength(0);
    // and does not even read the sealed secret
    expect(secrets.get).not.toHaveBeenCalledWith('admin-secret');
    expect(result.Data.Created).toBe('false');
  });

  test('adds an existing account to the break-glass group, once', async () => {
    const world = freshWorld();
    world.users.ckadmin = { pk: 13, username: 'ckadmin', groups: [] };
    const { handler } = build(world, baseSecrets());
    await handler(event());
    await handler(event());
    expect(world.requests.filter((r) => r.path === '/core/groups/group-uuid/add_user/')).toHaveLength(1);
    expect(world.users.ckadmin.groups).toEqual(['group-uuid']);
  });

  test('gives the rotation account one object permission, through a role and a group', async () => {
    const world = freshWorld();
    world.users.ckadmin = { pk: 13, username: 'ckadmin', groups: ['group-uuid'] };
    const { handler } = build(world, baseSecrets());
    await handler(event());
    const rotator = world.users['tak-break-glass-rotator'];
    expect(rotator.type).toBe('service_account');
    // the role holds view and reset on that one account, and nothing else
    expect(world.assignments).toHaveLength(1);
    expect(world.assignments[0]).toEqual({
      role: 'role-tak-break-glass-rotator',
      body: { permissions: ['authentik_core.view_user', 'authentik_core.reset_user_password'], model: 'authentik_core.user', object_pk: '13' }
    });
    // the group carries the role, and the service account is in the group
    expect(world.groups['tak-break-glass-rotator'].roles).toEqual(['role-tak-break-glass-rotator']);
    expect(rotator.groups).toEqual(['group-tak-break-glass-rotator']);
    // the rotation account is not put in the break-glass group
    expect(rotator.groups).not.toContain('group-uuid');
  });

  test('repairs a rotation group that lost its role, and a service account that lost its group', async () => {
    const world = freshWorld();
    world.users.ckadmin = { pk: 13, username: 'ckadmin', groups: ['group-uuid'] };
    world.users['tak-break-glass-rotator'] = { pk: 50, username: 'tak-break-glass-rotator', groups: [], type: 'service_account' };
    world.roles['tak-break-glass-rotator'] = { pk: 'role-tak-break-glass-rotator', name: 'tak-break-glass-rotator' };
    world.groups['tak-break-glass-rotator'] = { pk: 'group-tak-break-glass-rotator', name: 'tak-break-glass-rotator', roles: [] };
    const { handler } = build(world, baseSecrets());
    await handler(event());
    expect(world.groups['tak-break-glass-rotator'].roles).toEqual(['role-tak-break-glass-rotator']);
    expect(world.users['tak-break-glass-rotator'].groups).toEqual(['group-tak-break-glass-rotator']);
  });

  test('is repeatable: a second run changes nothing and does not rewrite the rotation secret', async () => {
    const world = freshWorld();
    const store: Record<string, string> = baseSecrets();
    const { handler, secrets } = build(world, store);
    await handler(event());
    const writes = secrets.put.mock.calls.length;
    const usersBefore = Object.keys(world.users).length;
    await handler(event({ RequestType: 'Update' }));
    expect(secrets.put.mock.calls.length).toBe(writes);
    expect(Object.keys(world.users)).toHaveLength(usersBefore);
    expect(world.requests.filter((r) => r.method === 'POST' && r.path === '/core/tokens/')).toHaveLength(1);
  });

  test('refreshes the rotation secret when the token changed', async () => {
    const world = freshWorld();
    const store: Record<string, string> = baseSecrets();
    const { handler } = build(world, store);
    await handler(event());
    world.tokens['tak-break-glass-rotator-token'].key = 'regenerated-key';
    await handler(event({ RequestType: 'Update' }));
    expect(JSON.parse(store['rotation-secret']).token).toBe('regenerated-key');
  });

  test('fails with a clear message when auth-infra has not created the group', async () => {
    const world = freshWorld();
    world.groups = {};
    const { handler } = build(world, baseSecrets());
    await expect(handler(event())).rejects.toThrow(/tak-break-glass does not exist. Deploy auth-infra first/);
  });

  test('fails when a required property is missing', async () => {
    const { handler } = build(freshWorld(), baseSecrets());
    await expect(handler({ RequestType: 'Create', ResourceProperties: { ...PROPS, GroupName: '' } })).rejects.toThrow(/Missing required property: GroupName/);
  });

  test('does not retry a refusal from Authentik, and surfaces it', async () => {
    const world = freshWorld();
    const { handler, fetchFn } = build(world, baseSecrets(), { path: /^\/core\/users\/\?username=ckadmin$/, status: 403 });
    await expect(handler(event())).rejects.toThrow(/403/);
    expect(fetchFn.mock.calls.filter((call) => String(call[0]).includes('username=ckadmin'))).toHaveLength(1);
  });

  test('retries a server error and then succeeds', async () => {
    const world = freshWorld();
    world.users.ckadmin = { pk: 13, username: 'ckadmin', groups: ['group-uuid'] };
    const store: Record<string, string> = baseSecrets();
    const real = build(world, store);
    let failures = 1;
    const flaky = createHandler({
      secrets: { get: async (id: string) => store[id], put: async (id: string, v: string) => { store[id] = v; } },
      fetchFn: async (url: string, init: any) => {
        if (failures-- > 0) return { ok: false, status: 502, text: async () => 'bad gateway' };
        return real.fetchFn(url, init);
      },
      sleep: async () => {}
    });
    await expect(flaky.handler(event())).resolves.toBeDefined();
  });

  test('leaves the accounts alone on delete', async () => {
    const world = freshWorld();
    const { handler } = build(world, baseSecrets());
    const result = await handler({ RequestType: 'Delete', PhysicalResourceId: 'authentik-user-ckadmin', ResourceProperties: PROPS });
    expect(result).toEqual({ PhysicalResourceId: 'authentik-user-ckadmin' });
    expect(world.requests).toHaveLength(0);
  });
});
