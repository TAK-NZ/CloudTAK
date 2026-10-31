import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { Value } from '@sinclair/typebox/value';
import { getSarConfig, upstreamAllowForTests, __resetWarned } from '../stateless/lib/sar/relay-config.js';
import { TarrBody, TravelTimeBody, buildTarrUpstreamBody, buildUpstreamBody } from '../stateless/lib/sar/relay-request.js';
import type { TarrRequest, TravelTimeRequest } from '../stateless/lib/sar/relay-request.js';
import {
    ANALYSIS_FAILED,
    REJECTED,
    RESULT_KEYS,
    RESULT_KEYS_TARR,
    TIMED_OUT,
    TOO_LARGE,
    UNAVAILABLE,
    __resetForTests,
    callEngine,
    logThrottled,
    mapUpstream,
    redact,
    relay,
    sanitizeMessage,
    sanitizeSuggestedRadius,
    sanitizeSuggestedHours,
    sanitizeCode,
} from '../stateless/lib/sar/relay-upstream.js';
import type { EngineResult } from '../stateless/lib/sar/relay-upstream.js';

const KEY = 'abcdefghijklmnop1234';
const URL_OK = 'https://utils.example.com/sar';

function env(extra: Record<string, string>): NodeJS.ProcessEnv {
    return { SAR_SERVICE_URL: URL_OK, SAR_SERVICE_KEY: KEY, ...extra } as NodeJS.ProcessEnv;
}

function captureWarnings<T>(fn: () => T): { result: T; warnings: string[] } {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
        warnings.push(args.map(String).join(' '));
    };
    try {
        return { result: fn(), warnings };
    } finally {
        console.warn = original;
    }
}

test('config: unset values disable the relay and warn nothing', () => {
    __resetWarned();
    const { result, warnings } = captureWarnings(() => getSarConfig({} as NodeJS.ProcessEnv));
    assert.deepEqual(result, { enabled: false, baseUrl: null, key: null, rate: 6 });
    assert.equal(warnings.length, 0);
});

test('config: valid URL and key enable the relay; a trailing slash and a path are kept as given', () => {
    __resetWarned();
    assert.deepEqual(getSarConfig(env({})), { enabled: true, baseUrl: URL_OK, key: KEY, rate: 6 });
    assert.equal(getSarConfig(env({ SAR_SERVICE_URL: `${URL_OK}///` })).baseUrl, URL_OK);
    assert.equal(getSarConfig(env({ SAR_SERVICE_URL: ` ${URL_OK} ` })).baseUrl, URL_OK);
    assert.equal(getSarConfig(env({ SAR_SERVICE_URL: 'https://utils.example.com' })).baseUrl, 'https://utils.example.com');
});

test('config: invalid URLs disable the relay and the value is never printed', () => {
    const bad = [
        'not a url',
        'http://utils.example.com/sar',
        'ftp://utils.example.com',
        'https://user:pass@utils.example.com/sar',
        'https://utils.example.com/sar?x=1',
        'https://utils.example.com/sar#frag',
        `https://utils.example.com/${'a'.repeat(250)}`,
    ];

    for (const url of bad) {
        __resetWarned();
        const { result, warnings } = captureWarnings(() => getSarConfig(env({ SAR_SERVICE_URL: url })));
        assert.equal(result.enabled, false, url);
        assert.equal(result.baseUrl, null, url);
        assert.equal(warnings.length, 1, url);
        assert.ok(warnings[0].includes('SAR_SERVICE_URL'));
        assert.ok(!warnings[0].includes('utils.example.com'), 'value not printed');
        assert.ok(!warnings[0].includes('pass'), 'value not printed');
    }
});

test('config: http is accepted only for an origin on the test allow list', () => {
    __resetWarned();
    const origin = 'http://127.0.0.1:59999';
    assert.equal(captureWarnings(() => getSarConfig(env({ SAR_SERVICE_URL: `${origin}/sar` }))).result.baseUrl, null);

    upstreamAllowForTests.push(origin);
    try {
        assert.equal(getSarConfig(env({ SAR_SERVICE_URL: `${origin}/sar` })).baseUrl, `${origin}/sar`);
    } finally {
        upstreamAllowForTests.splice(upstreamAllowForTests.indexOf(origin), 1);
    }
});

