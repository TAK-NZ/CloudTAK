import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { getRelayConfig, upstreamAllowForTests, __resetWarned } from '../stateless/lib/weather/relay-config.js';
import {
    SNAPSHOT_WINDOW_S,
    buildUpstreamUrl,
    effectiveSnapshot,
    latestSnapshot,
    parseTileRequest,
    tileCacheKey,
} from '../stateless/lib/weather/relay-request.js';
import { FixedWindowLimiter } from '../stateless/lib/weather/relay-limiter.js';
import {
    DEFAULT_MAX_AGE_S,
    DEFAULT_TTL_MS,
    IMMUTABLE_MAX_AGE_S,
    IMMUTABLE_TTL_MS,
    TileCache,
    SingleFlight,
    tileLifetime,
} from '../stateless/lib/weather/relay-cache.js';
import {
    LATEST_TTL_MS,
    buildSnapshotUrl,
    computedLatest,
    parseSnapshotResponse,
    resolveLatest,
    statusLatest,
} from '../stateless/lib/weather/relay-snapshot.js';
import { riff, webp } from './weather-images.js';
import {
    PAUSE_DEFAULT_S,
    PAUSE_MAX_S,
    PAUSE_MIN_S,
    __resetForTests,
    fetchJsonUpstream,
    pauseUpstream,
    redactUrl,
    relay,
    sniffImageType,
    upstreamAllowForTests as allowForTests,
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

    // Newer than the newest is served as the newest, older than the window is refused
    assert.equal(parse({}, `layer=precip&snapshot=${LATEST + 600}`).snapshot, LATEST);
    assert.equal(parse({}, `layer=precip&snapshot=${LATEST + 6000}`).snapshot, LATEST);
    rejects({}, `layer=precip&snapshot=${LATEST - 7800}`);
    rejects({}, `layer=precip&snapshot=${LATEST - 7200 - 600}`);
    rejects({}, `layer=precip&snapshot=${LATEST - 1}`);
    rejects({}, 'layer=precip&snapshot=179999940');
    rejects({}, 'layer=precip&snapshot=abc');
    rejects({}, 'layer=precip&snapshot=');
    rejects({}, `layer=precip&snapshot=${LATEST}0`);
});

test('effectiveSnapshot: clamps newer, refuses older than the window, never echoes', () => {
    assert.equal(SNAPSHOT_WINDOW_S, 7200);
    assert.equal(effectiveSnapshot(null, LATEST), LATEST);
    assert.equal(effectiveSnapshot(LATEST, LATEST), LATEST);
    assert.equal(effectiveSnapshot(LATEST - 600, LATEST), LATEST - 600);
    assert.equal(effectiveSnapshot(LATEST - 7200, LATEST), LATEST - 7200);
    assert.equal(effectiveSnapshot(LATEST + 600, LATEST), LATEST);
    assert.equal(effectiveSnapshot(LATEST + 600000, LATEST), LATEST);

    for (const requested of [LATEST - 7201, LATEST - 7800, 600]) {
        assert.throws(
            () => effectiveSnapshot(requested, LATEST),
            (err: { status?: number; message?: string }) => err.status === 400
                && err.message === 'snapshot out of range'
                && !String(err.message).includes(String(requested)),
            String(requested),
        );
    }
});

