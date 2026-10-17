import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import jwt from 'jsonwebtoken';
import Flight from './flight.js';
import { __resetForTests, upstreamAllowForTests } from '../stateless/lib/weather/relay-upstream.js';

const flight = new Flight();

flight.init({ takserver: true });
flight.takeoff();
flight.user();
flight.user({ admin: false });

// 1x1 transparent PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const KEY = 'test-weather-key-0123456789';

// A multiple of 600 s so the snapshot arithmetic is easy to read
const NOW_S = 1800000000;
const LATEST = NOW_S - 600;
let nowMs = NOW_S * 1000;

type Mode = 'ok' | 'nocache' | '500' | '401' | '403' | '404' | '400' | '429' | '302' | 'notpng' | 'wrongtype' | 'huge' | 'fallback' | 'error' | 'slow';

let upstream: http.Server;
let upstreamOrigin = '';
let mode: Mode = 'ok';
let delayMs = 0;
const hits: string[] = [];

// Everything the API writes to the console for the whole file
const logs: string[] = [];
const original = { info: console.info, warn: console.warn, error: console.error };
for (const level of ['info', 'warn', 'error'] as const) {
    console[level] = (...args: unknown[]) => {
        logs.push(args.map(a => a instanceof Error ? a.stack : typeof a === 'string' ? a : JSON.stringify(a)).join(' '));
    };
}

function configure(opts: { url?: string | null; key?: string | null; rate?: string | null } = {}) {
    const set = (name: string, value: string | null | undefined, fallback: string | null) => {
        const v = value === undefined ? fallback : value;
        if (v === null) {
            delete process.env[name];
        } else {
            process.env[name] = v;
        }
    };

    set('WEATHER_PROXY_URL', opts.url, `${upstreamOrigin}/weather`);
    set('WEATHER_PROXY_KEY', opts.key, KEY);
    set('WEATHER_RATE_LIMIT', opts.rate, null);
}

function fresh(opts: { env?: Parameters<typeof configure>[0]; upstreamTimeoutMs?: number; cacheMaxBytes?: number } = {}) {
    nowMs = NOW_S * 1000;
    mode = 'ok';
    delayMs = 0;
    hits.length = 0;
    configure(opts.env);
    __resetForTests({ now: () => nowMs, upstreamTimeoutMs: opts.upstreamTimeoutMs, cacheMaxBytes: opts.cacheMaxBytes });
}

interface TileResult {
    status: number;
    headers: Headers;
    body: Buffer;
    json: () => { status: number; message: string };
}

async function tile(
    query: string,
    opts: { z?: number | string; x?: number | string; y?: number | string; auth?: 'user' | 'admin' | 'query' | 'none' | string } = {},
): Promise<TileResult> {
    const { z = 4, x = 3, y = 5 } = opts;
    const auth = opts.auth ?? 'user';

    let url = `/api/weather/tile/${z}/${x}/${y}.png`;
    const req: { headers?: Record<string, string>; auth?: { bearer: string } } = {};
    let search = query;

    if (auth === 'query') {
        search += `${search ? '&' : ''}token=${flight.token.user}`;
    } else if (auth === 'user' || auth === 'admin') {
        req.auth = { bearer: flight.token[auth] };
    } else if (auth !== 'none') {
        req.auth = { bearer: auth };
    }

    if (search) url += `?${search}`;

    const res = await flight.fetch(url, req, { json: false, binary: true });
    const body = Buffer.from(res.body);
    return {
        status: res.status,
        headers: res.headers,
        body,
        json: () => JSON.parse(body.toString()),
    };
}

async function status(auth: 'user' | 'none' = 'user') {
    const req: { auth?: { bearer: string } } = {};
    if (auth === 'user') req.auth = { bearer: flight.token.user };
    return await flight.fetch('/api/weather/status', req, false);
}

function assertPng(res: TileResult, expected = PNG) {
    assert.equal(res.status, 200, res.status === 200 ? '' : res.body.toString());
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.ok(res.body.equals(expected), 'body is the upstream png');
}

