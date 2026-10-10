import test from 'node:test';
import assert from 'node:assert';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';
import type { InferSelectModel } from 'drizzle-orm';
import type { Response } from 'express';
import ZXYBasemap from '../stateless/lib/basemap/zxy.js';
import { Basemap } from '../common/schema.js';

const UPSTREAM_ORIGIN = 'https://tiles.example.com';

const basemap = new ZXYBasemap({
    url: `${UPSTREAM_ORIGIN}/{$z}/{$x}/{$y}`,
} as unknown as InferSelectModel<typeof Basemap>);

const originalDispatcher = getGlobalDispatcher();
let agent: MockAgent;

/**
 * Minimal fake Express Response: only the members ZXYBasemap._tile() calls.
 */
function fakeRes() {
    const chunks: Buffer[] = [];
    let statusCode = 0;
    let headers: Record<string, string | number | string[]> = {};
    let ended = false;

    const res = {
        writeHead: (code: number, hdrs?: Record<string, string | number | string[]>) => {
            statusCode = code;
            headers = hdrs || {};
            return res;
        },
        write: (chunk: Buffer | string) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            return true;
        },
        end: (chunk?: Buffer | string) => {
            if (chunk) {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            }
            ended = true;
            return res;
        },
    };

    return {
        res: res as unknown as Response,
        get statusCode() {
            return statusCode;
        },
        get headers() {
            return headers;
        },
        get ended() {
            return ended;
        },
        get body() {
            return Buffer.concat(chunks);
        },
    };
}

test('ZXYBasemap Proxy - setup', () => {
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
});

test('ZXYBasemap Proxy - forwards CloudTAK UA/Referer, never the client UA', async () => {
    const pool = agent.get(UPSTREAM_ORIGIN);
    let capturedHeaders: Record<string, string | string[] | undefined> = {};

    pool.intercept({
        path: '/1/2/3',
        method: 'GET',
    }).reply((opts) => {
        capturedHeaders = opts.headers as Record<string, string | string[] | undefined>;
        return { statusCode: 200, data: 'tile-bytes', responseOptions: { headers: { 'content-type': 'image/png' } } };
    });

    const captured = fakeRes();

    await basemap.tile(1, 2, 3, captured.res, {
        headers: {
            'user-agent': 'CloudTAK/1.0 (+http://localhost:5001)',
            'referer': 'http://localhost:5001/',
            'accept': 'image/png',
        },
    });

    assert.equal(capturedHeaders['user-agent'], 'CloudTAK/1.0 (+http://localhost:5001)');
    assert.equal(capturedHeaders['referer'], 'http://localhost:5001/');
    assert.equal(capturedHeaders['accept'], 'image/png');
    assert.notEqual(capturedHeaders['user-agent'], 'Mozilla/5.0 (some client browser)');
});

test('ZXYBasemap Proxy - upstream 403 maps to 502 without passthrough', async () => {
    const pool = agent.get(UPSTREAM_ORIGIN);

    pool.intercept({
        path: '/1/2/3',
        method: 'GET',
    }).reply(403, '<html>Forbidden</html>', {
        headers: { 'content-type': 'text/html' },
    });

    const captured = fakeRes();

    await basemap.tile(1, 2, 3, captured.res, {
        headers: {
            'user-agent': 'CloudTAK/1.0 (+http://localhost:5001)',
            'referer': 'http://localhost:5001/',
        },
    });

    assert.equal(captured.statusCode, 502);
    assert.ok(captured.ended);

    const parsed = JSON.parse(captured.body.toString());
    assert.deepEqual(parsed, {
        status: 502,
        message: 'Upstream tile server (tiles.example.com) returned 403',
        messages: [],
    });

    assert.ok(!captured.body.toString().includes('Forbidden'), 'Upstream body must not be relayed');
});

test('ZXYBasemap Proxy - upstream 404 still passes through as 404', async () => {
    const pool = agent.get(UPSTREAM_ORIGIN);

    pool.intercept({
        path: '/1/2/3',
        method: 'GET',
    }).reply(404, '', {
        headers: { 'content-type': 'text/plain' },
    });

    const captured = fakeRes();

    await basemap.tile(1, 2, 3, captured.res, {
        headers: {
            'user-agent': 'CloudTAK/1.0 (+http://localhost:5001)',
            'referer': 'http://localhost:5001/',
        },
    });

    assert.equal(captured.statusCode, 404);
});

test('ZXYBasemap Proxy - upstream 200 still streams the body', async () => {
    const pool = agent.get(UPSTREAM_ORIGIN);

    pool.intercept({
        path: '/1/2/3',
        method: 'GET',
    }).reply(200, 'this-is-a-tile', {
        headers: { 'content-type': 'image/png' },
    });

    const captured = fakeRes();

    await basemap.tile(1, 2, 3, captured.res, {
        headers: {
            'user-agent': 'CloudTAK/1.0 (+http://localhost:5001)',
            'referer': 'http://localhost:5001/',
        },
    });

    assert.equal(captured.statusCode, 200);
    assert.equal(captured.body.toString(), 'this-is-a-tile');
});

test('ZXYBasemap Proxy - teardown', async () => {
    await agent.close();
    setGlobalDispatcher(originalDispatcher);
});