test('config: key pattern', () => {
    const good = ['a'.repeat(16), 'a'.repeat(128), 'Ab0._~-Ab0._~-Ab0'];
    for (const key of good) {
        __resetWarned();
        assert.equal(getSarConfig(env({ SAR_SERVICE_KEY: key })).enabled, true, key);
    }

    const bad = ['a'.repeat(15), 'a'.repeat(129), 'has space 0123456789', 'semi;colon0123456789', 'quote"0123456789ab'];
    for (const key of bad) {
        __resetWarned();
        const { result, warnings } = captureWarnings(() => getSarConfig(env({ SAR_SERVICE_KEY: key })));
        assert.equal(result.enabled, false, key);
        assert.equal(result.key, null, key);
        assert.equal(warnings.length, 1);
        assert.ok(warnings[0].includes('SAR_SERVICE_KEY'));
        assert.ok(!warnings[0].includes(key), 'key not printed');
    }
});

test('config: rate bounds 1..60, default 6, invalid falls back with one warning', () => {
    __resetWarned();
    assert.equal(getSarConfig(env({})).rate, 6);
    assert.equal(getSarConfig(env({ SAR_RATE_LIMIT: '' })).rate, 6);
    assert.equal(getSarConfig(env({ SAR_RATE_LIMIT: '1' })).rate, 1);
    assert.equal(getSarConfig(env({ SAR_RATE_LIMIT: '60' })).rate, 60);
    assert.equal(getSarConfig(env({ SAR_RATE_LIMIT: ' 12 ' })).rate, 12);

    for (const value of ['0', '61', '-1', '2.5', 'abc', '1e1', '1000']) {
        __resetWarned();
        const { result, warnings } = captureWarnings(() => {
            const first = getSarConfig(env({ SAR_RATE_LIMIT: value }));
            getSarConfig(env({ SAR_RATE_LIMIT: value }));
            return first;
        });
        assert.equal(result.rate, 6, value);
        assert.equal(result.enabled, true, 'an invalid rate does not disable the relay');
        assert.equal(warnings.length, 1, `warned once for ${value}`);
        assert.ok(warnings[0].includes('SAR_RATE_LIMIT'));
        assert.ok(!warnings[0].includes(`"${value}"`));
    }
});

test('config: values are read on every call', () => {
    __resetWarned();
    const saved = { url: process.env.SAR_SERVICE_URL, key: process.env.SAR_SERVICE_KEY };
    try {
        process.env.SAR_SERVICE_URL = URL_OK;
        process.env.SAR_SERVICE_KEY = KEY;
        assert.equal(getSarConfig().enabled, true);
        delete process.env.SAR_SERVICE_KEY;
        assert.equal(getSarConfig().enabled, false);
    } finally {
        if (saved.url === undefined) {
            delete process.env.SAR_SERVICE_URL;
        } else {
            process.env.SAR_SERVICE_URL = saved.url;
        }
        if (saved.key === undefined) {
            delete process.env.SAR_SERVICE_KEY;
        } else {
            process.env.SAR_SERVICE_KEY = saved.key;
        }
    }
});

// Round synthetic values only
function body(over: Record<string, unknown> = {}): unknown {
    return { ipp: { lat: -40, lng: 175 }, speed_kmh: 2.5, intervals_hours: [1, 2, 4], radius_km: 10, ...over };
}

function ipp(lat: number, lng: number): unknown {
    return body({ ipp: { lat, lng } });
}

function valid(value: unknown): boolean {
    return Value.Check(TravelTimeBody, value);
}

test('validation: a complete body and a body without radius pass', () => {
    assert.equal(valid(body()), true);
    const noRadius = body() as Record<string, unknown>;
    delete noRadius.radius_km;
    assert.equal(valid(noRadius), true);
});

test('validation: latitude -48..-33.5', () => {
    assert.equal(valid(ipp(-48, 175)), true);
    assert.equal(valid(ipp(-33.5, 175)), true);
    assert.equal(valid(ipp(-48.01, 175)), false);
    assert.equal(valid(ipp(-33.49, 175)), false);
    assert.equal(valid(ipp(0, 175)), false);
});

test('validation: longitude 165.5..179.5', () => {
    assert.equal(valid(ipp(-40, 165.5)), true);
    assert.equal(valid(ipp(-40, 179.5)), true);
    assert.equal(valid(ipp(-40, 165.49)), false);
    assert.equal(valid(ipp(-40, 179.51)), false);
    assert.equal(valid(ipp(-40, -175)), false);
});

