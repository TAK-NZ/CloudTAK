import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

/**
 * jsdom has no real canvas/Image decoding pipeline (no `canvas` npm package
 * installed), so `decodeSvgBlob()`'s `<img>` + `<canvas>` rasterization is
 * stubbed with minimal fakes here that just need to resolve/produce
 * something shaped like an ImageBitmap - the goal of these tests is to
 * confirm IconManager's *control flow* (which ids get a real image
 * registered vs left unresolved), not pixel-perfect rendering.
 */
function installCanvasStubs() {
    class FakeImage {
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        decoding = 'async';
        set src(_value: string) {
            queueMicrotask(() => this.onload?.());
        }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).Image = FakeImage;

    const fakeCtx = { drawImage: vi.fn() };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (HTMLCanvasElement.prototype as any).getContext = vi.fn(() => fakeCtx);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).createImageBitmap = vi.fn(async () => ({ width: 32, height: 32, close: vi.fn() }));

    if (!URL.createObjectURL) {
        URL.createObjectURL = vi.fn(() => 'blob:fake');
    }
    if (!URL.revokeObjectURL) {
        URL.revokeObjectURL = vi.fn();
    }
}

describe('IconManager - unresolvable CoT-type icon ids', () => {
    let map: {
        hasImage: ReturnType<typeof vi.fn>;
        addImage: ReturnType<typeof vi.fn>;
        setMissingStyleImageResolver: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
        installCanvasStubs();
        map = {
            hasImage: vi.fn(() => false),
            addImage: vi.fn(),
            setMissingStyleImageResolver: vi.fn(),
        };
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('registers a fallback image for a plain CoT type with no sprite entry (e.g. a-u-A-C-F-q), instead of leaving it unresolved', async () => {
        const { default: IconManager } = await import('./icons.ts');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const manager = new IconManager(map as any);

        await manager.resolve('a-u-A-C-F-q');

        // The bug this guards against: the unhandled-id branch used to only
        // log a warning and never call addImage(), so the feature rendered
        // with no icon at all despite the Icon Picker UI showing a
        // placeholder for the same type.
        expect(map.addImage).toHaveBeenCalledTimes(1);
        expect(map.addImage).toHaveBeenCalledWith('a-u-A-C-F-q', expect.anything());
    });

    it('reuses the same cached map-pin bitmap across multiple unresolved ids', async () => {
        const { default: IconManager } = await import('./icons.ts');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const manager = new IconManager(map as any);

        await manager.resolve('a-u-A-C-F-q');
        await manager.resolve('a-h-G-U-C-I');

        expect(map.addImage).toHaveBeenCalledTimes(2);
        const [, firstBitmap] = map.addImage.mock.calls[0];
        const [, secondBitmap] = map.addImage.mock.calls[1];
        expect(firstBitmap).toBe(secondBitmap);
    });

    it('does not warn a second time for the same unresolved id (logWarnOnce dedupe)', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const { default: IconManager } = await import('./icons.ts');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const manager = new IconManager(map as any);

        // First call: not yet registered, goes through the fallback branch
        // (and warns once). Second call: already registered (hasImage()
        // short-circuits resolveImage() before it would warn again).
        map.hasImage.mockImplementationOnce(() => false).mockImplementation(() => true);
        await manager.resolve('a-u-A-C-F-q');
        await manager.resolve('a-u-A-C-F-q');

        expect(warnSpy).toHaveBeenCalledTimes(1);
    });
});
