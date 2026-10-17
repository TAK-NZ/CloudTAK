/**
 * In-memory tile cache (LRU, byte bounded, with TTL) and single-flight
 * de-duplication of concurrent identical upstream requests.
 */

interface CacheEntry {
    body: Buffer;
    expires: number;
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
        this.ttlMs = opts.ttlMs ?? 600000;
        this.maxEntryBytes = opts.maxEntryBytes ?? 1024 * 1024;
        this.now = opts.now ?? (() => Date.now());
    }

    get size(): number {
        return this.#entries.size;
    }

    get(key: string): Buffer | undefined {
        const entry = this.#entries.get(key);
        if (!entry) return undefined;

        if (entry.expires <= this.now()) {
            this.#delete(key, entry);
            return undefined;
        }

        // Re-insert so the Map iteration order is least recently used first
        this.#entries.delete(key);
        this.#entries.set(key, entry);
        return entry.body;
    }

    set(key: string, body: Buffer): boolean {
        if (body.byteLength > this.maxEntryBytes || body.byteLength > this.maxBytes) return false;

        const existing = this.#entries.get(key);
        if (existing) this.#delete(key, existing);

        this.#entries.set(key, { body, expires: this.now() + this.ttlMs });
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