function assertError(res: TileResult, code: number, message?: string) {
    assert.equal(res.status, code, res.body.toString());
    assert.equal(res.headers.get('cache-control'), 'no-store');
    if (message) assert.equal(res.json().message, message);
}

test('start upstream weather proxy', async () => {
    upstream = http.createServer((req, res) => {
        hits.push(String(req.url));

        const respond = () => {
            const headers: Record<string, string | number> = { 'x-upstream-leak': 'yes', 'set-cookie': 'upstream=1' };

            switch (mode) {
                case 'ok':
                    res.writeHead(200, { ...headers, 'content-type': 'image/png' });
                    res.end(PNG);
                    return;
                case 'nocache':
                    res.writeHead(200, { ...headers, 'content-type': 'image/png', 'cache-control': 'no-store' });
                    res.end(PNG);
                    return;
                case 'fallback':
                    res.writeHead(200, { ...headers, 'content-type': 'image/png', 'x-weather-fallback': 'rainviewer' });
                    res.end(PNG);
                    return;
                case 'error':
                    res.writeHead(200, { ...headers, 'content-type': 'image/png', 'x-weather-error': '1' });
                    res.end(PNG);
                    return;
                case 'notpng':
                    res.writeHead(200, { ...headers, 'content-type': 'image/png' });
                    res.end('this is not a png file at all');
                    return;
                case 'wrongtype':
                    res.writeHead(200, { ...headers, 'content-type': 'text/html' });
                    res.end(PNG);
                    return;
                case 'huge':
                    res.writeHead(200, { ...headers, 'content-type': 'image/png' });
                    res.end(Buffer.concat([PNG, Buffer.alloc((1024 * 1024) + 1)]));
                    return;
                case '302':
                    res.writeHead(302, { ...headers, location: '/elsewhere.png' });
                    res.end();
                    return;
                case '429':
                    res.writeHead(429, { ...headers, 'retry-after': '7', 'content-type': 'application/json' });
                    res.end(JSON.stringify({ error: 'UPSTREAM-BODY-SECRET' }));
                    return;
                default:
                    res.writeHead(Number(mode), { ...headers, 'content-type': 'application/json' });
                    res.end(JSON.stringify({ error: 'UPSTREAM-BODY-SECRET' }));
            }
        };

        if (mode === 'slow') {
            setTimeout(respond, 2000).unref();
            // Never answer a 'slow' request in time
            mode = 'ok';
        } else if (delayMs) {
            setTimeout(respond, delayMs);
        } else {
            respond();
        }
    });

    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', () => resolve()));
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('Could not determine upstream address');
    upstreamOrigin = `http://127.0.0.1:${address.port}`;
    upstreamAllowForTests.push(upstreamOrigin);
});

test('1. authentication', async () => {
    fresh();

    const none = await tile('layer=precip', { auth: 'none' });
    assertError(none, 401);

    const garbage = await tile('layer=precip', { auth: 'garbage' });
    assertError(garbage, 401);

    const garbageQuery = await flight.fetch('/api/weather/tile/4/3/5.png?layer=precip&token=garbage', {}, { json: false, binary: true });
    assert.equal(garbageQuery.status, 401);

    // A resource token is not a user session
    const resource = jwt.sign({ access: 'data', id: 1, internal: true }, 'coe-wildland-fire');
    const resourceRes = await tile('layer=precip', { auth: `etl.${resource}` });
    assert.ok([401, 403].includes(resourceRes.status), `resource token refused (${resourceRes.status})`);
    assertError(resourceRes, resourceRes.status);

    const resourceQuery = await flight.fetch(`/api/weather/tile/4/3/5.png?layer=precip&token=etl.${resource}`, {}, { json: false, binary: true });
    assert.ok([401, 403].includes(resourceQuery.status));

    assert.equal(hits.length, 0, 'upstream untouched');
});