test('parseTileRequest: the window follows the latest of the layer', () => {
    const lagging = LATEST - 600;
    const latestFor = (layer: string) => layer === 'clouds' ? lagging : LATEST;
    const clouds = (query: string) => parseTileRequest({ z: 4, x: 3, y: 5 }, new URLSearchParams(query), NOW_S, latestFor);

    assert.equal(clouds('layer=clouds').snapshot, lagging);
    assert.equal(clouds('layer=clouds&snapshot=latest').snapshot, lagging);
    assert.equal(clouds(`layer=clouds&snapshot=${LATEST}`).snapshot, lagging);
    assert.equal(clouds(`layer=clouds&snapshot=${lagging}`).snapshot, lagging);
    assert.equal(clouds(`layer=clouds&snapshot=${lagging - 7200}`).snapshot, lagging - 7200);
    assert.throws(() => clouds(`layer=clouds&snapshot=${lagging - 7800}`), (err: { status?: number }) => err.status === 400);

    // Other layers keep their own window
    assert.equal(clouds('layer=precip').snapshot, LATEST);
    assert.equal(clouds(`layer=precip&snapshot=${LATEST - 7200}`).snapshot, LATEST - 7200);
    assert.throws(() => clouds(`layer=precip&snapshot=${LATEST - 7800}`), (err: { status?: number }) => err.status === 400);

    // Format errors still win over the window
    assert.throws(() => clouds('layer=clouds&snapshot=abc'), (err: { message?: string }) => err.message === 'Invalid snapshot');

    // Both requested snapshots share one cache key and one upstream URL
    const a = clouds(`layer=clouds&snapshot=${LATEST}`);
    const b = clouds(`layer=clouds&snapshot=${lagging}`);
    assert.equal(tileCacheKey(a), tileCacheKey(b));
    assert.equal(buildUpstreamUrl('https://u.example.com/w', a, KEY).toString(), buildUpstreamUrl('https://u.example.com/w', b, KEY).toString());
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

    // The key does not contain the image type; pinned so a change is noticed
    assert.equal(tileCacheKey(parse({}, 'layer=clouds')), `clouds|4/3/5|f0|s${LATEST}|z256|c-|v0|p0`);
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

    assert.equal(cache.set('a', Buffer.from('one'), 'image/png'), true);
    assert.equal(cache.get('a')?.body.toString(), 'one');

    now = 999;
    assert.equal(cache.get('a')?.body.toString(), 'one');

    now = 1000;
    assert.equal(cache.get('a'), undefined);
    assert.equal(cache.bytes, 0);
    assert.equal(cache.size, 0);
});

test('TileCache: LRU order and byte bound', () => {
    const cache = new TileCache({ maxBytes: 10, maxEntryBytes: 10 });
    cache.set('a', Buffer.alloc(4), 'image/png');
    cache.set('b', Buffer.alloc(4), 'image/png');

    // Touch a, so b is the least recently used
    assert.ok(cache.get('a'));
    cache.set('c', Buffer.alloc(4), 'image/png');

    assert.ok(cache.get('a'));
    assert.equal(cache.get('b'), undefined);
    assert.ok(cache.get('c'));
    assert.equal(cache.bytes, 8);

    // Replacing an entry does not double count it
    cache.set('a', Buffer.alloc(2), 'image/png');
    assert.equal(cache.bytes, 6);
});

test('TileCache: per entry cap', () => {
    const cache = new TileCache({ maxBytes: 100, maxEntryBytes: 5 });
    assert.equal(cache.set('big', Buffer.alloc(6), 'image/png'), false);
    assert.equal(cache.get('big'), undefined);
    assert.equal(cache.set('ok', Buffer.alloc(5), 'image/png'), true);

    const defaults = new TileCache();
    assert.equal(defaults.maxBytes, 64 * 1024 * 1024);
    assert.equal(defaults.ttlMs, 600000);
    assert.equal(defaults.maxEntryBytes, 1024 * 1024);
});

test('TileCache: a per entry TTL outlives the default and reports immutable', () => {
    let now = 0;
    const cache = new TileCache({ ttlMs: 1000, now: () => now });
    cache.set('short', Buffer.from('s'), 'image/png');
    cache.set('long', Buffer.from('l'), 'image/png', { ttlMs: 5000, immutable: true });
    cache.set('plain', Buffer.from('p'), 'image/png', { ttlMs: 5000 });

    assert.equal(cache.get('short')?.immutable, false);
    assert.equal(cache.get('long')?.immutable, true);
    assert.equal(cache.get('plain')?.immutable, false);

    now = 1000;
    assert.equal(cache.get('short'), undefined);
    assert.equal(cache.get('long')?.body.toString(), 'l');

    now = 4999;
    assert.ok(cache.get('long'));
    now = 5000;
    assert.equal(cache.get('long'), undefined);
    assert.equal(cache.bytes, 1, 'only the plain entry is left');

    // Replacing an entry resets its flag and lifetime
    cache.set('plain', Buffer.from('p'), 'image/png');
    assert.equal(cache.get('plain')?.immutable, false);
    now = 6000;
    assert.equal(cache.get('plain'), undefined);
});

