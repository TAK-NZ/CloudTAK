import test from 'node:test';
import assert from 'node:assert';
import { getRelayConfig, upstreamAllowForTests, __resetWarned } from '../stateless/lib/weather/relay-config.js';
import {
    buildUpstreamUrl,
    latestSnapshot,
    parseTileRequest,
    tileCacheKey,
} from '../stateless/lib/weather/relay-request.js';
import { FixedWindowLimiter } from '../stateless/lib/weather/relay-limiter.js';
import { TileCache, SingleFlight } from '../stateless/lib/weather/relay-cache.js';
import {
    PAUSE_DEFAULT_S,
    PAUSE_MAX_S,
    PAUSE_MIN_S,
    __resetForTests,
    pauseUpstream,
    redactUrl,
    relay,
    upstreamPausedFor,
} from '../stateless/lib/weather/relay-upstream.js';

const KEY = 'abcdefghijklmnop1234';
const NOW_S = 1800000000;
const LATEST = NOW_S - 600;

function parse(params: Record<string, string | number>, query: string) {
    const p = { z: 4, x: 3, y: 5, ...params };
    return parseTileRequest(p, new URLSearchParams(query), NOW_S);
}

function rejects(params: Record<string, string | number>, query: string) {
    assert.throws(() => parse(params, query), (err: { status?: number }) => err.status === 400, `${JSON.stringify(params)} ${query}`);
}

test('latestSnapshot', () => {
    assert.equal(latestSnapshot(NOW_S), LATEST);
    assert.equal(latestSnapshot(NOW_S + 599), LATEST);
    assert.equal(latestSnapshot(NOW_S + 600), LATEST + 600);
});

test('parseTileRequest: accepts every valid combination', () => {
    assert.deepEqual(parse({}, 'layer=precip'), {
        layer: 'precip', z: 4, x: 3, y: 5, forecast: 0, snapshot: LATEST, size: 256, color: null, coverage: false, usePrecipType: false,
    });

    for (const layer of ['precip', 'precip-global']) {
        assert.equal(parse({}, `layer=${layer}&forecast=240`).forecast, 240);
        assert.equal(parse({}, `layer=${layer}&forecast=0`).forecast, 0);
        assert.equal(parse({}, `layer=${layer}&forecast=10&color=dbz_u8&coverage=1`).color, 'dbz_u8');
        assert.equal(parse({}, `layer=${layer}&coverage=0`).coverage, false);
    }

    assert.equal(parse({}, 'layer=clouds&forecast=0').forecast, 0);
    assert.equal(parse({}, 'layer=radars&use_precip_type=1').usePrecipType, true);
    assert.equal(parse({}, 'layer=radars&color=9&coverage=1').coverage, true);
    assert.equal(parse({}, 'layer=precip&size=512').size, 512);
    assert.equal(parse({}, 'layer=precip&token=anything').layer, 'precip');
    assert.equal(parse({ z: 0, x: 0, y: 0 }, 'layer=precip').z, 0);
    assert.equal(parse({ z: 9, x: 511, y: 511 }, 'layer=precip').x, 511);

    for (const color of ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'dbz_u8']) {
        assert.equal(parse({}, `layer=precip&color=${color}`).color, color);
    }
});

test('parseTileRequest: layer', () => {
    rejects({}, '');
    rejects({}, 'layer=');
    rejects({}, 'layer=wind');
    rejects({}, 'layer=Precip');
});

test('parseTileRequest: coordinates', () => {
    rejects({ z: 10, x: 0, y: 0 }, 'layer=precip');
    rejects({ z: 6, x: 64, y: 0 }, 'layer=precip');
    rejects({ z: 6, x: 0, y: 64 }, 'layer=precip');
    rejects({ z: -1, x: 0, y: 0 }, 'layer=precip');
    rejects({ z: 4, x: -1, y: 0 }, 'layer=precip');
    rejects({ z: 4, x: 'a', y: 0 }, 'layer=precip');
    rejects({ z: 4, x: 1.5, y: 0 }, 'layer=precip');
});

