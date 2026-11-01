import test from 'node:test';
import assert from 'node:assert/strict';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';
import type { Response } from 'express';
import Err from '@openaddresses/batch-error';
import ZXYBasemap from '../lib/basemap/zxy.js';
import Basemap from '../lib/basemap.js';
import type { BasemapConfig } from '../lib/basemap.js';

// Skip the DNS based SSRF check, which would need real name resolution
process.env.StackName = 'test';

const UPSTREAM_ORIGIN = 'https://tiles.example.com';

const zxy = new ZXYBasemap({
    url: `${UPSTREAM_ORIGIN}/{$z}/{$x}/{$y}`,
} as unknown as BasemapConfig);

const originalDispatcher = getGlobalDispatcher();
let agent: MockAgent;

/**
 * Minimal fake Express Response: only the members pipe() calls.
 */
function fakeRes() {
    const chunks: Buffer[] = [];
    let statusCode = 0;
    let headers: Record<string, string | string[]> = {};
    let ended = false;

    const res = {
        headersSent: false,
        writeHead: (code: number, hdrs?: Record<string, string | string[]>) => {
            statusCode = code;
            headers = hdrs || {};
            res.headersSent = true;
            return res;
        },
        write: (chunk: Buffer | string) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            return true;
        },
        end: () => {
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
        get written() {
            return Buffer.concat(chunks).toString();
        },
    };
}

test('Basemap Proxy - setup', () => {
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
});

test('Basemap Proxy - upstreamHeaders never forwards the client User-Agent', () => {
    const previous = process.env.API_URL;
    process.env.API_URL = 'https://map.example.test/';

    try {
        const headers = Basemap.upstreamHeaders({
            accept: 'image/png',
            acceptLanguage: 'en-NZ',
        });

        assert.equal(headers['user-agent'], 'CloudTAK (+https://map.example.test)');
        assert.equal(headers['referer'], 'https://map.example.test/');
        assert.equal(headers['accept'], 'image/png');
        assert.equal(headers['accept-language'], 'en-NZ');
        assert.ok(!String(headers['user-agent']).includes('Mozilla'));
    } finally {
        if (previous === undefined) delete process.env.API_URL;
        else process.env.API_URL = previous;
    }
});

test('Basemap Proxy - upstreamHeaders omits client headers that were not sent', () => {
    const headers = Basemap.upstreamHeaders();

    assert.equal(headers['accept'], undefined);
    assert.equal(headers['accept-language'], undefined);
    assert.ok(headers['referer']);
});

test('Basemap Proxy - sends the upstream headers it is given', async () => {
    const pool = agent.get(UPSTREAM_ORIGIN);
    let captured: Record<string, string | string[] | undefined> = {};

    pool.intercept({
        path: '/1/2/3',
        method: 'GET',
    }).reply((opts) => {
        captured = opts.headers as Record<string, string | string[] | undefined>;
        return { statusCode: 200, data: 'tile-bytes', responseOptions: { headers: { 'content-type': 'image/png' } } };
    });

    const out = fakeRes();
    await zxy.tile(1, 2, 3, out.res, {
        headers: Basemap.upstreamHeaders({ accept: 'image/png' }),
    });

    assert.match(String(captured['user-agent']), /^CloudTAK /);
    assert.ok(String(captured['referer']).endsWith('/'));
    assert.equal(captured['accept'], 'image/png');
});

test('Basemap Proxy - upstream 403 becomes a 502 and the upstream body is not relayed', async () => {
    const pool = agent.get(UPSTREAM_ORIGIN);

    pool.intercept({
        path: '/1/2/3',
        method: 'GET',
    }).reply(403, '<html>Forbidden</html>', {
        headers: { 'content-type': 'text/html' },
    });

    const out = fakeRes();

    await assert.rejects(
        zxy.tile(1, 2, 3, out.res, { headers: Basemap.upstreamHeaders() }),
        (err: unknown) => {
            assert.ok(err instanceof Err);
            assert.equal((err as Err).status, 502);
            assert.equal((err as Err).safe, 'Upstream tile server (tiles.example.com) returned 403');
            return true;
        },
    );

    assert.equal(out.statusCode, 0, 'no response may be started for the upstream error');
    assert.ok(!out.written.includes('Forbidden'));
});

test('Basemap Proxy - upstream 404 still passes through as 404', async () => {
    const pool = agent.get(UPSTREAM_ORIGIN);

    pool.intercept({
        path: '/1/2/3',
        method: 'GET',
    }).reply(404, '', {
        headers: { 'content-type': 'text/plain' },
    });

    const out = fakeRes();
    await zxy.tile(1, 2, 3, out.res, { headers: Basemap.upstreamHeaders() });

    assert.equal(out.statusCode, 404);
});

test('Basemap Proxy - upstream 200 still streams the body', async () => {
    const pool = agent.get(UPSTREAM_ORIGIN);

    pool.intercept({
        path: '/1/2/3',
        method: 'GET',
    }).reply(200, 'this-is-a-tile', {
        headers: { 'content-type': 'image/png' },
    });

    const out = fakeRes();
    await zxy.tile(1, 2, 3, out.res, { headers: Basemap.upstreamHeaders() });

    assert.equal(out.statusCode, 200);
    assert.equal(out.written, 'this-is-a-tile');
    assert.ok(out.ended);
});

test('Basemap Proxy - teardown', async () => {
    await agent.close();
    setGlobalDispatcher(originalDispatcher);
});
