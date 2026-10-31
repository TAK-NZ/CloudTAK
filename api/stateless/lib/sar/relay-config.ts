/**
 * Configuration of the SAR travel-time relay.
 *
 * The values are read from the process environment on EVERY call (never
 * cached) so a changed environment is picked up without a restart of the
 * module and tests can switch configurations between requests.
 */

export interface SarConfig {
    enabled: boolean;
    baseUrl: string | null;
    key: string | null;
    rate: number;
}

export const DEFAULT_RATE = 6;
export const MIN_RATE = 1;
export const MAX_RATE = 60;

const MAX_URL_LENGTH = 200;
const KEY_PATTERN = /^[A-Za-z0-9._~-]{16,128}$/;
const HTTPS_PATTERN = /^https:\/\/[^\s?#@]+$/;

/**
 * Origins that may be used over plain http. Production code never writes to
 * this array; the route tests push the origin of their local upstream here.
 * The same array is handed to node-safeurl as its allow list.
 */
export const upstreamAllowForTests: string[] = [];

const warned = new Set<string>();

export function __resetWarned(): void {
    warned.clear();
}

/**
 * Warn once per field. The invalid value itself is never printed.
 */
function warnOnce(field: string): void {
    if (warned.has(field)) return;
    warned.add(field);
    console.warn(`SAR relay: ${field} is set but invalid; the SAR relay stays disabled`);
}

export function parseBaseUrl(raw: string): string | null {
    const value = raw.trim();
    if (!value || value.length > MAX_URL_LENGTH) return null;

    const stripped = value.replace(/\/+$/, '');

    let url: URL;
    try {
        url = new URL(stripped);
    } catch {
        return null;
    }

    if (url.username || url.password || url.search || url.hash) return null;

    if (url.protocol === 'https:') {
        if (!HTTPS_PATTERN.test(stripped)) return null;
        return stripped;
    }

    if (url.protocol === 'http:' && upstreamAllowForTests.includes(url.origin)) {
        if (/[\s?#@]/.test(stripped)) return null;
        return stripped;
    }

    return null;
}

function parseRate(raw: string | undefined): number {
    if (raw === undefined || raw.trim() === '') return DEFAULT_RATE;

    const value = raw.trim();
    if (!/^[0-9]{1,3}$/.test(value)) {
        warnOnce('SAR_RATE_LIMIT');
        return DEFAULT_RATE;
    }

    const rate = Number(value);
    if (rate < MIN_RATE || rate > MAX_RATE) {
        warnOnce('SAR_RATE_LIMIT');
        return DEFAULT_RATE;
    }

    return rate;
}

export function getSarConfig(env: NodeJS.ProcessEnv = process.env): SarConfig {
    let baseUrl: string | null = null;
    let key: string | null = null;

    const rawUrl = env.SAR_SERVICE_URL;
    if (rawUrl !== undefined && rawUrl.trim() !== '') {
        baseUrl = parseBaseUrl(rawUrl);
        if (baseUrl === null) warnOnce('SAR_SERVICE_URL');
    }

    const rawKey = env.SAR_SERVICE_KEY;
    if (rawKey !== undefined && rawKey.trim() !== '') {
        if (KEY_PATTERN.test(rawKey.trim())) {
            key = rawKey.trim();
        } else {
            warnOnce('SAR_SERVICE_KEY');
        }
    }

    return {
        enabled: baseUrl !== null && key !== null,
        baseUrl,
        key,
        rate: parseRate(env.SAR_RATE_LIMIT),
    };
}