test('TileCache: LRU still evicts under the byte cap with 7200 s entries', () => {
    const cache = new TileCache({ maxBytes: 300, maxEntryBytes: 300 });
    for (let i = 0; i < 5; i++) {
        assert.equal(cache.set(`k${i}`, Buffer.alloc(100), 'image/png', { ttlMs: IMMUTABLE_TTL_MS, immutable: true }), true);
        assert.ok(cache.bytes <= cache.maxBytes);
    }

    assert.equal(cache.size, 3);
    assert.equal(cache.get('k0'), undefined);
    assert.equal(cache.get('k1'), undefined);
    for (const key of ['k2', 'k3', 'k4']) assert.equal(cache.get(key)?.immutable, true, key);
    assert.equal(cache.bytes, 300);
});

test('tileLifetime: immutable only when the proxy confirms the effective snapshot', () => {
    assert.equal(IMMUTABLE_TTL_MS, 7200 * 1000);
    assert.equal(IMMUTABLE_MAX_AGE_S, 3600);
    assert.equal(DEFAULT_TTL_MS, 600 * 1000);
    assert.equal(DEFAULT_MAX_AGE_S, 600);

    const base: { effective: number; upstream: number | null; fallback: boolean; error: boolean; cacheable: boolean } = {
        effective: LATEST, upstream: LATEST, fallback: false, error: false, cacheable: true,
    };
    const immutable = { immutable: true, ttlMs: 7_200_000, maxAge: 3600 };
    const normal = { immutable: false, ttlMs: 600_000, maxAge: 600 };

    const rows: Array<[string, Partial<typeof base>, typeof immutable]> = [
        ['header equals the effective snapshot', {}, immutable],
        ['header absent (older proxy)', { upstream: null }, normal],
        ['header older (proxy stepped back)', { upstream: LATEST - 600 }, normal],
        ['header newer', { upstream: LATEST + 600 }, normal],
        ['fallback', { fallback: true }, normal],
        ['error tile', { error: true }, normal],
        ['not cacheable', { cacheable: false }, normal],
    ];

    for (const [name, change, expected] of rows) {
        assert.deepEqual(tileLifetime({ ...base, ...change }), expected, name);
    }
});

test('TileCache: remembers the content type', () => {
    let now = 0;
    const cache = new TileCache({ ttlMs: 1000, now: () => now });
    cache.set('png', Buffer.from('p'), 'image/png');
    cache.set('webp', Buffer.from('w'), 'image/webp');
    assert.equal(cache.get('png')?.contentType, 'image/png');
    assert.equal(cache.get('webp')?.contentType, 'image/webp');

    // Replacing an entry replaces its type
    cache.set('png', Buffer.from('q'), 'image/webp');
    assert.equal(cache.get('png')?.contentType, 'image/webp');
    assert.equal(cache.get('png')?.body.toString(), 'q');

    now = 1000;
    assert.equal(cache.get('png'), undefined);
    assert.equal(cache.get('webp'), undefined);
});

test('buildSnapshotUrl: exact URL, key encoded, no provider', () => {
    const base = 'https://utils.example.com/weather';
    const url = buildSnapshotUrl(base, 'clouds', KEY);
    assert.equal(url.toString(), `${base}/snapshot?layer=clouds&api=${KEY}`);
    assert.ok(!url.toString().includes('provider'));

    const odd = buildSnapshotUrl(base, 'precip-global', 'a b&c=d~._-1234567');
    assert.equal(odd.toString(), `${base}/snapshot?layer=precip-global&api=a%20b%26c%3Dd~._-1234567`);
    assert.equal(odd.searchParams.get('api'), 'a b&c=d~._-1234567');
});

test('computedLatest and parseSnapshotResponse: accepts a valid answer', () => {
    assert.deepEqual(computedLatest(NOW_S), { snapshot: LATEST, source: 'computed' });

    assert.deepEqual(parseSnapshotResponse({ snapshot: LATEST, source: 'rainbow' }, NOW_S), { snapshot: LATEST, source: 'rainbow' });
    assert.deepEqual(parseSnapshotResponse({ snapshot: LATEST, source: 'computed' }, NOW_S), { snapshot: LATEST, source: 'computed' });

    // source defaults to rainbow; the current step and the oldest step of the window are fine
    assert.deepEqual(parseSnapshotResponse({ snapshot: LATEST + 600 }, NOW_S), { snapshot: LATEST + 600, source: 'rainbow' });
    assert.equal(parseSnapshotResponse({ snapshot: LATEST - 7200 }, NOW_S)?.snapshot, LATEST - 7200);

    // Unknown fields are ignored and never copied
    const extra = parseSnapshotResponse({ snapshot: LATEST, source: 'rainbow', layer: 'clouds', secret: 'SECRETVALUE' }, NOW_S);
    assert.deepEqual(extra, { snapshot: LATEST, source: 'rainbow' });
});

