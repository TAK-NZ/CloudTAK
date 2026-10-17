/**
 * Fixed window request counter.
 *
 * The window index is floor(now / windowMs). A counter resets only when the
 * window index changes; a hit never extends or restarts the window, so a
 * client that keeps retrying cannot keep itself locked out.
 */

export interface LimiterResult {
    ok: boolean;
    count: number;
    retryAfterS: number;
}

interface Entry {
    window: number;
    count: number;
}

export class FixedWindowLimiter {
    windowMs: number;
    maxIds: number;
    now: () => number;
    #entries = new Map<string, Entry>();
    #timer: NodeJS.Timeout;

    constructor(opts: { windowMs: number; maxIds?: number; now?: () => number }) {
        this.windowMs = opts.windowMs;
        this.maxIds = opts.maxIds ?? 10000;
        this.now = opts.now ?? (() => Date.now());

        this.#timer = setInterval(() => this.sweep(), this.windowMs);
        this.#timer.unref();
    }

    get size(): number {
        return this.#entries.size;
    }

    hit(id: string, limit: number): LimiterResult {
        const now = this.now();
        const window = Math.floor(now / this.windowMs);

        let entry = this.#entries.get(id);
        if (!entry || entry.window !== window) {
            if (entry) {
                this.#entries.delete(id);
            } else {
                this.#makeRoom(window);
            }
            entry = { window, count: 0 };
            this.#entries.set(id, entry);
        }

        entry.count++;

        const retryAfterS = Math.max(1, Math.ceil(((window + 1) * this.windowMs - now) / 1000));
        return { ok: entry.count <= limit, count: entry.count, retryAfterS };
    }

    /**
     * Drop every counter that belongs to an older window
     */
    sweep(): void {
        const window = Math.floor(this.now() / this.windowMs);
        for (const [id, entry] of this.#entries) {
            if (entry.window < window) this.#entries.delete(id);
        }
    }

    stop(): void {
        clearInterval(this.#timer);
    }

    #makeRoom(window: number): void {
        if (this.#entries.size < this.maxIds) return;

        for (const [id, entry] of this.#entries) {
            if (entry.window < window) this.#entries.delete(id);
        }

        // Still full: drop the oldest ids (Map iterates in insertion order)
        while (this.#entries.size >= this.maxIds) {
            const oldest = this.#entries.keys().next();
            if (oldest.done) break;
            this.#entries.delete(oldest.value);
        }
    }
}