test('parseTileRequest: forecast', () => {
    for (const forecast of ['5', '250', '-10', 'abc', '040', '1.5', '', '250000', '1e1', ' 10']) {
        rejects({}, `layer=precip&forecast=${encodeURIComponent(forecast)}`);
    }

    for (const forecast of ['10', '20']) {
        rejects({}, `layer=clouds&forecast=${forecast}`);
        rejects({}, `layer=radars&forecast=${forecast}`);
    }
});

test('parseTileRequest: snapshot', () => {
    assert.equal(parse({}, 'layer=precip&snapshot=latest').snapshot, LATEST);
    assert.equal(parse({}, `layer=precip&snapshot=${LATEST}`).snapshot, LATEST);
    assert.equal(parse({}, `layer=precip&snapshot=${LATEST - 7200}`).snapshot, LATEST - 7200);

    rejects({}, `layer=precip&snapshot=${LATEST - 7800}`);
    rejects({}, `layer=precip&snapshot=${LATEST + 600}`);
    rejects({}, `layer=precip&snapshot=${LATEST - 1}`);
    rejects({}, 'layer=precip&snapshot=179999940');
    rejects({}, 'layer=precip&snapshot=abc');
    rejects({}, 'layer=precip&snapshot=');
    rejects({}, `layer=precip&snapshot=${LATEST}0`);
});

test('parseTileRequest: size, color, coverage, use_precip_type', () => {
    rejects({}, 'layer=precip&size=128');
    rejects({}, 'layer=precip&size=1024');
    rejects({}, 'layer=precip&size=');
    rejects({}, 'layer=precip&color=10');
    rejects({}, 'layer=precip&color=-1');
    rejects({}, 'layer=precip&color=DBZ_U8');
    rejects({}, 'layer=precip&coverage=2');
    rejects({}, 'layer=precip&coverage=true');

    // clouds has no options at all, not even their default values
    rejects({}, 'layer=clouds&color=0');
    rejects({}, 'layer=clouds&coverage=0');
    rejects({}, 'layer=clouds&coverage=1');
    rejects({}, 'layer=clouds&use_precip_type=1');
    rejects({}, 'layer=clouds&use_precip_type=0');

    // use_precip_type is radars only, even with its default value
    rejects({}, 'layer=precip&use_precip_type=0');
    rejects({}, 'layer=precip&use_precip_type=1');
    rejects({}, 'layer=precip-global&use_precip_type=1');
    rejects({}, 'layer=radars&use_precip_type=2');
});

test('parseTileRequest: unknown and repeated keys', () => {
    rejects({}, 'layer=precip&api=evil');
    rejects({}, 'layer=precip&key=x');
    rejects({}, 'layer=precip&provider=rainviewer');
    rejects({}, 'layer=precip&foo=1');
    rejects({}, 'layer=clouds&layer=precip');
    rejects({}, 'layer=precip&forecast=10&forecast=20');
    rejects({}, 'layer=precip&token=a&token=b');
    rejects({}, 'layer=precip&Layer=precip');
});

test('parseTileRequest: error messages never echo a value', () => {
    for (const query of ['layer=precip&api=SECRETVALUE', 'layer=SECRETVALUE', 'layer=precip&forecast=SECRETVALUE', 'layer=precip&SECRETVALUE=1']) {
        try {
            parse({}, query);
            assert.fail('should throw');
        } catch (err) {
            assert.ok(!String((err as Error).message).includes('SECRETVALUE'), query);
        }
    }
});