test('parseSnapshotResponse: rejects everything else', () => {
    const bad: unknown[] = [
        null, undefined, 'x', 7, [], [{ snapshot: LATEST }], {},
        { snapshot: String(LATEST) },
        { snapshot: LATEST + 0.5 },
        { snapshot: LATEST + 1 },
        { snapshot: LATEST - 7800 },
        { snapshot: LATEST - 7200 - 600 },
        { snapshot: LATEST + 1200 },
        { snapshot: null },
        { snapshot: NaN },
        { snapshot: LATEST, source: 'rainviewer' },
        { snapshot: LATEST, source: null },
        { snapshot: LATEST, source: 1 },
    ];

    for (const json of bad) assert.equal(parseSnapshotResponse(json, NOW_S), null, JSON.stringify(json));
});

test('fetchJsonUpstream, resolveLatest and statusLatest against a local proxy', async () => {
    const hits: string[] = [];
    let mode: 'ok' | '404' | '429' | 'big' | 'text' | '302' | 'slow' = 'ok';

    const server = http.createServer((req, res) => {
        hits.push(String(req.url));
        const respond = () => {
            switch (mode) {
                case 'ok':
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ snapshot: LATEST - 600, source: 'rainbow' }));
                    return;
                case 'big':
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ snapshot: LATEST, pad: 'x'.repeat(5000) }));
                    return;
                case 'text':
                    res.writeHead(200, { 'content-type': 'text/plain' });
                    res.end('not json');
                    return;
                case '302':
                    res.writeHead(302, { location: '/elsewhere' });
                    res.end();
                    return;
                case '429':
                    res.writeHead(429, { 'retry-after': '9' });
                    res.end('{}');
                    return;
                default:
                    res.writeHead(Number(mode) || 200, { 'content-type': 'application/json' });
                    res.end('{}');
            }
        };

        if (mode === 'slow') {
            setTimeout(respond, 400);
            mode = 'ok';
        } else {
            respond();
        }
    });

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no address');
    const origin = `http://127.0.0.1:${address.port}`;
    allowForTests.push(origin);

    const quiet = console.warn;
    console.warn = () => undefined;

    try {
        let now = NOW_S * 1000;
        __resetForTests({ now: () => now, latestBudgetMs: 150 });
        const cfg = { baseUrl: `${origin}/w`, key: KEY };
        const url = buildSnapshotUrl(cfg.baseUrl, 'clouds', KEY);

        assert.deepEqual(await fetchJsonUpstream(url), { status: 200, json: { snapshot: LATEST - 600, source: 'rainbow' }, retryAfterS: null });
        assert.equal(hits[0], `/w/snapshot?layer=clouds&api=${KEY}`);

        mode = '404';
        assert.deepEqual(await fetchJsonUpstream(url), { status: 404, json: null, retryAfterS: null });
        mode = '429';
        assert.deepEqual(await fetchJsonUpstream(url), { status: 429, json: null, retryAfterS: 9 });
        mode = 'big';
        assert.deepEqual(await fetchJsonUpstream(url), { status: 200, json: null, retryAfterS: null }, 'more than 4096 bytes');
        mode = 'text';
        assert.deepEqual(await fetchJsonUpstream(url), { status: 200, json: null, retryAfterS: null });
        mode = '302';
        await assert.rejects(fetchJsonUpstream(url), (err: { status?: number; message?: string }) => err.status === 502 && err.message === 'Weather upstream unavailable');

        // resolveLatest: a good answer is cached for 30 s and shared by concurrent callers
        mode = 'ok';
        __resetForTests({ now: () => now, latestBudgetMs: 150 });
        hits.length = 0;
        const results = await Promise.all(Array.from({ length: 5 }, () => resolveLatest('clouds', cfg, 'agent')));
        assert.equal(hits.length, 1, 'single flight');
        for (const r of results) assert.deepEqual(r, { snapshot: LATEST - 600, source: 'rainbow' });

        await resolveLatest('clouds', cfg, 'agent');
        assert.equal(hits.length, 1, 'cached');
        now += LATEST_TTL_MS - 1;
        await resolveLatest('clouds', cfg, 'agent');
        assert.equal(hits.length, 1, 'still cached after 29.999 s');
        now += 1;
        await resolveLatest('clouds', cfg, 'agent');
        assert.equal(hits.length, 2, 'refetched after 30 s');

        // A failure gives the computed snapshot and is cached as well
        __resetForTests({ now: () => now, latestBudgetMs: 150 });
        hits.length = 0;
        mode = '404';
        const computed = { snapshot: latestSnapshot(Math.floor(now / 1000)), source: 'computed' };
        assert.deepEqual(await resolveLatest('radars', cfg, 'agent'), computed);
        mode = 'ok';
        assert.deepEqual(await resolveLatest('radars', cfg, 'agent'), computed);
        assert.equal(hits.length, 1);

        // A 429 pauses the upstream; while paused the proxy is not asked and nothing is cached
        __resetForTests({ now: () => now, latestBudgetMs: 150 });
        hits.length = 0;
        mode = '429';
        assert.equal((await resolveLatest('precip', cfg, 'agent')).source, 'computed');
        assert.equal(upstreamPausedFor(), 9);
        mode = 'ok';
        assert.equal((await resolveLatest('precip-global', cfg, 'agent')).source, 'computed');
        assert.equal(hits.length, 1, 'no call while paused');

        // The budget: a slow proxy does not hold the caller longer than latestBudgetMs
        __resetForTests({ now: () => now, latestBudgetMs: 100 });
        hits.length = 0;
        mode = 'slow';
        const started = Date.now();
        assert.equal((await resolveLatest('clouds', cfg, 'agent')).source, 'computed');
        assert.ok(Date.now() - started < 350, 'returned before the slow answer');

        // The lookup keeps running and fills the cache for the next caller
        await new Promise(resolve => setTimeout(resolve, 450));
        assert.deepEqual(await resolveLatest('clouds', cfg, 'agent'), { snapshot: LATEST - 600, source: 'rainbow' });
        assert.equal(hits.length, 1);

        // statusLatest asks every layer once and never throws
        __resetForTests({ now: () => now, latestBudgetMs: 150 });
        hits.length = 0;
        mode = 'ok';
        const all = await statusLatest(cfg, 'agent');
        assert.deepEqual(Object.keys(all), ['precip', 'precip-global', 'clouds', 'radars']);
        assert.equal(hits.length, 4);

        __resetForTests({ now: () => now, latestBudgetMs: 150 });
        const dead = await statusLatest({ baseUrl: 'https://127.0.0.1:1/w', key: KEY }, 'agent');
        assert.equal(dead.clouds.source, 'computed');
    } finally {
        console.warn = quiet;
        allowForTests.length = 0;
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        __resetForTests();
    }
});

