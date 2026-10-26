/**
 * Folder-tree parsing for channel lists.
 *
 * TAK channel names encode a folder hierarchy with a separator, e.g.
 * "BCH - Alerts - MetService" is the channel "MetService" inside the folder
 * "Alerts" inside the folder "BCH". A name can be a channel and a folder at the
 * same time: "Teams - AWS" and "Teams - AWS - Test" produce a single "AWS" node
 * that carries the "Teams - AWS" channel and has "Test" as a child.
 */

export const CHANNEL_FOLDER_SEPARATOR = ' - ';

export type ChannelTreeNode<T extends { name: string }> = {
    /** Unique key for the node, usable for expand/collapse state */
    path: string;
    /** Label shown for this node (the last segment of the channel name) */
    label: string;
    /** The channel that ends at this node, if any */
    channel?: T;
    children: Array<ChannelTreeNode<T>>;
};

export type ChannelTreeOptions = {
    separator?: string;
    descending?: boolean;
};

// Folder names are free text, so the path key must not collide with them
const PATH_JOIN = '\u001f';

function compare(a: string, b: string, descending: boolean): number {
    const cmp = a.localeCompare(b);
    return descending ? -cmp : cmp;
}

function segmentsOf(name: string, separator: string): Array<string> | undefined {
    const parts = name.split(separator).map((part) => part.trim());

    // Leading, trailing or doubled separators (e.g. "A -  - B") cannot be
    // expressed as folders, so those names are kept as a single flat channel
    if (parts.length < 2 || parts.some((part) => part === '')) return undefined;

    return parts;
}

/**
 * Build a nested folder tree from a flat list of channels.
 *
 * Within a level, nodes that contain children (folders, including channels that
 * are also folders) are listed first, then plain channels, each sorted by label.
 */
export function buildChannelTree<T extends { name: string }>(
    channels: Array<T>,
    opts: ChannelTreeOptions = {}
): Array<ChannelTreeNode<T>> {
    const separator = opts.separator ?? CHANNEL_FOLDER_SEPARATOR;
    const descending = opts.descending ?? false;

    const root: Array<ChannelTreeNode<T>> = [];
    // Map rather than an object: a folder named "constructor" or "toString"
    // must not resolve to an inherited property
    const index = new Map<string, ChannelTreeNode<T>>();

    function node(path: Array<string>, label: string, siblings: Array<ChannelTreeNode<T>>): ChannelTreeNode<T> {
        const key = path.join(PATH_JOIN);
        let existing = index.get(key);

        if (!existing) {
            existing = { path: key, label, children: [] };
            index.set(key, existing);
            siblings.push(existing);
        }

        return existing;
    }

    // A flat channel is keyed by its full name so it cannot collide with a folder path
    function flat(channel: T): void {
        const key = `flat${PATH_JOIN}${channel.name}`;
        if (index.has(key)) return;

        const leaf: ChannelTreeNode<T> = { path: key, label: channel.name, channel, children: [] };
        index.set(key, leaf);
        root.push(leaf);
    }

    for (const channel of channels) {
        const parts = segmentsOf(channel.name, separator);

        if (!parts) {
            flat(channel);
            continue;
        }

        let siblings = root;
        let current: ChannelTreeNode<T> | undefined;
        const walked: Array<string> = [];

        for (const part of parts) {
            walked.push(part);
            current = node(walked, part, siblings);
            siblings = current.children;
        }

        // Two different names can trim to the same path; the first one wins the node
        // and the other stays reachable as a flat channel
        if (current && !current.channel) {
            current.channel = channel;
        } else {
            flat(channel);
        }
    }

    sortTree(root, descending);

    return root;
}

function sortTree<T extends { name: string }>(nodes: Array<ChannelTreeNode<T>>, descending: boolean): void {
    nodes.sort((a, b) => {
        const aFolder = a.children.length > 0;
        const bFolder = b.children.length > 0;
        if (aFolder !== bFolder) return aFolder ? -1 : 1;
        return compare(a.label, b.label, descending);
    });

    for (const child of nodes) sortTree(child.children, descending);
}

/**
 * Keep only the channels the predicate accepts, and the folders needed to reach them.
 * A node whose own channel is rejected but which still has accepted descendants
 * stays in the tree as a plain folder.
 */
export function filterChannelTree<T extends { name: string }>(
    nodes: Array<ChannelTreeNode<T>>,
    predicate: (channel: T) => boolean
): Array<ChannelTreeNode<T>> {
    const result: Array<ChannelTreeNode<T>> = [];

    for (const current of nodes) {
        const children = filterChannelTree(current.children, predicate);
        const channel = current.channel && predicate(current.channel) ? current.channel : undefined;

        if (channel || children.length) {
            result.push({ path: current.path, label: current.label, channel, children });
        }
    }

    return result;
}

/**
 * All channels at or below a node, the node's own channel first
 */
export function channelsInNode<T extends { name: string }>(current: ChannelTreeNode<T>): Array<T> {
    const channels: Array<T> = current.channel ? [current.channel] : [];

    for (const child of current.children) {
        channels.push(...channelsInNode(child));
    }

    return channels;
}

/**
 * Paths of every node that has children
 */
export function folderPaths<T extends { name: string }>(nodes: Array<ChannelTreeNode<T>>): Array<string> {
    const paths: Array<string> = [];

    for (const current of nodes) {
        if (current.children.length) {
            paths.push(current.path);
            paths.push(...folderPaths(current.children));
        }
    }

    return paths;
}
