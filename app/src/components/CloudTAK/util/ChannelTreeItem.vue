<template>
    <div class='d-flex flex-column gap-2'>
        <!-- Folder that is not a channel -->
        <StandardItem
            v-if='!node.channel'
            @click='$emit("toggle-expand", node.path)'
        >
            <div class='d-flex align-items-center gap-3 px-3 py-2'>
                <div
                    class='d-flex align-items-center justify-content-center rounded-circle bg-black bg-opacity-25 flex-shrink-0'
                    style='width: 48px; height: 48px;'
                >
                    <component
                        :is='isExpanded ? IconFolderOpen : IconFolder'
                        :size='24'
                        stroke='1'
                    />
                </div>

                <div class='flex-grow-1 overflow-hidden'>
                    <div
                        class='fw-semibold text-truncate'
                        :title='node.label'
                        v-text='node.label'
                    />
                    <div
                        class='text-white-50 small text-truncate'
                        v-text='summary'
                    />
                </div>

                <TablerIconButton
                    :title='folderToggleTitle'
                    @click.stop='$emit("toggle-folder", all)'
                >
                    <component
                        :is='folderIcon'
                        :size='24'
                        stroke='1'
                    />
                </TablerIconButton>

                <component
                    :is='isExpanded ? IconChevronDown : IconChevronRight'
                    :size='24'
                    stroke='1'
                    class='flex-shrink-0'
                />
            </div>
        </StandardItem>

        <!-- Channel, which may also be a folder -->
        <StandardItemChannel
            v-else
            :channel='node.channel'
            :label='node.label'
            @click='$emit("toggle-channel", node.channel)'
        >
            <template
                v-if='node.children.length'
                #actions
            >
                <TablerIconButton
                    :title='folderToggleTitle'
                    @click.stop='$emit("toggle-folder", all)'
                >
                    <component
                        :is='folderIcon'
                        :size='24'
                        stroke='1'
                    />
                </TablerIconButton>

                <TablerIconButton
                    :title='isExpanded ? "Collapse" : "Expand"'
                    @click.stop='$emit("toggle-expand", node.path)'
                >
                    <component
                        :is='isExpanded ? IconChevronDown : IconChevronRight'
                        :size='24'
                        stroke='1'
                    />
                </TablerIconButton>
            </template>
        </StandardItemChannel>

        <div
            v-if='node.children.length && isExpanded'
            class='d-flex flex-column gap-2 ms-3 ps-2 border-start'
        >
            <ChannelTreeItem
                v-for='child in node.children'
                :key='child.path'
                :node='child'
                :expanded='expanded'
                :force-expanded='forceExpanded'
                @toggle-expand='$emit("toggle-expand", $event)'
                @toggle-channel='$emit("toggle-channel", $event)'
                @toggle-folder='$emit("toggle-folder", $event)'
            />
        </div>
    </div>
</template>

<script setup lang='ts'>
import { computed } from 'vue';
import StandardItem from './StandardItem.vue';
import StandardItemChannel from './StandardItemChannel.vue';
import { TablerIconButton } from '@tak-ps/vue-tabler';
import { channelsInNode } from '../../../utils/channel-tree.ts';
import type { ChannelTreeNode } from '../../../utils/channel-tree.ts';
import type { GroupChannel } from '../../../types.ts';
import {
    IconChevronDown,
    IconChevronRight,
    IconEye,
    IconEyeDotted,
    IconEyeOff,
    IconFolder,
    IconFolderOpen,
} from '@tabler/icons-vue';

const props = defineProps<{
    node: ChannelTreeNode<GroupChannel>;
    expanded: Set<string>;
    /** Show every folder open, used while a filter is applied so matches are visible */
    forceExpanded?: boolean;
}>();

defineEmits<{
    (e: 'toggle-expand', path: string): void;
    (e: 'toggle-channel', channel: GroupChannel): void;
    (e: 'toggle-folder', channels: Array<GroupChannel>): void;
}>();

const isExpanded = computed(() => {
    return props.forceExpanded || props.expanded.has(props.node.path);
});

const all = computed(() => channelsInNode(props.node));
const activeCount = computed(() => all.value.filter((ch) => ch.active !== false).length);

const summary = computed(() => {
    const total = all.value.length;
    return `${activeCount.value} of ${total} channel${total === 1 ? '' : 's'} active`;
});

const folderIcon = computed(() => {
    if (activeCount.value === 0) return IconEyeOff;
    if (activeCount.value === all.value.length) return IconEye;
    return IconEyeDotted;
});

const folderToggleTitle = computed(() => {
    return activeCount.value === all.value.length
        ? `Turn off all ${all.value.length} channels in this folder`
        : `Turn on all ${all.value.length} channels in this folder`;
});
</script>
