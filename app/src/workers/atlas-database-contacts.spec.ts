import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../std.ts', () => ({ server: { GET: vi.fn() }, bearer: () => undefined, stdurl: (url: string) => url }));
const prune = vi.hoisted(() => vi.fn(async () => 0));
vi.mock('../base/contact.ts', async (importOriginal) => {
    const mod = await importOriginal<typeof import('../base/contact.ts')>();
    return { ...mod, default: Object.assign(mod.default, { prune }) };
});
import AtlasDatabase from './atlas-database.ts';
import { WorkerMessageType } from '../utils/events.ts';
const FAR_FUTURE = '2999-01-01T00:00:00.000Z';
type FakeCot = {
    id: string;
    is_self: boolean;
    is_skittle: boolean;
    geometry: { type: string };
    properties: Record<string, unknown>;
    vectorId: () => string;
};
function cot(id: string, opts: { skittle?: boolean; self?: boolean; stale?: string } = {}): FakeCot {
    return {
        id,
        is_self: opts.self ?? false,
        is_skittle: opts.skittle ?? true,
        geometry: { type: 'Point' },
        properties: { stale: opts.stale ?? FAR_FUTURE, archived: false, 'icon-opacity': 1, 'marker-opacity': 1 },
        vectorId: () => id,
    };
}
function setup() {
    const postMessage = vi.fn();
    const atlas = { postMessage, profile: { display_stale: { value: 'Immediate' }, uid: () => 'me' } };
    const database = new AtlasDatabase(atlas as never);
    const add = (...cots: FakeCot[]) => { for (const c of cots) database.cots.set(c.id, c as never); };
    const changes = () => postMessage.mock.calls
        .map((call) => call[0] as { type: string; body: { count: number } })
        .filter((msg) => msg.type === WorkerMessageType.Contact_Online_Change)
        .map((msg) => msg.body.count);
    return { database, add, changes };
}
beforeEach(() => {
    prune.mockClear();
});
describe('AtlasDatabase: online contacts', () => {
    it('publishes the count of contacts with a live marker when it changes', async () => {
        const { database, add, changes } = setup();
        add(cot('a'), cot('b'));
        await database.diff();
        expect(changes()).toEqual([2]);
    });
    it('does not count the user or markers that are not contacts', async () => {
        const { database, add, changes } = setup();
        add(cot('me', { self: true }), cot('sensor', { skittle: false }), cot('a'));
        await database.diff();
        expect(changes()).toEqual([1]);
    });
    it('stays quiet while the set is unchanged', async () => {
        const { database, add, changes } = setup();
        add(cot('a'));
        await database.diff();
        await database.diff();
        await database.diff();
        expect(changes()).toEqual([1]);
    });
    it('publishes again when a contact appears or goes away', async () => {
        const { database, add, changes } = setup();
        add(cot('a'));
        await database.diff();
        add(cot('b'));
        await database.diff();
        database.cots.delete('a');
        await database.diff();
        expect(changes()).toEqual([1, 2, 1]);
    });
    it('stops counting a contact whose marker went stale', async () => {
        const { database, add, changes } = setup();
        add(cot('a'), cot('b', { stale: '2000-01-01T00:00:00.000Z' }));
        await database.diff();
        expect(changes()).toEqual([1]);
        expect(database.cots.has('b')).toBe(false);
    });
    it('prunes contacts that are not online, at most every few minutes', async () => {
        const { database, add } = setup();
        add(cot('a'));
        await database.diff();
        await database.diff();
        expect(prune).toHaveBeenCalledTimes(1);
        const [online] = prune.mock.calls[0] as unknown as [Set<string>];
        expect([...online]).toEqual(['a']);
    });
});