test('buildUpstreamUrl: exact URLs', () => {
    const base = 'https://utils.example.com/weather';
    const build = (query: string, params = {}) => buildUpstreamUrl(base, parse(params, query), KEY).toString();

    assert.equal(
        build('layer=precip'),
        `https://utils.example.com/weather/4/3/5.png?provider=rainbow&layer=precip&snapshot=${LATEST}&api=${KEY}`,
    );
    assert.equal(
        build('layer=precip-global&forecast=40&color=3&coverage=1&size=512&snapshot=latest'),
        `https://utils.example.com/weather/4/3/5.png?provider=rainbow&layer=precip-global&color=3&forecast=40&coverage=1&snapshot=${LATEST}&size=512&api=${KEY}`,
    );
    assert.equal(
        build('layer=clouds&forecast=0'),
        `https://utils.example.com/weather/4/3/5.png?provider=rainbow&layer=clouds&snapshot=${LATEST}&api=${KEY}`,
    );
    assert.equal(
        build('layer=radars&color=dbz_u8&coverage=1&use_precip_type=1&token=abc'),
        `https://utils.example.com/weather/4/3/5.png?provider=rainbow&layer=radars&color=dbz_u8&coverage=1&use_precip_type=1&snapshot=${LATEST}&api=${KEY}`,
    );
    assert.equal(
        build('layer=radars&coverage=0&use_precip_type=0', { z: 9, x: 511, y: 0 }),
        `https://utils.example.com/weather/9/511/0.png?provider=rainbow&layer=radars&snapshot=${LATEST}&api=${KEY}`,
    );
    assert.ok(!build('layer=precip&token=abc').includes('token'));
});

test('tileCacheKey: stable, distinct and free of secrets', () => {
    const a = tileCacheKey(parse({}, 'layer=precip&token=SESSIONTOKEN'));
    const b = tileCacheKey(parse({}, 'layer=precip'));
    assert.equal(a, b);
    assert.ok(!a.includes('SESSIONTOKEN'));
    assert.ok(!a.includes('api'));

    const keys = new Set([
        'layer=precip',
        'layer=precip-global',
        'layer=precip&forecast=10',
        'layer=precip&color=2',
        'layer=precip&coverage=1',
        'layer=precip&size=512',
        `layer=precip&snapshot=${LATEST - 600}`,
        'layer=radars',
        'layer=radars&use_precip_type=1',
        'layer=clouds',
    ].map(q => tileCacheKey(parse({}, q))));
    assert.equal(keys.size, 10);
    assert.notEqual(tileCacheKey(parse({ x: 4 }, 'layer=precip')), b);
});

test('FixedWindowLimiter: counts, resets and never extends the window', () => {
    let now = 120000;
    const limiter = new FixedWindowLimiter({ windowMs: 60000, now: () => now });

    for (let i = 1; i <= 3; i++) assert.equal(limiter.hit('a', 3).ok, true);

    now = 150000;
    const denied = limiter.hit('a', 3);
    assert.equal(denied.ok, false);
    assert.equal(denied.retryAfterS, 30);

    // Hitting again late in the window must not push the reset further away
    now = 179999;
    const late = limiter.hit('a', 3);
    assert.equal(late.ok, false);
    assert.equal(late.retryAfterS, 1);

    // The next window starts clean even though the user kept hitting
    now = 180000;
    const next = limiter.hit('a', 3);
    assert.equal(next.ok, true);
    assert.equal(next.count, 1);

    // Other ids are independent
    assert.equal(limiter.hit('b', 3).count, 1);
    limiter.stop();
});

test('FixedWindowLimiter: retryAfterS is at least 1 and at most the window', () => {
    let now = 60000;
    const limiter = new FixedWindowLimiter({ windowMs: 60000, now: () => now });
    assert.equal(limiter.hit('a', 0).retryAfterS, 60);
    now = 119999;
    assert.equal(limiter.hit('a', 0).retryAfterS, 1);
    limiter.stop();
});

test('FixedWindowLimiter: sweep drops old windows', () => {
    let now = 0;
    const limiter = new FixedWindowLimiter({ windowMs: 1000, now: () => now });
    limiter.hit('a', 1);
    limiter.hit('b', 1);
    assert.equal(limiter.size, 2);

    limiter.sweep();
    assert.equal(limiter.size, 2);

    now = 1000;
    limiter.sweep();
    assert.equal(limiter.size, 0);
    limiter.stop();
});