test('validation: speed 0.1..10', () => {
    assert.equal(valid(body({ speed_kmh: 0.1 })), true);
    assert.equal(valid(body({ speed_kmh: 10 })), true);
    assert.equal(valid(body({ speed_kmh: 0.09 })), false);
    assert.equal(valid(body({ speed_kmh: 10.01 })), false);
    assert.equal(valid(body({ speed_kmh: 0 })), false);
});

test('validation: each band 0.25..24 and 1 to 8 bands', () => {
    assert.equal(valid(body({ intervals_hours: [0.25] })), true);
    assert.equal(valid(body({ intervals_hours: [24] })), true);
    assert.equal(valid(body({ intervals_hours: [0.24] })), false);
    assert.equal(valid(body({ intervals_hours: [24.01] })), false);
    assert.equal(valid(body({ intervals_hours: [1, 2, 0.2] })), false);
    assert.equal(valid(body({ intervals_hours: [] })), false);
    assert.equal(valid(body({ intervals_hours: [1, 2, 3, 4, 5, 6, 7, 8] })), true);
    assert.equal(valid(body({ intervals_hours: [1, 2, 3, 4, 5, 6, 7, 8, 9] })), false);
});

test('validation: radius 1..30 and optional', () => {
    assert.equal(valid(body({ radius_km: 1 })), true);
    assert.equal(valid(body({ radius_km: 30 })), true);
    assert.equal(valid(body({ radius_km: 0.99 })), false);
    assert.equal(valid(body({ radius_km: 30.01 })), false);
    assert.equal(valid(body({ radius_km: 0 })), false);
});

test('validation: extra fields, missing fields and non-numbers are rejected', () => {
    assert.equal(valid(body({ extra: 1 })), false);
    assert.equal(valid(body({ ipp: { lat: -40, lng: 175, alt: 1 } })), false);
    assert.equal(valid({ speed_kmh: 2.5, intervals_hours: [1] }), false);
    assert.equal(valid({ ipp: { lat: -40, lng: 175 }, intervals_hours: [1] }), false);
    assert.equal(valid({ ipp: { lat: -40, lng: 175 }, speed_kmh: 2.5 }), false);
    assert.equal(valid(body({ speed_kmh: '2.5' })), false);
    assert.equal(valid(body({ speed_kmh: null })), false);
    assert.equal(valid(body({ speed_kmh: true })), false);
    assert.equal(valid(body({ intervals_hours: ['1'] })), false);
    assert.equal(valid(body({ intervals_hours: 1 })), false);
    assert.equal(valid(body({ radius_km: '10' })), false);
    assert.equal(valid(ipp('-40' as unknown as number, 175)), false);
    assert.equal(valid(body({ ipp: null })), false);
    assert.equal(valid(null), false);
    assert.equal(valid([]), false);
});

test('buildUpstreamBody: sorted unique intervals, optional radius, nothing extra', () => {
    const parsed = body({ intervals_hours: [4, 1, 2, 2, 4] }) as TravelTimeRequest;
    assert.deepEqual(buildUpstreamBody(parsed), {
        ipp: { lat: -40, lng: 175 },
        speed_kmh: 2.5,
        intervals_hours: [1, 2, 4],
        radius_km: 10,
    });

    const noRadius = body() as Record<string, unknown>;
    delete noRadius.radius_km;
    const built = buildUpstreamBody(noRadius as unknown as TravelTimeRequest);
    assert.ok(!('radius_km' in built));

    assert.deepEqual(buildUpstreamBody(body({ intervals_hours: [0.5, 0.25] }) as TravelTimeRequest).intervals_hours, [0.25, 0.5]);
});

function ok(extra: Record<string, unknown> = {}): EngineResult {
    return {
        status: 200,
        failure: null,
        json: {
            status: 'ok',
            mode: 'travel-time',
            contours: { type: 'FeatureCollection', features: [] },
            parameters: { speed_kmh: 2.5, intervals_hours: [1], radius_km: 10, cell_size_m: 30 },
            bbox: { west: 175, south: -40, east: 175.1, north: -39.9 },
            warnings: [],
            data: { land_cover: 'lcdb', elevation: 'dem', osm_built_at: null },
            attribution: ['a'],
            disclaimer: 'Planning aid only.',
            timings_s: { total: 1 },
            ...extra,
        },
    };
}

function answer(status: number, json: unknown = null): EngineResult {
    return { status, json, failure: null };
}

