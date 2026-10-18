/**
 * In-memory tile cache (LRU, byte bounded, with a TTL that an entry can override) and single-flight
 * de-duplication of concurrent identical upstream requests. A cache entry keeps
 * the image type (PNG or WebP) that was detected from the tile bytes.
 */

export type TileType = 'image/png' | 'image/webp';

/** Relay lifetime of a tile whose snapshot is final */
export const IMMUTABLE_TTL_MS = 7_200_000;
/** Browser lifetime (seconds) of a tile whose snapshot is final */
export const IMMUTABLE_MAX_AGE_S = 3600;
/** Relay lifetime of every other cached tile */
export const DEFAULT_TTL_MS = 600_000;
/** Browser lifetime (seconds) of every other cached tile */
export const DEFAULT_MAX_AGE_S = 600;

/**
 * How long a tile may be cached.
 *
 * A tile is immutable when the request pinned an explicit snapshot that is the
 * effective one (not `latest`, not absent, not clamped to the layer's newest),
 * the weather-proxy reports, in `X-Weather-Snapshot`, that very snapshot, and
 * the answer is neither a fallback nor an error tile and the proxy allows
 * caching. An unpinned or clamped request, a missing header (older proxy) or a
 * different value (the proxy stepped back) keeps the short lifetime.
 */
export function tileLifetime(input: {
    effective: number;
    pinned: boolean;
    upstream: number | null;
    fallback: boolean;
    error: boolean;
    cacheable: boolean;
}): { immutable: boolean; ttlMs: number; maxAge: number } {
    const immutable = input.pinned
        && input.upstream !== null
        && input.upstream === input.effective
        && !input.fallback
        && !input.error
        && input.cacheable;

    return immutable
        ? { immutable, ttlMs: IMMUTABLE_TTL_MS, maxAge: IMMUTABLE_MAX_AGE_S }
        : { immutable, ttlMs: DEFAULT_TTL_MS, maxAge: DEFAULT_MAX_AGE_S };
}

interface CacheEntry {
    body: Buffer;
    contentType: TileType;
    expires: number;
    immutable: boolean;
}

export class TileCache {
    maxBytes: number;
    ttlMs: number;
    maxEntryBytes: number;
    now: () => number;
    bytes = 0;
    #entries = new Map<string, CacheEntry>();

    constructor(opts: { maxBytes?: number; ttlMs?: number; maxEntryBytes?: number; now?: () => number } = {}) {
        this.maxBytes = opts.maxBytes ?? 64 * 1024 * 1024;
        this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
        this.maxEntryBytes = opts.maxEntryBytes ?? 1024 * 1024;
        this.now = opts.now ?? (() => Date.now());
    }

    get size(): number {
        return this.#entries.size;
    }

    get(key: string): { body: Buffer; contentType: TileType; immutable: boolean } | undefined {
        const entry = this.#entries.get(key);
        if (!entry) return undefined;

        if (entry.expires <= this.now()) {
            this.#delete(key, entry);
            return undefined;
        }

        // Re-insert so the Map iteration order is least recently used first
        this.#entries.delete(key);
        this.#entries.set(key, entry);
        return { body: entry.body, contentType: entry.contentType, immutable: entry.immutable };
    }

    set(key: string, body: Buffer, contentType: TileType, opts: { ttlMs?: number; immutable?: boolean } = {}): boolean {
        if (body.byteLength > this.maxEntryBytes || body.byteLength > this.maxBytes) return false;

        const existing = this.#entries.get(key);
        if (existing) this.#delete(key, existing);

        this.#entries.set(key, {
            body,
            contentType,
            expires: this.now() + (opts.ttlMs ?? this.ttlMs),
            immutable: opts.immutable ?? false,
        });
        this.bytes += body.byteLength;

        while (this.bytes > this.maxBytes) {
            const oldest = this.#entries.entries().next();
            if (oldest.done) break;
            this.#delete(oldest.value[0], oldest.value[1]);
        }

        return true;
    }

    #delete(key: string, entry: CacheEntry): void {
        this.#entries.delete(key);
        this.bytes -= entry.body.byteLength;
    }
}

export class SingleFlight<T> {
    #flights = new Map<string, Promise<T>>();

    has(key: string): boolean {
        return this.#flights.has(key);
    }

    get size(): number {
        return this.#flights.size;
    }

    /**
     * Run fn once per key at a time. `shared` is true for every caller that
     * joined a flight started by another caller.
     */
    async run(key: string, fn: () => Promise<T>): Promise<{ value: T; shared: boolean }> {
        const running = this.#flights.get(key);
        if (running) {
            return { value: await running, shared: true };
        }

        const promise = fn();
        this.#flights.set(key, promise);

        try {
            return { value: await promise, shared: false };
        } finally {
            this.#flights.delete(key);
        }
    }
}