test('FixedWindowLimiter: maxIds bound', () => {
    let now = 0;
    const limiter = new FixedWindowLimiter({ windowMs: 1000, maxIds: 3, now: () => now });

    for (const id of ['a', 'b', 'c', 'd', 'e']) limiter.hit(id, 1);
    assert.equal(limiter.size, 3);

    // The oldest ids were dropped, the newest are still counted
    assert.equal(limiter.hit('e', 5).count, 2);
    assert.equal(limiter.hit('a', 5).count, 1);

    // Stale windows are swept before live ids are dropped
    now = 5000;
    limiter.hit('x', 1);
    assert.equal(limiter.size, 1);
    limiter.stop();
});

test('TileCache: TTL', () => {
    let now = 0;
    const cache = new TileCache({ ttlMs: 1000, now: () => now });
    assert.equal(cache.get('a'), undefined);

    assert.equal(cache.set('a', Buffer.from('one')), true);
    assert.equal(cache.get('a')?.toString(), 'one');

    now = 999;
    assert.equal(cache.get('a')?.toString(), 'one');

    now = 1000;
    assert.equal(cache.get('a'), undefined);
    assert.equal(cache.bytes, 0);
    assert.equal(cache.size, 0);
});

test('TileCache: LRU order and byte bound', () => {
    const cache = new TileCache({ maxBytes: 10, maxEntryBytes: 10 });
    cache.set('a', Buffer.alloc(4));
    cache.set('b', Buffer.alloc(4));

    // Touch a, so b is the least recently used
    assert.ok(cache.get('a'));
    cache.set('c', Buffer.alloc(4));

    assert.ok(cache.get('a'));
    assert.equal(cache.get('b'), undefined);
    assert.ok(cache.get('c'));
    assert.equal(cache.bytes, 8);

    // Replacing an entry does not double count it
    cache.set('a', Buffer.alloc(2));
    assert.equal(cache.bytes, 6);
});

test('TileCache: per entry cap', () => {
    const cache = new TileCache({ maxBytes: 100, maxEntryBytes: 5 });
    assert.equal(cache.set('big', Buffer.alloc(6)), false);
    assert.equal(cache.get('big'), undefined);
    assert.equal(cache.set('ok', Buffer.alloc(5)), true);

    const defaults = new TileCache();
    assert.equal(defaults.maxBytes, 64 * 1024 * 1024);
    assert.equal(defaults.ttlMs, 600000);
    assert.equal(defaults.maxEntryBytes, 1024 * 1024);
});

test('SingleFlight: one call for concurrent callers', async () => {
    const flights = new SingleFlight<string>();
    let calls = 0;

    const fn = async () => {
        calls++;
        await new Promise(resolve => setTimeout(resolve, 20));
        return 'value';
    };

    const results = await Promise.all(Array.from({ length: 5 }, () => flights.run('k', fn)));

    assert.equal(calls, 1);
    assert.equal(results.filter(r => !r.shared).length, 1);
    assert.equal(results.filter(r => r.shared).length, 4);
    assert.ok(results.every(r => r.value === 'value'));
    assert.equal(flights.size, 0);

    await flights.run('k', fn);
    assert.equal(calls, 2);
});

test('SingleFlight: different keys do not share; rejection clears the entry', async () => {
    const flights = new SingleFlight<string>();
    const [a, b] = await Promise.all([
        flights.run('a', async () => 'A'),
        flights.run('b', async () => 'B'),
    ]);
    assert.deepEqual([a.value, a.shared, b.value, b.shared], ['A', false, 'B', false]);

    await assert.rejects(flights.run('k', async () => {
        throw new Error('boom');
    }), /boom/);
    assert.equal(flights.has('k'), false);

    const retry = await flights.run('k', async () => 'again');
    assert.equal(retry.value, 'again');
});

test('redactUrl', () => {
    const out = redactUrl(`https://u.example.com/4/3/5.png?provider=rainbow&api=${KEY}&key=${KEY}&token=abc`);
    assert.ok(!out.includes(KEY));
    assert.ok(!out.includes('abc'));
    assert.ok(out.includes('provider=rainbow'));
    assert.ok(out.includes('api=***'));
    assert.ok(out.includes('key=***'));
    assert.ok(out.includes('token=***'));
    assert.equal(redactUrl('https://u.example.com/x'), 'https://u.example.com/x');
});