function error(result: EngineResult) {
    const mapped = mapUpstream(result);
    assert.equal(mapped.ok, false);
    if (mapped.ok) throw new Error('unreachable');
    return mapped.error;
}

test('mapUpstream: 200 passes only the whitelisted keys', () => {
    const mapped = mapUpstream(ok({ secret: 'x', internal_path: '/var/task', apiKey: KEY }));
    assert.equal(mapped.ok, true);
    if (!mapped.ok) return;
    assert.deepEqual(Object.keys(mapped.body).sort(), [...RESULT_KEYS].sort());
    assert.ok(!JSON.stringify(mapped.body).includes('/var/task'));
});

test('mapUpstream: 200 keeps only the keys that are present', () => {
    const result = ok();
    delete (result.json as Record<string, unknown>).timings_s;
    const mapped = mapUpstream(result);
    assert.equal(mapped.ok, true);
    if (mapped.ok) assert.ok(!('timings_s' in mapped.body));
});

test('mapUpstream: 200 with a wrong shape is a 502', () => {
    const shapes: unknown[] = [
        null,
        'text',
        [],
        {},
        { status: 'error', mode: 'travel-time', contours: { type: 'FeatureCollection', features: [] } },
        { status: 'ok', mode: 'range-rings', contours: { type: 'FeatureCollection', features: [] } },
        { status: 'ok', mode: 'travel-time' },
        { status: 'ok', mode: 'travel-time', contours: { type: 'Feature', features: [] } },
        { status: 'ok', mode: 'travel-time', contours: { type: 'FeatureCollection', features: 'none' } },
    ];

    for (const json of shapes) {
        const e = error(answer(200, json));
        assert.equal(e.status, 502, JSON.stringify(json));
        assert.equal(e.message, UNAVAILABLE);
    }
});

test('mapUpstream: 422 passes a sanitised message and a valid suggestion', () => {
    const e = error(answer(422, { status: 'error', message: 'The start point is in the sea or open water. Move it onto land.' }));
    assert.equal(e.status, 422);
    assert.equal(e.message, 'The start point is in the sea or open water. Move it onto land.');
    assert.equal(e.extra, undefined);

    const withRadius = error(answer(422, { message: 'Too dense.', suggested_radius_km: 7.25 }));
    assert.equal(withRadius.status, 422);
    assert.deepEqual(withRadius.extra, { suggested_radius_km: 7.3 });
});

test('mapUpstream: 422 that is unusable is a 502', () => {
    for (const json of [null, {}, { message: 5 }, { message: '' }, { message: '\u0000\u0007' }, 'text', []]) {
        const e = error(answer(422, json));
        assert.equal(e.status, 502, JSON.stringify(json));
        assert.equal(e.message, UNAVAILABLE);
    }
});

test('sanitizeMessage: control characters removed and at most 300 characters', () => {
    assert.equal(sanitizeMessage('a\u0000b\u001Fc\u007Fd\u0085e\nf\tg'), 'abcdefg');
    assert.equal(sanitizeMessage('  padded  '), 'padded');
    assert.equal(sanitizeMessage('x'.repeat(301)).length, 300);
    assert.equal(sanitizeMessage('x'.repeat(300)).length, 300);
    assert.equal(sanitizeMessage('x'.repeat(299)).length, 299);
});

test('sanitizeSuggestedRadius: finite numbers from 1 to 30, one decimal', () => {
    assert.equal(sanitizeSuggestedRadius(1), 1);
    assert.equal(sanitizeSuggestedRadius(30), 30);
    assert.equal(sanitizeSuggestedRadius(12.34), 12.3);
    assert.equal(sanitizeSuggestedRadius(0.99), undefined);
    assert.equal(sanitizeSuggestedRadius(30.01), undefined);
    assert.equal(sanitizeSuggestedRadius(0), undefined);
    assert.equal(sanitizeSuggestedRadius(-5), undefined);
    assert.equal(sanitizeSuggestedRadius(Infinity), undefined);
    assert.equal(sanitizeSuggestedRadius(NaN), undefined);
    assert.equal(sanitizeSuggestedRadius('7'), undefined);
    assert.equal(sanitizeSuggestedRadius(null), undefined);
    assert.equal(sanitizeSuggestedRadius(undefined), undefined);
});

