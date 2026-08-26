<template>
    <IconCircleFilled
        v-if='props.team'
        :size='props.size ? props.size : 32'
        :color='teamColor'
        stroke='1'
    />
    <IconUserQuestion
        v-else
        :size='props.size ? props.size : 32'
        stroke='1'
    />
</template>

<script setup lang='ts'>
import { computed } from 'vue';
import {
    IconUserQuestion,
    IconCircleFilled,
} from '@tabler/icons-vue';

const props = defineProps<{
    team?: string,
    size?: number
}>();

// ATAK's actual RGB values for each TAK team colour
// (Icon2525cIconAdapter.teamToColor()), not CSS/UI framework theme colours -
// mirrors TEAM_COLORS in base/cot.ts. These used to be Tabler brand-palette
// CSS variables (e.g. --tblr-dribbble for Magenta, --tblr-google for Brown),
// which do not represent the named colour and made "Yellow" render as amber,
// "Green" as yellow-green, etc.
const teamColors: Record<string, string> = {
    White: '#FFFFFF',
    Yellow: '#FFFF00',
    Orange: '#FF7700',
    Magenta: '#FF00FF',
    Red: '#FF0000',
    Maroon: '#7F0000',
    Purple: '#7F007F',
    'Dark Blue': '#00007F',
    Blue: '#0000FF',
    Cyan: '#00FFFF',
    Teal: '#007F7F',
    Green: '#00FF00',
    'Dark Green': '#007F00',
    Brown: '#A0714F',
};

const teamColor = computed(() => {
    if (!props.team) return undefined;

    return teamColors[props.team];
});
</script>