test('upstream pause: clamps Retry-After to 5..120 s, defaults to 30 s and ends on time', () => {
    let now = 1000000;
    __resetForTests({ now: () => now });
    assert.equal(PAUSE_DEFAULT_S, 30);
    assert.equal(PAUSE_MIN_S, 5);
    assert.equal(PAUSE_MAX_S, 120);
    assert.equal(upstreamPausedFor(), 0);

    const cases: Array<[number | null, number]> = [[null, 30], [0, 5], [1, 5], [4, 5], [5, 5], [7, 7], [120, 120], [121, 120], [999999, 120]];
    for (const [retry, expected] of cases) {
        __resetForTests({ now: () => now });
        assert.equal(pauseUpstream(retry), expected, `retry-after ${retry}`);
        assert.equal(upstreamPausedFor(), expected);
        now += (expected * 1000) - 1;
        assert.equal(upstreamPausedFor(), 1, 'one millisecond left rounds up to 1 s');
        now += 1;
        assert.equal(upstreamPausedFor(), 0, 'pause is over');
    }
});

test('upstream pause: a shorter pause never shortens a longer one; reset clears it', () => {
    const now = 5000;
    __resetForTests({ now: () => now });
    pauseUpstream(60);
    pauseUpstream(5);
    assert.equal(upstreamPausedFor(), 60);
    assert.ok(relay.pausedUntil > now);
    __resetForTests({ now: () => now });
    assert.equal(relay.pausedUntil, 0);
    assert.equal(upstreamPausedFor(), 0);
});

test('getRelayConfig', () => {
    const quiet = console.warn;
    const warnings: string[] = [];
    console.warn = (msg: string) => {
        warnings.push(String(msg));
    };

    try {
        const ok = { WEATHER_PROXY_URL: 'https://utils.example.com/weather', WEATHER_PROXY_KEY: KEY };

        assert.deepEqual(getRelayConfig(ok), { enabled: true, baseUrl: 'https://utils.example.com/weather', key: KEY, rate: 900 });
        assert.deepEqual(getRelayConfig({}), { enabled: false, baseUrl: null, key: null, rate: 900 });
        assert.equal(warnings.length, 0, 'unset values are not warned about');

        // Trailing slashes are stripped, whitespace trimmed
        assert.equal(getRelayConfig({ ...ok, WEATHER_PROXY_URL: ' https://utils.example.com/weather/// ' }).baseUrl, 'https://utils.example.com/weather');

        // The url is rejected when it is not a plain https base
        for (const url of [
            'http://utils.example.com/weather',
            'ftp://utils.example.com',
            'https://utils.example.com/weather?x=1',
            'https://utils.example.com/weather#frag',
            'https://user@utils.example.com/weather',
            'https://user:pw@utils.example.com/weather',
            'https://utils.example.com/we ather',
            `https://utils.example.com/${'a'.repeat(200)}`,
            'utils.example.com',
            'https://',
        ]) {
            const cfg = getRelayConfig({ ...ok, WEATHER_PROXY_URL: url });
            assert.equal(cfg.enabled, false, url);
            assert.equal(cfg.baseUrl, null, url);
        }

        // 200 characters exactly is fine
        const url200 = 'https://utils.example.com/' + 'a'.repeat(200 - 26);
        assert.equal(url200.length, 200);
        assert.equal(getRelayConfig({ ...ok, WEATHER_PROXY_URL: url200 }).enabled, true);

        // Key charset and length
        for (const key of ['short', 'a'.repeat(15), 'a'.repeat(129), 'abcdefghijklmnop 1234', 'abcdefghijklmnop&1234', 'abcdefghijklmnop=1234']) {
            const cfg = getRelayConfig({ ...ok, WEATHER_PROXY_KEY: key });
            assert.equal(cfg.enabled, false, key);
            assert.equal(cfg.key, null, key);
        }
        assert.equal(getRelayConfig({ ...ok, WEATHER_PROXY_KEY: 'a'.repeat(16) }).enabled, true);
        assert.equal(getRelayConfig({ ...ok, WEATHER_PROXY_KEY: 'A.b_c~d-' + '0'.repeat(120) }).enabled, true);

        // Rate
        assert.equal(getRelayConfig({ ...ok, WEATHER_RATE_LIMIT: '60' }).rate, 60);
        assert.equal(getRelayConfig({ ...ok, WEATHER_RATE_LIMIT: '6000' }).rate, 6000);
        for (const rate of ['59', '6001', 'abc', '1.5', '-60', '0', '']) {
            assert.equal(getRelayConfig({ ...ok, WEATHER_RATE_LIMIT: rate }).rate, 900, rate);
        }

        // Environment is read at call time
        const env: NodeJS.ProcessEnv = { ...ok };
        assert.equal(getRelayConfig(env).enabled, true);
        delete env.WEATHER_PROXY_KEY;
        assert.equal(getRelayConfig(env).enabled, false);
        env.WEATHER_PROXY_KEY = KEY;
        env.WEATHER_PROXY_URL = 'https://other.example.com';
        assert.equal(getRelayConfig(env).baseUrl, 'https://other.example.com');

        const saved = { ...process.env };
        process.env.WEATHER_PROXY_URL = 'https://a.example.com';
        process.env.WEATHER_PROXY_KEY = KEY;
        assert.equal(getRelayConfig().baseUrl, 'https://a.example.com');
        process.env.WEATHER_PROXY_URL = 'https://b.example.com';
        assert.equal(getRelayConfig().baseUrl, 'https://b.example.com');
        process.env.WEATHER_PROXY_URL = saved.WEATHER_PROXY_URL;
        process.env.WEATHER_PROXY_KEY = saved.WEATHER_PROXY_KEY;
        if (saved.WEATHER_PROXY_URL === undefined) delete process.env.WEATHER_PROXY_URL;
        if (saved.WEATHER_PROXY_KEY === undefined) delete process.env.WEATHER_PROXY_KEY;
    } finally {
        console.warn = quiet;
    }
});