test('mapUpstream: 422 drops an out of range suggestion but keeps the message', () => {
    const e = error(answer(422, { message: 'Too dense.', suggested_radius_km: 500 }));
    assert.equal(e.status, 422);
    assert.equal(e.message, 'Too dense.');
    assert.equal(e.extra, undefined);
});

test('mapUpstream: area_too_dense forwards only whitelisted, type-checked fields', () => {
    const both = error(answer(422, { code: 'area_too_dense', message: 'Dense.', suggested_radius_km: 17, suggested_max_hours: 4.5, trace: 'x', ipp: {} }));
    assert.equal(both.status, 422);
    assert.deepEqual(both.extra, { code: 'area_too_dense', suggested_radius_km: 17, suggested_max_hours: 4.5 });
    assert.deepEqual(error(answer(422, { code: 'area_too_dense', message: 'Dense.', suggested_radius_km: 17 })).extra, { code: 'area_too_dense', suggested_radius_km: 17 });
    assert.deepEqual(error(answer(422, { code: 'area_too_dense', message: 'Dense.', suggested_max_hours: 4.5 })).extra, { code: 'area_too_dense', suggested_max_hours: 4.5 });
    assert.deepEqual(error(answer(422, { code: 'area_too_dense', message: 'Dense.' })).extra, { code: 'area_too_dense' });
    const junk = error(answer(422, { code: 5, message: 'Dense.', suggested_radius_km: '17', suggested_max_hours: Infinity }));
    assert.equal(junk.status, 422);
    assert.equal(junk.message, 'Dense.');
    assert.equal(junk.extra, undefined);
    assert.equal(error(answer(422, { code: 'Bad Code!', message: 'Dense.' })).extra, undefined);
});
test('sanitizeSuggestedHours and sanitizeCode', () => {
    assert.equal(sanitizeSuggestedHours(4.5), 4.5);
    assert.equal(sanitizeSuggestedHours(0.25), 0.25);
    assert.equal(sanitizeSuggestedHours(24), 24);
    for (const bad of [0.24, 24.1, 0, -1, NaN, Infinity, '4', null, undefined]) assert.equal(sanitizeSuggestedHours(bad), undefined);
    assert.equal(sanitizeCode('area_too_dense'), 'area_too_dense');
    for (const bad of [5, '', 'A', 'a b', 'x'.repeat(65), null]) assert.equal(sanitizeCode(bad), undefined);
});
test('mapUpstream: 400, 413 and 500', () => {
    const e400 = error(answer(400, null));
    assert.deepEqual([e400.status, e400.message], [400, REJECTED]);

    const e413 = error(answer(413, null));
    assert.deepEqual([e413.status, e413.message], [413, TOO_LARGE]);

    const e500 = error(answer(500, null));
    assert.deepEqual([e500.status, e500.message], [500, ANALYSIS_FAILED]);
});

test('mapUpstream: 401, 403 and other client errors are a 502, 401 and 403 log once', () => {
    __resetForTests();
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
        errors.push(args.map(String).join(' '));
    };

    try {
        for (const status of [401, 403, 404, 405, 409, 418, 429]) {
            const e = error(answer(status, null));
            assert.deepEqual([e.status, e.message], [502, UNAVAILABLE], String(status));
            assert.equal(e.retryAfterS, undefined);
        }
    } finally {
        console.error = original;
    }

    assert.equal(errors.length, 1, 'rejected key logged once a minute');
    assert.ok(errors[0].includes('rejected the configured API key'));
});

test('mapUpstream: 502, 503 and 504 are a 504 with a 30 s retry', () => {
    for (const status of [502, 503, 504]) {
        for (const json of [null, { status: 'error', message: 'UPSTREAM-BODY-SECRET' }]) {
            const e = error(answer(status, json));
            assert.deepEqual([e.status, e.message, e.retryAfterS], [504, TIMED_OUT, 30], String(status));
        }
    }
});

test('mapUpstream: timeout is a 504 with a 30 s retry', () => {
    const e = error({ status: null, json: null, failure: 'timeout' });
    assert.deepEqual([e.status, e.message, e.retryAfterS], [504, TIMED_OUT, 30]);
});

test('mapUpstream: network, blocked, redirect, oversize and other statuses are a 502', () => {
    for (const failure of ['network', 'blocked', 'redirect', 'too-large'] as const) {
        const e = error({ status: null, json: null, failure });
        assert.deepEqual([e.status, e.message], [502, UNAVAILABLE], failure);
    }

    for (const status of [201, 204, 301, 501, 505]) {
        const e = error(answer(status, null));
        assert.deepEqual([e.status, e.message], [502, UNAVAILABLE], String(status));
    }
});