test('sniffImageType: PNG and WebP by magic bytes', () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    assert.equal(sniffImageType(png), 'image/png');

    for (const chunk of ['VP8L', 'VP8 ', 'VP8X'] as const) {
        assert.equal(sniffImageType(webp(chunk)), 'image/webp', chunk);
    }

    // A slice of a bigger Buffer has a non-zero byteOffset
    const big = Buffer.concat([Buffer.from('xxxxxxxx'), webp(), Buffer.from('yyyy')]);
    assert.equal(sniffImageType(big.subarray(8, 8 + webp().byteLength)), 'image/webp');
    const bigPng = Buffer.concat([Buffer.from('xxxxxxxx'), png]);
    assert.equal(sniffImageType(bigPng.subarray(8)), 'image/png');
});

test('sniffImageType: everything else is not an image', () => {
    const none: Array<[string, Buffer]> = [
        ['empty', Buffer.alloc(0)],
        ['4 bytes', Buffer.from([1, 2, 3, 4])],
        ['7 byte png prefix', Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A])],
        ['riff wave', riff('WAVE')],
        ['webp without a chunk', webp().subarray(0, 12)],
        ['webp with an unknown chunk', riff('WEBP', Buffer.from('JUNK\x04\x00\x00\x00abcd', 'latin1'))],
        ['truncated riff', Buffer.from('RIFF')],
        ['json', Buffer.from('{"layer":"clouds","status":"ok"}')],
        ['html', Buffer.from('<html><body>Bad gateway</body></html>')],
        ['jpeg', Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10, 0x4A, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0])],
    ];

    for (const [name, body] of none) assert.equal(sniffImageType(body), null, name);
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