test('getRelayConfig: http is accepted only for allow-listed origins', () => {
    const env = { WEATHER_PROXY_URL: 'http://127.0.0.1:4999/w', WEATHER_PROXY_KEY: KEY };
    const quiet = console.warn;
    console.warn = () => undefined;

    try {
        assert.equal(getRelayConfig(env).enabled, false);

        upstreamAllowForTests.push('http://127.0.0.1:4999');
        assert.equal(getRelayConfig(env).baseUrl, 'http://127.0.0.1:4999/w');
        assert.equal(getRelayConfig({ ...env, WEATHER_PROXY_URL: 'http://127.0.0.1:5000/w' }).enabled, false);
        assert.equal(getRelayConfig({ ...env, WEATHER_PROXY_URL: 'http://127.0.0.1:4999/w?x=1' }).enabled, false);
    } finally {
        upstreamAllowForTests.length = 0;
        console.warn = quiet;
    }
});

test('getRelayConfig: warns once per invalid field and never prints the value', () => {
    const quiet = console.warn;
    const warnings: string[] = [];
    console.warn = (msg: string) => {
        warnings.push(String(msg));
    };

    try {
        __resetWarned();
        const env = { WEATHER_PROXY_URL: 'http://SECRETHOST', WEATHER_PROXY_KEY: 'SECRETKEY', WEATHER_RATE_LIMIT: 'SECRETRATE' };

        getRelayConfig(env);
        getRelayConfig(env);
        getRelayConfig(env);

        assert.equal(warnings.length, 3);
        assert.ok(warnings.some(w => w.includes('WEATHER_PROXY_URL')));
        assert.ok(warnings.some(w => w.includes('WEATHER_PROXY_KEY')));
        assert.ok(warnings.some(w => w.includes('WEATHER_RATE_LIMIT')));
        assert.ok(warnings.every(w => !w.includes('SECRET')));
    } finally {
        console.warn = quiet;
        __resetWarned();
    }
});