test('mapUpstream: an upstream message never reaches the client except a 422', () => {
    for (const status of [400, 401, 403, 404, 413, 500, 502, 503, 504]) {
        const e = error(answer(status, { status: 'error', message: 'UPSTREAM-BODY-SECRET' }));
        assert.ok(!JSON.stringify(e).includes('UPSTREAM-BODY-SECRET'), String(status));
    }
});

test('redact: the key, x-api-key values and bearer tokens', () => {
    assert.equal(redact(`failed with ${KEY} twice ${KEY}`, KEY), 'failed with *** twice ***');
    assert.equal(redact('x-api-key: abc123def456'), 'x-api-key: ***');
    assert.equal(redact('{"x-api-key":"abc123def456"}'), '{"x-api-key":"***"}');
    assert.equal(redact('X-API-KEY=abc123def456;'), 'X-API-KEY=***;');
    assert.equal(redact('Authorization: Bearer eyJhbGciOi.payload_part.sig-part'), 'Authorization: Bearer ***');
    assert.equal(redact('nothing secret here', KEY), 'nothing secret here');
    assert.equal(redact('no key given', null), 'no key given');
});

test('logThrottled: once a minute per key, with secrets redacted', () => {
    let nowMs = 1800000000000;
    __resetForTests({ now: () => nowMs });

    const lines: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
        lines.push(args.map(String).join(' '));
    };

    try {
        logThrottled('warn', 'k', 'first Bearer abcdef.ghijkl');
        logThrottled('warn', 'k', 'second');
        logThrottled('warn', 'other', 'third');
        nowMs += 61000;
        logThrottled('warn', 'k', 'fourth');
    } finally {
        console.warn = original;
    }

    assert.deepEqual(lines, ['first Bearer ***', 'third', 'fourth']);
});

test('callEngine: a disabled configuration never calls out and is reported as a failure', async () => {
    __resetForTests();
    const original = console.warn;
    console.warn = () => undefined;

    try {
        const result = await callEngine({ enabled: false, baseUrl: null, key: null, rate: 6 }, buildUpstreamBody(body() as TravelTimeRequest));
        assert.equal(result.failure, 'network');
        assert.equal(result.status, null);
    } finally {
        console.warn = original;
    }
});

test('runtime: the limiters count per id within a window', () => {
    let nowMs = 1800000000000;
    __resetForTests({ now: () => nowMs });

    assert.equal(relay.calc.hit('a', 2).ok, true);
    assert.equal(relay.calc.hit('a', 2).ok, true);
    const denied = relay.calc.hit('a', 2);
    assert.equal(denied.ok, false);
    assert.ok(denied.retryAfterS >= 1 && denied.retryAfterS <= 60);
    assert.equal(relay.calc.hit('b', 2).ok, true);

    nowMs += 60000;
    assert.equal(relay.calc.hit('a', 2).ok, true);
    assert.equal(relay.upstreamTimeoutMs, 70000);
});

// TARR

function tarrBody(over: Record<string, unknown> = {}): Record<string, unknown> {
    return { ipp: { lat: -40, lng: 175 }, profile: 'Hiker', ecoregion: 'Temperate', terrain: 'Mountainous', ...over };
}

function tarrValid(value: unknown): boolean {
    return Value.Check(TarrBody, value);
}

function tarrOk(extra: Record<string, unknown> = {}): EngineResult {
    return {
        status: 200,
        failure: null,
        json: {
            status: 'ok',
            mode: 'tarr',
            contours: { type: 'FeatureCollection', features: [] },
            parameters: { profile: 'Hiker', koester_km: { p25: 1, p50: 2, p75: 3 }, radius_km: 5.7, cell_size_m: 12.5 },
            calibration: { region: 'Coconino County, Arizona', calibrated_for_nz: false },
            bbox: { west: 175, south: -40, east: 175.1, north: -39.9 },
            warnings: [],
            data: { land_cover: 'lcdb', elevation: 'dem', osm_built_at: null },
            attribution: ['a'],
            disclaimer: 'Planning aid only.',
            timings_s: { total: 1 },
            ...extra,
        },
    };
}

function tarrError(result: EngineResult) {
    const mapped = mapUpstream(result, 'tarr');
    assert.equal(mapped.ok, false);
    if (mapped.ok) throw new Error('unreachable');
    return mapped.error;
}

