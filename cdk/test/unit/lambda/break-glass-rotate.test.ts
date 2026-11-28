export {};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createHandler } = require('../../../lib/lambda/break-glass-rotate.cjs');

const ENV = { ADMIN_SECRET_NAME: 'admin-secret', ROTATION_SECRET_NAME: 'rotation-secret', AUTHENTIK_URL: 'https://account.example.test/' };

function setup(overrides: { rotation?: unknown; fetchStatus?: number; promoteError?: Error } = {}) {
  const calls: string[] = [];
  const store: Record<string, string> = {
    'admin-secret': JSON.stringify({ username: 'ckadmin', password: 'old-password' }),
    'rotation-secret': JSON.stringify(overrides.rotation ?? { token: 'rot-token', userPk: 13 })
  };
  const pending: Record<string, string> = {};
  const secrets = {
    getCurrent: jest.fn(async (id: string) => { calls.push(`get:${id}`); return store[id]; }),
    putPending: jest.fn(async (id: string, value: string) => { calls.push('putPending'); pending['v1'] = value; return 'v1'; }),
    promote: jest.fn(async (id: string, versionId: string) => {
      calls.push('promote');
      if (overrides.promoteError) throw overrides.promoteError;
      store[id] = pending[versionId];
    })
  };
  const fetchFn = jest.fn(async (url: string, init: any) => {
    calls.push('authentik');
    return { ok: (overrides.fetchStatus ?? 200) < 300, status: overrides.fetchStatus ?? 200, text: async () => 'body' };
  });
  const randomPassword = jest.fn(() => 'new-random-password');
  const { handler } = createHandler({ secrets, fetchFn, randomPassword });
  return { handler, secrets, fetchFn, calls, store, pending };
}

describe('break-glass rotation', () => {
  const saved = { ...process.env };
  beforeEach(() => { Object.assign(process.env, ENV); });
  afterEach(() => { process.env = { ...saved }; });

  test('stores the pending version, sets Authentik, then promotes, in that order', async () => {
    const { handler, calls } = setup();
    const result = await handler();
    expect(calls.filter((c) => !c.startsWith('get:'))).toEqual(['putPending', 'authentik', 'promote']);
    expect(result).toEqual({ status: 'rotated', secretVersion: 'v1' });
  });

  test('uses the rotation token and the pk from the rotation secret, and the new password', async () => {
    const { handler, fetchFn } = setup();
    await handler();
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('https://account.example.test/api/v3/core/users/13/set_password/');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer rot-token');
    expect(JSON.parse(init.body)).toEqual({ password: 'new-random-password' });
  });

  test('keeps the username and writes the new password into the sealed secret', async () => {
    const { handler, store } = setup();
    await handler();
    expect(JSON.parse(store['admin-secret'])).toEqual({ username: 'ckadmin', password: 'new-random-password' });
  });

  test('never returns or logs the password', async () => {
    const logs: string[] = [];
    const secrets = setup();
    const { handler } = createHandler({
      secrets: secrets.secrets,
      fetchFn: secrets.fetchFn,
      randomPassword: () => 'new-random-password',
      log: (...args: unknown[]) => logs.push(JSON.stringify(args))
    });
    const result = await handler();
    expect(JSON.stringify(result)).not.toContain('new-random-password');
    expect(logs.join('\n')).not.toContain('new-random-password');
    expect(logs.join('\n')).not.toContain('rot-token');
  });

  test('when Authentik refuses, the secret is not promoted and the error says so', async () => {
    const { handler, secrets, store } = setup({ fetchStatus: 403 });
    await expect(handler()).rejects.toThrow(/refused the new password \(403\).*unchanged and still current/);
    expect(secrets.promote).not.toHaveBeenCalled();
    expect(JSON.parse(store['admin-secret']).password).toBe('old-password');
  });

  test('when promoting fails, the error names the version and the command to promote it', async () => {
    const { handler } = setup({ promoteError: new Error('throttled') });
    await expect(handler()).rejects.toThrow(/changed in Authentik.*v1.*update-secret-version-stage.*--move-to-version-id v1/s);
  });

  test('refuses to run when the rotation secret has not been filled by the provisioning function', async () => {
    const { handler, secrets } = setup({ rotation: {} });
    await expect(handler()).rejects.toThrow(/rotation secret is empty/);
    expect(secrets.putPending).not.toHaveBeenCalled();
  });

  test('refuses to run when its configuration is missing', async () => {
    delete process.env.AUTHENTIK_URL;
    const { handler } = setup();
    await expect(handler()).rejects.toThrow(/must be set/);
  });
});
