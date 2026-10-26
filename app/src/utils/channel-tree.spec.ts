import { describe, expect, it } from 'vitest';
import {
    buildChannelTree,
    filterChannelTree,
    channelsInNode,
    folderPaths,
} from './channel-tree.ts';

type Ch = { name: string; active?: boolean };

const ch = (name: string, active = true): Ch => ({ name, active });

describe('buildChannelTree', () => {
    it('nests channels using the " - " separator', () => {
        const tree = buildChannelTree([
            ch('BCH - Alerts - Emergency Mobile Alerts'),
            ch('BCH - Alerts - MetService'),
        ]);

        expect(tree).toHaveLength(1);
        expect(tree[0].label).toBe('BCH');
        expect(tree[0].channel).toBeUndefined();
        expect(tree[0].children).toHaveLength(1);

        const alerts = tree[0].children[0];
        expect(alerts.label).toBe('Alerts');
        expect(alerts.channel).toBeUndefined();
        expect(alerts.children.map((c) => c.label)).toEqual(['Emergency Mobile Alerts', 'MetService']);
        expect(alerts.children[0].channel?.name).toBe('BCH - Alerts - Emergency Mobile Alerts');
    });

    it('keeps channels without a separator at the root', () => {
        const tree = buildChannelTree([ch('Everyone'), ch('Teams - AWS')]);

        expect(tree.map((n) => n.label)).toEqual(['Teams', 'Everyone']);
        expect(tree[1].channel?.name).toBe('Everyone');
        expect(tree[1].children).toEqual([]);
    });

    it('lets a node be a channel and a folder at the same time', () => {
        const tree = buildChannelTree([
            ch('Teams - AWS - Test'),
            ch('Teams - AWS'),
        ]);

        const aws = tree[0].children[0];
        expect(aws.label).toBe('AWS');
        expect(aws.channel?.name).toBe('Teams - AWS');
        expect(aws.children).toHaveLength(1);
        expect(aws.children[0].channel?.name).toBe('Teams - AWS - Test');
    });

    it('produces the same tree regardless of input order', () => {
        const names = ['Teams - AWS - Test', 'Teams - AWS', 'Teams - Other', 'Solo'];

        const a = buildChannelTree(names.map((n) => ch(n)));
        const b = buildChannelTree([...names].reverse().map((n) => ch(n)));

        expect(b).toEqual(a);
    });

    it('lists folders before plain channels and sorts each group', () => {
        const tree = buildChannelTree([
            ch('Zulu'),
            ch('Alpha'),
            ch('Mid - Child'),
            ch('Beta - Child'),
        ]);

        expect(tree.map((n) => n.label)).toEqual(['Beta', 'Mid', 'Alpha', 'Zulu']);
    });

    it('sorts descending when asked', () => {
        const tree = buildChannelTree([ch('Alpha'), ch('Zulu')], { descending: true });

        expect(tree.map((n) => n.label)).toEqual(['Zulu', 'Alpha']);
    });

    it('supports a custom separator', () => {
        const tree = buildChannelTree([ch('A/B'), ch('A/C')], { separator: '/' });

        expect(tree[0].label).toBe('A');
        expect(tree[0].children.map((n) => n.label)).toEqual(['B', 'C']);
    });

    it('does not treat inherited property names as existing folders', () => {
        const tree = buildChannelTree([
            ch('constructor - toString'),
            ch('valueOf - hasOwnProperty'),
        ]);

        expect(tree.map((n) => n.label).sort()).toEqual(['constructor', 'valueOf']);
        expect(tree.find((n) => n.label === 'constructor')?.children[0].label).toBe('toString');
    });

    it('keeps names with empty segments as flat channels', () => {
        const tree = buildChannelTree([
            ch('A -  - B'),
            ch(' - Leading'),
            ch('Trailing - '),
        ]);

        expect(tree.map((n) => n.label).sort()).toEqual([' - Leading', 'A -  - B', 'Trailing - ']);
        expect(tree.every((n) => n.channel && n.children.length === 0)).toBe(true);
    });

    it('does not lose a channel when two names trim to the same path', () => {
        const tree = buildChannelTree([
            ch('Teams - AWS'),
            ch('Teams -  AWS'),
        ]);

        const all = tree.flatMap((n) => channelsInNode(n)).map((c) => c.name).sort();
        expect(all).toEqual(['Teams -  AWS', 'Teams - AWS']);
    });

    it('gives every node a unique path', () => {
        const tree = buildChannelTree([
            ch('A - B'),
            ch('A - B - C'),
            ch('B'),
            ch('A - C'),
        ]);

        const paths: Array<string> = [];
        const walk = (nodes: typeof tree) => nodes.forEach((n) => {
            paths.push(n.path);
            walk(n.children);
        });
        walk(tree);

        expect(new Set(paths).size).toBe(paths.length);
    });
});

describe('filterChannelTree', () => {
    const tree = buildChannelTree([
        ch('Teams - AWS', true),
        ch('Teams - AWS - Test', false),
        ch('Teams - Other', false),
        ch('Solo', true),
    ]);

    it('keeps folders only when they lead to a matching channel', () => {
        const filtered = filterChannelTree(tree, (c) => c.name === 'Teams - Other');

        expect(filtered).toHaveLength(1);
        expect(filtered[0].label).toBe('Teams');
        expect(filtered[0].children.map((n) => n.label)).toEqual(['Other']);
    });

    it('turns a channel-and-folder node into a plain folder when only its children match', () => {
        const filtered = filterChannelTree(tree, (c) => c.active === false && c.name.endsWith('Test'));

        const aws = filtered[0].children[0];
        expect(aws.label).toBe('AWS');
        expect(aws.channel).toBeUndefined();
        expect(aws.children[0].channel?.name).toBe('Teams - AWS - Test');
    });

    it('returns nothing when nothing matches', () => {
        expect(filterChannelTree(tree, () => false)).toEqual([]);
    });

    it('does not mutate the source tree', () => {
        filterChannelTree(tree, () => false);

        expect(channelsInNode(tree[0]).length).toBeGreaterThan(0);
    });
});

describe('channelsInNode', () => {
    it('returns the node channel first, then descendants', () => {
        const tree = buildChannelTree([
            ch('Teams - AWS'),
            ch('Teams - AWS - Test'),
            ch('Teams - AWS - Test - Deep'),
        ]);

        const aws = tree[0].children[0];
        expect(channelsInNode(aws).map((c) => c.name)).toEqual([
            'Teams - AWS',
            'Teams - AWS - Test',
            'Teams - AWS - Test - Deep',
        ]);
    });
});

describe('folderPaths', () => {
    it('lists every node that has children', () => {
        const tree = buildChannelTree([
            ch('Teams - AWS'),
            ch('Teams - AWS - Test'),
            ch('Teams - Other'),
            ch('Solo'),
        ]);

        const paths = folderPaths(tree);
        expect(paths).toHaveLength(2);
        expect(paths).toContain(tree[0].path);
        expect(paths).toContain(tree[0].children[0].path);
    });
});