test('tarr validation: a body with and without ecoregion and terrain passes', () => {
    assert.equal(tarrValid(tarrBody()), true);
    const bare = tarrBody();
    delete bare.ecoregion;
    delete bare.terrain;
    assert.equal(tarrValid(bare), true);
    const onlyEco = tarrBody();
    delete onlyEco.terrain;
    assert.equal(tarrValid(onlyEco), true);
});

test('tarr validation: latitude and longitude bounds are those of travel-time', () => {
    assert.equal(tarrValid(tarrBody({ ipp: { lat: -48, lng: 165.5 } })), true);
    assert.equal(tarrValid(tarrBody({ ipp: { lat: -33.5, lng: 179.5 } })), true);
    assert.equal(tarrValid(tarrBody({ ipp: { lat: -48.01, lng: 175 } })), false);
    assert.equal(tarrValid(tarrBody({ ipp: { lat: -33.49, lng: 175 } })), false);
    assert.equal(tarrValid(tarrBody({ ipp: { lat: -40, lng: 165.49 } })), false);
    assert.equal(tarrValid(tarrBody({ ipp: { lat: -40, lng: 179.51 } })), false);
    assert.equal(tarrValid(tarrBody({ ipp: { lat: -40 } })), false);
    assert.equal(tarrValid(tarrBody({ ipp: { lat: -40, lng: 175, alt: 1 } })), false);
});

test('tarr validation: profile is required, 1 to 40 characters from a safe set', () => {
    const noProfile = tarrBody();
    delete noProfile.profile;
    assert.equal(tarrValid(noProfile), false);
    assert.equal(tarrValid(tarrBody({ profile: '' })), false);
    assert.equal(tarrValid(tarrBody({ profile: 'a' })), true);
    assert.equal(tarrValid(tarrBody({ profile: 'a'.repeat(40) })), true);
    assert.equal(tarrValid(tarrBody({ profile: 'a'.repeat(41) })), false);
    assert.equal(tarrValid(tarrBody({ profile: 'Skier (Alpine)' })), true);
    assert.equal(tarrValid(tarrBody({ profile: 'Child (10-12)' })), true);
    for (const profile of ['<b>', 'a;b', 'a\nb', 'a_b', 'a/b', 'é']) {
        assert.equal(tarrValid(tarrBody({ profile })), false, JSON.stringify(profile));
    }
    assert.equal(tarrValid(tarrBody({ profile: 5 })), false);
    assert.equal(tarrValid(tarrBody({ profile: null })), false);
});

test('tarr validation: ecoregion and terrain are optional letters, at most 20', () => {
    assert.equal(tarrValid(tarrBody({ ecoregion: 'a'.repeat(20) })), true);
    assert.equal(tarrValid(tarrBody({ ecoregion: 'a'.repeat(21) })), false);
    assert.equal(tarrValid(tarrBody({ terrain: 'a'.repeat(21) })), false);
    assert.equal(tarrValid(tarrBody({ ecoregion: '' })), false);
    assert.equal(tarrValid(tarrBody({ ecoregion: 'Dry1' })), false);
    assert.equal(tarrValid(tarrBody({ terrain: 'Flat;' })), false);
    // Not a string, including null
    assert.equal(tarrValid(tarrBody({ ecoregion: 5 })), false);
    assert.equal(tarrValid(tarrBody({ ecoregion: null })), false);
    assert.equal(tarrValid(tarrBody({ terrain: true })), false);
});

test('tarr validation: extra keys, other modes\' fields and non-objects are rejected', () => {
    assert.equal(tarrValid(tarrBody({ extra: 1 })), false);
    assert.equal(tarrValid(tarrBody({ radius_km: 10 })), false);
    assert.equal(tarrValid(tarrBody({ speed_kmh: 2.5 })), false);
    assert.equal(tarrValid(null), false);
    assert.equal(tarrValid([]), false);
});