test('2. success with bearer and with ?token=', async () => {
    fresh();

    const bearer = await tile('layer=precip&forecast=10&color=2');
    assertPng(bearer);
    assert.equal(bearer.headers.get('cache-control'), 'private, max-age=600');
    assert.equal(bearer.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(bearer.headers.get('x-weather-api'), '1');
    assert.equal(bearer.headers.get('x-weather-snapshot'), String(LATEST));
    assert.equal(bearer.headers.get('x-weather-cache'), 'miss');
    assert.equal(bearer.headers.get('attribution'), 'Weather data provided by Rainbow.ai');
    assert.equal(bearer.headers.get('content-length'), String(PNG.byteLength));

    const query = await tile('layer=precip&forecast=10&color=2', { auth: 'query' });
    assertPng(query);
    assert.equal(query.headers.get('x-weather-cache'), 'hit');

    assert.equal(hits.length, 1);

    // Nothing from the upstream and nothing secret is passed on
    for (const res of [bearer, query]) {
        assert.equal(res.headers.get('x-upstream-leak'), null);
        assert.equal(res.headers.get('set-cookie'), null);
        assert.ok(!JSON.stringify([...res.headers.entries()]).includes(KEY));
        assert.ok(!res.body.toString('latin1').includes(KEY));
    }
});

test('3. disabled when the environment is not configured', async () => {
    for (const env of [
        { url: null },
        { key: null },
        { url: null, key: null },
        { url: 'not a url' },
        { url: `${upstreamOrigin}/weather?x=1` },
        { url: 'http://example.com/weather' },
        { key: 'short' },
        { key: 'bad key with spaces!!' },
    ]) {
        fresh({ env });
        const res = await tile('layer=precip');
        assertError(res, 403, 'Weather is disabled');
        assert.equal(hits.length, 0, JSON.stringify(env));
    }
});

test('3b. configuration is read on every request', async () => {
    fresh({ env: { url: null } });
    assertError(await tile('layer=precip'), 403, 'Weather is disabled');

    configure();
    assertPng(await tile('layer=precip'));

    configure({ key: null });
    assertError(await tile('layer=precip&forecast=10'), 403, 'Weather is disabled');
});

test('4. exact upstream URL per layer and option', async () => {
    const cases: Array<[string, string]> = [
        ['layer=precip', `layer=precip&snapshot=${LATEST}`],
        ['layer=precip-global&forecast=40&color=3&coverage=1&size=512', `layer=precip-global&color=3&forecast=40&coverage=1&snapshot=${LATEST}&size=512`],
        ['layer=clouds', `layer=clouds&snapshot=${LATEST}`],
        ['layer=radars&color=dbz_u8&coverage=1&use_precip_type=1', `layer=radars&color=dbz_u8&coverage=1&use_precip_type=1&snapshot=${LATEST}`],
        [`layer=precip&snapshot=${LATEST - 1200}`, `layer=precip&snapshot=${LATEST - 1200}`],
    ];

    for (const [query, expected] of cases) {
        fresh();
        assertPng(await tile(`${query}&token=${flight.token.user}`));
        assert.equal(hits.length, 1, query);
        assert.equal(hits[0], `/weather/4/3/5.png?provider=rainbow&${expected}&api=${KEY}`);
        assert.ok(!hits[0].includes('token'));
        assert.ok(!hits[0].includes(flight.token.user));
    }

    fresh();
    assertPng(await tile('layer=precip', { z: 9, x: 511, y: 0 }));
    assert.ok(hits[0].startsWith('/weather/9/511/0.png?provider=rainbow&layer=precip&'));
});

test('5. smuggling attempts are rejected before the upstream', async () => {
    fresh();

    for (const query of [
        'layer=precip&api=evil',
        'layer=precip&key=x',
        'layer=precip&provider=rainviewer',
        'layer=precip&foo=1',
        'layer=clouds&layer=precip',
        'layer=precip&forecast=10&forecast=20',
        'layer=precip&token=a&token=b',
    ]) {
        const res = await tile(query, query.includes('token=') ? { auth: 'user' } : {});
        assertError(res, 400);
    }

    // Repeated token (the first one is the valid session)
    const res = await flight.fetch(`/api/weather/tile/4/3/5.png?layer=precip&token=${flight.token.user}&token=${flight.token.user}`, {}, { json: false, binary: true });
    assert.equal(res.status, 400);

    assert.equal(hits.length, 0);
});

test('6. per layer rules', async () => {
    fresh();

    for (const query of [
        'layer=clouds&color=0',
        'layer=clouds&coverage=0',
        'layer=clouds&coverage=1',
        'layer=clouds&forecast=10',
        'layer=clouds&use_precip_type=1',
        'layer=radars&forecast=10',
        'layer=precip&use_precip_type=0',
        'layer=precip&use_precip_type=1',
        'layer=precip-global&use_precip_type=1',
        ...['5', '250', '-10', 'abc', '040', '1.5'].map(f => `layer=precip&forecast=${f}`),
    ]) {
        assertError(await tile(query), 400);
    }
    assert.equal(hits.length, 0);

    assertPng(await tile('layer=clouds&forecast=0'));
    assert.ok(!hits[0].includes('forecast'));

    assertPng(await tile('layer=radars&use_precip_type=1'));
    assert.ok(hits[1].includes('&use_precip_type=1&'));

    assertPng(await tile('layer=precip&forecast=0'));
    assert.ok(!hits[2].includes('forecast'));

    assertPng(await tile('layer=precip&forecast=240'));
    assert.ok(hits[3].includes('&forecast=240&'));

    assertError(await tile(''), 400);
    assertError(await tile('layer=wind'), 400);
});

test('7. coordinates', async () => {
    fresh();

    assertError(await tile('layer=precip', { z: 10, x: 0, y: 0 }), 400);
    assertError(await tile('layer=precip', { z: 6, x: 64, y: 0 }), 400);
    assertError(await tile('layer=precip', { z: 6, x: 0, y: 64 }), 400);
    assertError(await tile('layer=precip', { z: -1, x: 0, y: 0 }), 400);
    assertError(await tile('layer=precip', { z: 4, x: -3, y: 0 }), 400);
    assertError(await tile('layer=precip', { z: 'a', x: 0, y: 0 }), 400);
    assertError(await tile('layer=precip', { z: 4, x: 'b', y: 0 }), 400);
    assertError(await tile('layer=precip', { z: 4, x: 0, y: 'c' }), 400);
    assert.equal(hits.length, 0);

    assertPng(await tile('layer=precip', { z: 0, x: 0, y: 0 }));
    assertPng(await tile('layer=precip', { z: 6, x: 63, y: 63 }));
});

test('8. snapshot window', async () => {
    fresh();

    for (const snapshot of [`${LATEST}`, `${LATEST - 7200}`, 'latest']) {
        assertPng(await tile(`layer=precip&snapshot=${snapshot}`));
    }

    for (const snapshot of [`${LATEST - 7800}`, `${LATEST + 600}`, `${LATEST - 1}`, '179999940', 'abc', `${LATEST}0`]) {
        assertError(await tile(`layer=precip&snapshot=${snapshot}`), 400);
    }

    // Absent means latest
    const absent = await tile('layer=precip&forecast=10');
    assert.equal(absent.headers.get('x-weather-snapshot'), String(LATEST));

    // The window moves with the clock
    nowMs += 600 * 1000;
    const later = await tile('layer=precip&forecast=10');
    assert.equal(later.headers.get('x-weather-snapshot'), String(LATEST + 600));
    assert.equal(later.headers.get('x-weather-cache'), 'miss');
    assertError(await tile(`layer=precip&snapshot=${LATEST - 7200}`), 400);
});

test('9. size and color', async () => {
    fresh();

    assertPng(await tile('layer=precip&size=512'));
    assert.ok(hits[0].includes('&size=512&'));

    assertPng(await tile('layer=precip&size=256&color=1'));
    assert.ok(!hits[1].includes('size='));

    assertError(await tile('layer=precip&size=128'), 400);
    assertError(await tile('layer=precip&size=1024'), 400);

    assertPng(await tile('layer=precip&color=dbz_u8'));
    assert.ok(hits[2].includes('&color=dbz_u8&'));
    assertError(await tile('layer=precip&color=10'), 400);
    assertError(await tile('layer=precip&color=-1'), 400);
});

test('10. per user rate limit with a fixed window', async () => {
    fresh({ env: { rate: '60' } });

    // Distinct tiles are not needed: cache hits also count
    for (let i = 1; i <= 60; i++) {
        const res = await tile('layer=precip');
        assert.equal(res.status, 200, `request ${i}`);
    }

    const denied = await tile('layer=precip');
    assertError(denied, 429);
    const first = Number(denied.headers.get('retry-after'));
    assert.ok(first >= 1 && first <= 60, `retry-after ${first}`);

    // The second user is unaffected
    assert.equal((await tile('layer=precip', { auth: 'admin' })).status, 200);

    // A later hit does not extend the window, the retry hint only shrinks
    nowMs += 30 * 1000;
    const stillDenied = await tile('layer=precip');
    assertError(stillDenied, 429);
    const second = Number(stillDenied.headers.get('retry-after'));
    assert.ok(second >= 1 && second < first, `retry-after ${second} < ${first}`);

    // The next window starts clean
    nowMs += 30 * 1000;
    assert.equal((await tile('layer=precip')).status, 200);
});

test('10b. invalid requests count against the limit', async () => {
    fresh({ env: { rate: '60' } });

    for (let i = 0; i < 60; i++) assertError(await tile('layer=wind'), 400);

    assertError(await tile('layer=precip'), 429);
    assert.equal(hits.length, 0);
});

test('11. upstream fetch budget per user', async () => {
    // rate 600 allows 200 upstream fetches per user and minute
    fresh({ env: { rate: '600' } });

    const tiles: Array<[number, number]> = [];
    for (let x = 0; x < 16; x++) {
        for (let y = 0; y < 16; y++) tiles.push([x, y]);
    }

    for (let i = 0; i < 200; i++) {
        const [x, y] = tiles[i];
        const res = await tile('layer=precip', { z: 4, x, y });
        assert.equal(res.status, 200, `fetch ${i + 1}`);
    }
    assert.equal(hits.length, 200);

    // A cached tile is not a fetch
    assert.equal((await tile('layer=precip', { z: 4, x: 0, y: 0 })).headers.get('x-weather-cache'), 'hit');

    const [x, y] = tiles[200];
    const denied = await tile('layer=precip', { z: 4, x, y });
    assertError(denied, 429);
    assert.ok(Number(denied.headers.get('retry-after')) >= 1);
    assert.equal(hits.length, 200);

    // Another user has their own budget
    assert.equal((await tile('layer=precip', { z: 4, x, y, auth: 'admin' })).status, 200);
});

test('12. upstream errors', async () => {
    fresh({ upstreamTimeoutMs: 250 });

    const failing: Array<[Mode, number, string]> = [
        ['500', 502, 'Weather upstream unavailable'],
        ['huge', 502, 'Weather upstream unavailable'],
        ['notpng', 502, 'Weather upstream unavailable'],
        ['wrongtype', 502, 'Weather upstream unavailable'],
        ['302', 502, 'Weather upstream unavailable'],
        ['404', 502, 'Weather upstream not found'],
        ['400', 502, 'Weather upstream rejected the request'],
        ['401', 502, 'Weather upstream authentication failed'],
        ['403', 502, 'Weather upstream authentication failed'],
    ];

    for (const [m, code, message] of failing) {
        mode = m;
        const before = hits.length;
        const res = await tile('layer=precip');
        assertError(res, code, message);
        assert.ok(!res.body.toString().includes('UPSTREAM-BODY-SECRET'));
        assert.equal(res.headers.get('set-cookie'), null);

        // Errors are never cached
        mode = m;
        assertError(await tile('layer=precip'), code, message);
        assert.equal(hits.length, before + 2, m);
    }

    mode = 'slow';
    const slow = await tile('layer=precip&forecast=10');
    assertError(slow, 502, 'Weather upstream unavailable');

    mode = '429';
    const limited = await tile('layer=precip&forecast=20');
    assertError(limited, 429);
    assert.equal(limited.headers.get('retry-after'), '7');

    // A healthy upstream answers the very same request next
    mode = 'ok';
    assertPng(await tile('layer=precip'));
});

test('12b. a blocked upstream address is a 502', async () => {
    fresh({ env: { url: 'https://127.0.0.1:1/weather' } });

    const res = await tile('layer=precip');
    assertError(res, 502, 'Weather upstream unavailable');
    assert.equal(hits.length, 0);
});

test('13. fallback and error headers', async () => {
    fresh();

    // Current radar is acceptable only for a request that asks for current data
    mode = 'fallback';
    const now = await tile('layer=precip');
    assertPng(now);
    assert.equal(now.headers.get('cache-control'), 'private, max-age=30');
    assert.equal(now.headers.get('x-weather-fallback'), null);

    const again = await tile('layer=precip');
    assertPng(again);
    assert.equal(again.headers.get('x-weather-cache'), 'miss', 'fallback tiles are not cached');
    assert.equal(hits.length, 2);

    mode = 'fallback';
    assertError(await tile('layer=precip&forecast=40'), 502, 'Weather upstream unavailable');

    // A transparent error tile is never shown
    for (const query of ['layer=precip', 'layer=precip&forecast=40', 'layer=clouds', 'layer=radars']) {
        mode = 'error';
        assertError(await tile(query), 502, 'Weather upstream unavailable');
    }

    // An older proxy without the headers behaves like a healthy one
    fresh();
    assertPng(await tile('layer=precip&forecast=40'));
    const hit = await tile('layer=precip&forecast=40');
    assert.equal(hit.headers.get('x-weather-cache'), 'hit');
    assert.equal(hit.headers.get('cache-control'), 'private, max-age=600');
    assert.equal(hits.length, 1);

    // The upstream can opt out of caching
    fresh();
    mode = 'nocache';
    assertPng(await tile('layer=precip'));
    mode = 'nocache';
    assertPng(await tile('layer=precip'));
    assert.equal(hits.length, 2);
});

test('14. cache', async () => {
    fresh();

    const first = await tile('layer=precip&forecast=10');
    assert.equal(first.headers.get('x-weather-cache'), 'miss');

    const second = await tile('layer=precip&forecast=10');
    assert.equal(second.headers.get('x-weather-cache'), 'hit');
    assert.equal(hits.length, 1);

    // The cache is shared between users
    const other = await tile('layer=precip&forecast=10', { auth: 'admin' });
    assert.equal(other.headers.get('x-weather-cache'), 'hit');
    assertPng(other);
    assert.equal(hits.length, 1);

    // Different parameters and a different snapshot are different tiles
    assert.equal((await tile('layer=precip&forecast=20')).headers.get('x-weather-cache'), 'miss');
    assert.equal((await tile(`layer=precip&forecast=10&snapshot=${LATEST - 600}`)).headers.get('x-weather-cache'), 'miss');
    assert.equal((await tile('layer=precip&forecast=10', { x: 4 })).headers.get('x-weather-cache'), 'miss');
    assert.equal(hits.length, 4);

    // Entries expire after 10 minutes. The snapshot is pinned so the key stays the same.
    const pinned = `layer=precip&forecast=30&snapshot=${LATEST - 600}`;
    assert.equal((await tile(pinned)).headers.get('x-weather-cache'), 'miss');
    nowMs += 599 * 1000;
    assert.equal((await tile(pinned)).headers.get('x-weather-cache'), 'hit');
    nowMs += 2 * 1000;
    assert.equal((await tile(pinned)).headers.get('x-weather-cache'), 'miss');
});

test('14b. least recently used tiles are evicted when the byte budget is full', async () => {
    // Room for exactly two tiles
    fresh({ cacheMaxBytes: PNG.byteLength * 2 });

    await tile('layer=precip', { x: 0 });
    await tile('layer=precip', { x: 1 });
    assert.equal((await tile('layer=precip', { x: 0 })).headers.get('x-weather-cache'), 'hit');

    // x=1 is now the least recently used and makes room for x=2
    await tile('layer=precip', { x: 2 });
    assert.equal((await tile('layer=precip', { x: 0 })).headers.get('x-weather-cache'), 'hit');
    assert.equal((await tile('layer=precip', { x: 1 })).headers.get('x-weather-cache'), 'miss');
});

test('15. concurrent identical requests share one upstream fetch', async () => {
    fresh();
    delayMs = 150;

    const results = await Promise.all(Array.from({ length: 10 }, () => tile('layer=precip&forecast=10')));

    assert.equal(hits.length, 1);
    for (const res of results) assertPng(res);

    const states = results.map(r => r.headers.get('x-weather-cache'));
    assert.equal(states.filter(s => s === 'miss').length, 1);
    assert.equal(states.filter(s => s === 'shared').length, 9);
});

test('15b. followers of a failing flight get the same error and nothing is cached', async () => {
    fresh();
    delayMs = 100;
    mode = '500';

    const results = await Promise.all(Array.from({ length: 4 }, () => tile('layer=precip')));
    assert.equal(hits.length, 1);
    for (const res of results) assertError(res, 502);

    mode = 'ok';
    delayMs = 0;
    assertPng(await tile('layer=precip'));
    assert.equal(hits.length, 2);
});

test('16. status', async () => {
    fresh();

    const anonymous = await status('none');
    assert.equal(anonymous.status, 401);

    const res = await status();
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(Object.keys(res.body).sort(), ['apiVersion', 'enabled', 'layers', 'serverTime', 'snapshot']);
    assert.deepEqual(res.body, {
        apiVersion: 1,
        enabled: true,
        serverTime: NOW_S,
        snapshot: LATEST,
        layers: ['precip', 'precip-global', 'clouds', 'radars'],
    });
    assert.equal(res.body.snapshot % 600, 0);
    assert.ok(!JSON.stringify(res.body).includes(KEY));
    assert.ok(!JSON.stringify(res.body).includes(upstreamOrigin));

    nowMs += (600 * 1000) + 5000;
    const later = await status();
    assert.equal(later.body.serverTime, NOW_S + 605);
    assert.equal(later.body.snapshot, Math.floor((NOW_S + 605) / 600) * 600 - 600);

    // The status call never contacts the proxy
    assert.equal(hits.length, 0);

    // A disabled relay is reported, not an error
    fresh({ env: { url: null } });
    const disabled = await status();
    assert.equal(disabled.status, 200);
    assert.equal(disabled.body.enabled, false);
    assert.deepEqual(disabled.body.layers, []);
    assert.equal(disabled.body.snapshot % 600, 0);

    // 60 calls a minute
    fresh();
    for (let i = 0; i < 60; i++) assert.equal((await status()).status, 200, `call ${i + 1}`);
    const limited = await status();
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
    nowMs += 60 * 1000;
    assert.equal((await status()).status, 200);
});

test('17. secrets never reach the logs', async () => {
    // Provoke the error paths that log: upstream failures and bad configuration
    fresh();
    mode = '401';
    await tile('layer=precip');
    mode = '500';
    await tile('layer=precip&forecast=10');
    configure({ url: 'not a url', key: 'bad key' });
    await tile('layer=precip');
    configure();
    mode = 'ok';
    assertPng(await tile('layer=precip&forecast=20', { auth: 'query' }));

    assert.ok(logs.length > 0);

    const sessions = [flight.token.user, flight.token.admin];
    for (const line of logs) {
        assert.ok(!line.includes(KEY), 'api key in log');
        for (const session of sessions) assert.ok(!line.includes(session), 'session token in log');
    }

    const audit = logs.filter(l => l.startsWith('{') && l.includes('"type":"weather"'));
    assert.ok(audit.length > 0);
    for (const line of audit) {
        const parsed = JSON.parse(line);
        assert.equal(parsed.type, 'weather');
        assert.ok('username' in parsed && 'status' in parsed && 'cache' in parsed && 'ms' in parsed);
        assert.ok(!('token' in parsed) && !('query' in parsed));
    }

    const last = JSON.parse(audit[audit.length - 1]);
    assert.equal(last.username, 'user@example.com');
    assert.equal(last.layer, 'precip');
    assert.equal(last.forecast, 20);
    assert.equal(last.status, 200);
    assert.equal(last.cache, 'miss');
});

test('stop upstream weather proxy', async () => {
    for (const level of ['info', 'warn', 'error'] as const) console[level] = original[level];

    upstreamAllowForTests.length = 0;
    delete process.env.WEATHER_PROXY_URL;
    delete process.env.WEATHER_PROXY_KEY;
    delete process.env.WEATHER_RATE_LIMIT;

    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
});

flight.landing();
