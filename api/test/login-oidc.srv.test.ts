import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import Sinon from 'sinon';
import Flight from './flight.js';
import AuthentikProvider from '../stateless/lib/authentik-provider.js';

const flight = new Flight();

flight.init({ takserver: true });
flight.takeoff();
flight.user();
flight.server('admin@example.com', 'password123');

let idpUrl = '';
let userinfoEmail = 'Admin@Example.com';
let userinfoGroups: string[] = [];

const idp = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'GET' && req.url === '/.well-known/openid-configuration') {
        res.end(JSON.stringify({
            authorization_endpoint: `${idpUrl}/authorize`,
            token_endpoint: `${idpUrl}/token`,
            userinfo_endpoint: `${idpUrl}/userinfo`,
        }));
    } else if (req.method === 'POST' && req.url === '/token') {
        res.end(JSON.stringify({
            access_token: 'idp-access-token',
            token_type: 'Bearer',
        }));
    } else if (req.method === 'GET' && req.url === '/userinfo') {
        if (req.headers.authorization !== 'Bearer idp-access-token') {
            res.statusCode = 401;
            res.end(JSON.stringify({ error: 'invalid_token' }));
        } else {
            res.end(JSON.stringify({ sub: 'test-subject', email: userinfoEmail, groups: userinfoGroups }));
        }
    } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'not_found' }));
    }
});

test('start: mock OIDC IdP', async () => {
    await new Promise<void>(resolve => idp.listen(0, '127.0.0.1', resolve));
    idpUrl = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;

    process.env.OIDC_ENABLED = 'true';
    process.env.OIDC_DISCOVERY_URL = `${idpUrl}/.well-known/openid-configuration`;
    process.env.OIDC_CLIENT_ID = 'test-client';
    process.env.OIDC_CLIENT_SECRET = 'test-secret';
});

/**
 * Complete the browser side of the SSO flow: obtain the IdP redirect,
 * then hit the callback with the state and a fake code, returning the
 * callback's redirect location
 */
async function ssoLogin(): Promise<URL> {
    const start = await fetch(`${flight.base}/api/login/oidc`, { redirect: 'manual' });
    assert.equal(start.status, 302);

    const idpLocation = new URL(String(start.headers.get('location')));
    const state = idpLocation.searchParams.get('state');
    assert.ok(state);

    const cb = await fetch(
        `${flight.base}/api/login/oidc/callback?code=test-code&state=${encodeURIComponent(String(state))}`,
        { redirect: 'manual' },
    );
    assert.equal(cb.status, 302);

    return new URL(String(cb.headers.get('location')), flight.base);
}

function ssoPayload(location: URL): {
    access: string;
    email: string;
    session: string;
    token: string;
    redirect?: string;
} {
    assert.ok(location.hash.startsWith('#sso='), `Expected #sso= fragment, got: ${location}`);
    return JSON.parse(Buffer.from(location.hash.slice('#sso='.length), 'base64url').toString());
}

test('GET: api/login/oidc - disabled returns a redirect to /login with sso_error', async () => {
    try {
        delete process.env.OIDC_ENABLED;

        const res = await fetch(`${flight.base}/api/login/oidc`, { redirect: 'manual' });
        assert.equal(res.status, 302);
        const location = new URL(String(res.headers.get('location')), flight.base);
        assert.equal(location.pathname, '/login');
        assert.ok(location.searchParams.get('sso_error'));
    } finally {
        process.env.OIDC_ENABLED = 'true';
    }
});

test('GET: api/login/oidc/callback - first-time SSO login creates a profile and returns a session', async () => {
    userinfoEmail = 'newuser@example.com';
    userinfoGroups = [];

    const location = await ssoLogin();
    const payload = ssoPayload(location);

    assert.equal(payload.email, 'newuser@example.com');
    assert.equal(payload.access, 'user');
    assert.ok(payload.token);
    assert.ok(payload.session);
});

test('GET: api/login/oidc/callback - CloudTAKSystemAdmin group grants admin access', async () => {
    userinfoEmail = 'sysadmin@example.com';
    userinfoGroups = ['CloudTAKSystemAdmin'];

    const location = await ssoLogin();
    const payload = ssoPayload(location);

    assert.equal(payload.email, 'sysadmin@example.com');
    assert.equal(payload.access, 'admin');
});

test('GET: api/login/oidc/callback - email claim is lowercased for lookup', async () => {
    // admin@example.com already exists (created by flight.user()) as a system
    // admin. Role membership is re-synced from the IdP's groups claim on every
    // OIDC login, so the CloudTAKSystemAdmin group must be present here or the
    // account would be demoted to a regular user.
    userinfoEmail = 'Admin@Example.com';
    userinfoGroups = ['CloudTAKSystemAdmin'];

    const location = await ssoLogin();
    const payload = ssoPayload(location);

    assert.equal(payload.email, 'admin@example.com');
    assert.equal(payload.access, 'admin');
});