test('buildTarrUpstreamBody: only the four fields, absent optionals dropped', () => {
    assert.deepEqual(buildTarrUpstreamBody(tarrBody() as unknown as TarrRequest), {
        ipp: { lat: -40, lng: 175 },
        profile: 'Hiker',
        ecoregion: 'Temperate',
        terrain: 'Mountainous',
    });
    const bare = tarrBody();
    delete bare.ecoregion;
    delete bare.terrain;
    const built = buildTarrUpstreamBody(bare as unknown as TarrRequest);
    assert.deepEqual(Object.keys(built).sort(), ['ipp', 'profile']);
    const leaked = { ...tarrBody(), extra: 'x', ipp: { lat: -40, lng: 175, alt: 1 } } as unknown as TarrRequest;
    assert.deepEqual(buildTarrUpstreamBody(leaked).ipp, { lat: -40, lng: 175 });
    assert.ok(!('extra' in buildTarrUpstreamBody(leaked)));
});

test('mapUpstream tarr: 200 passes exactly RESULT_KEYS_TARR and drops everything else', () => {
    const mapped = mapUpstream(tarrOk({ secret: 'x', internal_path: '/var/task', apiKey: KEY }), 'tarr');
    assert.equal(mapped.ok, true);
    if (!mapped.ok) return;
    assert.deepEqual(Object.keys(mapped.body).sort(), [...RESULT_KEYS_TARR].sort());
    assert.ok('calibration' in mapped.body);
    assert.ok(!JSON.stringify(mapped.body).includes('/var/task'));
    // Travel-time keeps its own list
    assert.ok(!(RESULT_KEYS as readonly string[]).includes('calibration'));
});

test('mapUpstream tarr: a travel-time answer is a 502 and the reverse too', () => {
    const wrongWay = tarrError(ok());
    assert.equal(wrongWay.status, 502);
    assert.equal(wrongWay.message, UNAVAILABLE);
    const reverse = mapUpstream(tarrOk());
    assert.equal(reverse.ok, false);
    if (!reverse.ok) assert.equal(reverse.error.status, 502);
    // The default mode is travel-time
    const explicit = mapUpstream(ok(), 'travel-time');
    assert.equal(explicit.ok, true);
});

test('mapUpstream tarr: 200 with a wrong shape is a 502', () => {
    const shapes: unknown[] = [
        null,
        {},
        { status: 'error', mode: 'tarr', contours: { type: 'FeatureCollection', features: [] } },
        { status: 'ok', mode: 'tarr' },
        { status: 'ok', mode: 'tarr', contours: { type: 'Feature', features: [] } },
        { status: 'ok', mode: 'tarr', contours: { type: 'FeatureCollection', features: 'none' } },
    ];
    for (const json of shapes) {
        const e = tarrError(answer(200, json));
        assert.equal(e.status, 502, JSON.stringify(json));
        assert.equal(e.message, UNAVAILABLE);
    }
});

test('mapUpstream tarr: errors are mapped as for travel-time', () => {
    const dense = tarrError(answer(422, { status: 'error', code: 'area_too_dense', message: 'Move the start point.', ipp: { lat: -40 } }));
    assert.equal(dense.status, 422);
    assert.equal(dense.message, 'Move the start point.');
    assert.deepEqual(dense.extra, { code: 'area_too_dense' });
    assert.equal(tarrError(answer(400)).message, REJECTED);
    assert.equal(tarrError(answer(413)).message, TOO_LARGE);
    assert.equal(tarrError(answer(500)).message, ANALYSIS_FAILED);
    assert.equal(tarrError(answer(404)).status, 502);
    const timeout = tarrError(answer(504));
    assert.equal(timeout.status, 504);
    assert.equal(timeout.message, TIMED_OUT);
});

test('callEngine: the route selects the engine path and defaults to /travel-time', async () => {
    const urls: string[] = [];
    const server = http.createServer((req, res) => {
        urls.push(String(req.url));
        req.resume();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"status":"ok"}');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Could not determine server address');
    const origin = `http://127.0.0.1:${address.port}`;
    upstreamAllowForTests.push(origin);
    try {
        __resetForTests();
        const cfg = { enabled: true, baseUrl: `${origin}/sar`, key: KEY, rate: 6 };
        const tarr = await callEngine(cfg, buildTarrUpstreamBody(tarrBody() as unknown as TarrRequest), 'test-agent', '/tarr');
        assert.equal(tarr.status, 200);
        const travel = await callEngine(cfg, buildUpstreamBody(body() as TravelTimeRequest));
        assert.equal(travel.status, 200);
        assert.deepEqual(urls, ['/sar/tarr', '/sar/travel-time']);
    } finally {
        upstreamAllowForTests.splice(upstreamAllowForTests.indexOf(origin), 1);
        await new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
        });
    }
});
