import { describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { Observable } from 'rxjs';

const setChannels = vi.fn().mockResolvedValue([]);
const setChannel = vi.fn().mockResolvedValue([]);

const names = [
    'BCH - Alerts - Emergency Mobile Alerts',
    'BCH - Alerts - MetService',
    'BCH - Transport - Aircraft',
    'Teams - AWS',
    'Teams - AWS - Test',
    'XtraTools - Data Packages',
    'Everyone',
];

const channels = names.map((name) => ({
    name,
    description: '',
    direction: ['IN', 'OUT'],
    active: name !== 'Teams - AWS - Test',
}));

vi.mock('../../../base/group.ts', () => ({
    default: {
        liveList: () => new Observable((sub) => sub.next(channels)),
        sync: vi.fn().mockResolvedValue(undefined),
        put: vi.fn().mockResolvedValue(undefined),
    },
}));

vi.mock('../../../stores/map.ts', () => ({
    useMapStore: () => ({
        hasNoChannels: false,
        worker: { profile: { setChannels, setChannel, setAllChannels: vi.fn() } },
    }),
}));

import MenuChannels from './MenuChannels.vue';

const stubs = {
    MenuTemplate: { template: '<div><slot name="buttons" /><slot name="default" /></div>' },
    SearchSortFilter: { template: '<div />' },
    EmptyInfo: { template: '<div />' },
    TablerNone: { template: '<div class="none" />' },
    TablerIconButton: { template: '<div class="icon-button" @click="$emit(\'click\', $event)"><slot /></div>' },
    TablerRefreshButton: { template: '<div />' },
};

async function render() {
    const wrapper = mount(MenuChannels, { global: { stubs } });
    await flushPromises();
    return wrapper;
}

describe('MenuChannels folder tree', () => {
    it('shows top-level folders and root channels, not the flat full names', async () => {
        const wrapper = await render();
        const text = wrapper.text();

        expect(text).toContain('BCH');
        expect(text).toContain('Teams');
        expect(text).toContain('XtraTools');
        expect(text).toContain('Everyone');
        // Collapsed by default, so nested channels are hidden
        expect(text).not.toContain('MetService');
        expect(text).not.toContain('BCH - Alerts');
    });

    it('expands a folder to reveal children labelled by their last segment', async () => {
        const wrapper = await render();

        const bch = wrapper.findAll('.standard-item').find((el) => el.text().includes('BCH'))!;
        await bch.trigger('click');

        expect(wrapper.text()).toContain('Alerts');
        expect(wrapper.text()).toContain('Transport');
        expect(wrapper.text()).not.toContain('BCH - Alerts - MetService');

        const alerts = wrapper.findAll('.standard-item').find((el) => el.text().includes('Alerts'))!;
        await alerts.trigger('click');

        expect(wrapper.text()).toContain('MetService');
        expect(wrapper.text()).toContain('Emergency Mobile Alerts');
    });

    it('renders Teams - AWS as one row that is a channel and a folder', async () => {
        const wrapper = await render();

        const teams = wrapper.findAll('.standard-item').find((el) => el.text().includes('Teams'))!;
        await teams.trigger('click');

        const aws = wrapper.findAll('.standard-item').filter((el) => el.text().startsWith('AWS'));
        expect(aws).toHaveLength(1);

        // Clicking the row toggles the channel itself
        await aws[0].trigger('click');
        const { default: Group } = await import('../../../base/group.ts');
        expect(Group.put).toHaveBeenCalled();
        expect(setChannel).toHaveBeenCalledWith('Teams - AWS', false);
    });

    it('turns a whole folder on with one setChannels call', async () => {
        const wrapper = await render();

        const teams = wrapper.findAll('.standard-item').find((el) => el.text().includes('Teams'))!;
        // Teams has one inactive channel, so the folder toggle turns everything on
        await teams.find('[title^="Turn"]').trigger('click');

        expect(setChannels).toHaveBeenCalledWith(['Teams - AWS', 'Teams - AWS - Test'], true);
    });
});