test('GET: api/login/oidc/callback - invalid state is rejected', async () => {
    const res = await fetch(
        `${flight.base}/api/login/oidc/callback?code=test-code&state=not-a-real-jwt`,
        { redirect: 'manual' },
    );
    assert.equal(res.status, 302);
    const location = new URL(String(res.headers.get('location')), flight.base);
    assert.ok(location.searchParams.get('sso_error'));
});

test('PUT: env - enable OIDC_FORCED', async () => {
    process.env.OIDC_FORCED = 'true';
});

test('POST: api/login - rejected for non-admin when OIDC_FORCED', async () => {
    try {
        const res = await flight.fetch('/api/login', {
            method: 'POST',
            body: {
                username: 'newuser@example.com',
                password: 'irrelevant',
            },
        }, false);

        assert.equal(res.status, 403);
        assert.equal(res.body.message, 'Local login is restricted to system admins. Please use SSO.');
    } catch (err) {
        assert.ifError(err);
    }
});

test('POST: api/login - allowed for system admin when OIDC_FORCED', async () => {
    try {
        const res = await flight.fetch('/api/login', {
            method: 'POST',
            body: {
                username: 'admin@example.com',
                password: 'password123',
            },
        }, false);

        assert.ok(res.body.token);
        delete res.body.token;
        assert.ok(res.body.session);
        delete res.body.session;

        assert.deepEqual(res.body, {
            access: 'admin',
            email: 'admin@example.com',
        });
    } catch (err) {
        assert.ifError(err);
    }
});

test('GET: api/login/oidc/callback - Authentik attribute sync populates callsign/group/role and suppresses the Welcome dialog', async () => {
    // Regression test for: new SSO users were shown the "Welcome" callsign/
    // group/role dialog even when Authentik attribute sync had already
    // populated real values, because the frontend (and the isFirstLogin
    // check in login.ts) suppress that dialog based on `profile.created ===
    // profile.updated`, and nothing in the sync path used to bump `updated`.
    userinfoEmail = 'attributesync@example.com';
    userinfoGroups = [];

    process.env.AUTHENTIK_URL = 'http://authentik.invalid';
    process.env.AUTHENTIK_API_TOKEN_SECRET_ARN = 'arn:aws:secretsmanager:fake:fake:secret:fake';

    Sinon.stub(AuthentikProvider.prototype, 'auth').resolves({
        expires: new Date(Date.now() + 60_000),
        token: 'fake-authentik-token',
    });

    // enrollUserCertificate is exercised elsewhere (login.srv.test.ts /
    // OIDC_FORCED tests above) via the real HTTP mock TAK server - stub it
    // here purely so this test can focus on the attribute-sync/updated-bump
    // behaviour without also having to mock the Authentik core API user
    // lookup + password endpoints it depends on internally.
    Sinon.stub(AuthentikProvider.prototype, 'enrollUserCertificate').resolves({
        cert: '',
        key: '',
        ca: [],
    });

    Sinon.stub(AuthentikProvider.prototype, 'login').resolves({
        id: 42,
        name: 'Attribute Sync User',
        phone: null,
        system_admin: false,
        agency_admin: [],
        tak_callsign: 'ATTRSYNC',
        tak_group: 'Blue',
        tak_role: 'Team Lead',
    });

    try {
        const location = await ssoLogin();
        const payload = ssoPayload(location);
        assert.equal(payload.email, 'attributesync@example.com');

        const res = await fetch(`${flight.base}/api/profile`, {
            headers: { Authorization: `Bearer ${payload.token}` },
        });
        const profile = await res.json();

        assert.equal(profile.tak_callsign, 'ATTRSYNC');
        assert.equal(profile.tak_group, 'Blue');
        assert.equal(profile.tak_role, 'Team Lead');

        // The core regression check: created !== updated once real Authentik
        // attributes have been synced in, which is exactly what the frontend's
        // hasNoConfiguration() and the backend's isFirstLogin check rely on to
        // decide whether to show the "Welcome" dialog again.
        assert.notEqual(
            profile.updated, profile.created,
            'Profile.updated must be bumped once Authentik attribute sync succeeds, otherwise the Welcome dialog keeps reappearing',
        );
    } finally {
        Sinon.restore();
        delete process.env.AUTHENTIK_URL;
        delete process.env.AUTHENTIK_API_TOKEN_SECRET_ARN;
    }
});

test('stop: mock OIDC IdP', async () => {
    delete process.env.OIDC_ENABLED;
    delete process.env.OIDC_FORCED;
    delete process.env.OIDC_DISCOVERY_URL;
    delete process.env.OIDC_CLIENT_ID;
    delete process.env.OIDC_CLIENT_SECRET;

    await new Promise<void>((resolve, reject) => {
        idp.close(err => err ? reject(err) : resolve());
    });
});

flight.landing();
