<template>
    <div class='col-12 row g-0'>
        <div class='col-12 d-flex align-items-center'>
            <label class='subheader mx-2'>Tides</label>
            <button
                v-if='tides'
                type='button'
                class='btn btn-link btn-sm ms-auto mx-2 p-0 small text-muted'
                :title='useDeviceTime ? "Times shown in your device time zone. Click to show station time." : "Times shown in the station time zone. Click to show device time."'
                @click='useDeviceTime = !useDeviceTime'
                v-text='timeZoneLabel'
            />
        </div>
        <TablerLoading
            v-if='loading'
            desc='Loading tides...'
        />
        <TablerAlert
            v-else-if='error'
            :err='error'
        />
        <div
            v-else-if='tides'
            class='col-12 px-2 py-2 rounded'
            style='border: 1px solid var(--tblr-border-color);'
        >
            <button
                type='button'
                class='w-100 bg-transparent border-0 p-0 text-start text-reset'
                :aria-expanded='expanded'
                @click='expanded = !expanded'
            >
                <div class='d-flex align-items-center'>
                    <IconWaveSine
                        :size='32'
                        stroke='1'
                    />
                    <div class='mx-2 flex-grow-1'>
                        <div
                            class='fw-bold'
                            v-text='tides.station.name'
                        />
                        <div
                            class='small text-muted'
                            v-text='formatStationDistance(tides.station.distance) + " away"'
                        />
                    </div>
                    <IconChevronUp
                        v-if='expanded'
                        :size='20'
                        stroke='1'
                    />
                    <IconChevronDown
                        v-else
                        :size='20'
                        stroke='1'
                    />
                </div>

                <TablerInlineAlert
                    v-if='farStation'
                    class='mt-2'
                    severity='warning'
                    title='Distant station'
                    :description='"The nearest station is " + formatStationDistance(tides.station.distance) + " away. Tide times and heights at this location may differ."'
                />

                <div
                    v-if='currentLevel !== null'
                    class='d-flex align-items-center mt-2'
                >
                    <component
                        :is='rising ? IconTrendingUp : IconTrendingDown'
                        :size='24'
                        stroke='1'
                        :class='rising ? "text-green" : "text-orange"'
                    />
                    <span
                        class='mx-2 h3 mb-0'
                        v-text='formatHeight(currentLevel)'
                    />
                    <span
                        class='text-muted'
                        v-text='rising ? "Rising" : "Falling"'
                    />
                </div>

                <div class='row g-2 mt-1'>
                    <div
                        v-for='next in nextTides'
                        :key='next.label'
                        class='col-6'
                    >
                        <div class='small text-muted'>
                            Next {{ next.label }}
                        </div>
                        <template v-if='next.extreme'>
                            <div v-text='formatWhen(next.extreme.t)' />
                            <div
                                class='small text-muted'
                                v-text='formatHeight(next.extreme.y) + " · " + fromNow(next.extreme.t)'
                            />
                        </template>
                        <div
                            v-else
                            class='text-muted'
                        >
                            --
                        </div>
                    </div>
                </div>
            </button>

            <div
                v-if='expanded'
                class='border-top mt-2 pt-2'
            >
                <div class='d-flex align-items-center mb-2'>
                    <div
                        class='btn-group btn-group-sm'
                        role='group'
                        aria-label='Chart range'
                    >
                        <button
                            type='button'
                            class='btn'
                            :class='range === 24 ? "btn-primary" : "btn-outline-secondary"'
                            @click='range = 24'
                        >
                            24 h
                        </button>
                        <button
                            type='button'
                            class='btn'
                            :class='range === 48 ? "btn-primary" : "btn-outline-secondary"'
                            @click='range = 48'
                        >
                            48 h
                        </button>
                    </div>
                    <span
                        class='ms-auto small text-muted'
                        v-text='"Height above " + datumLabel'
                    />
                </div>

                <div
                    class='tide-chart-shell'
                    role='img'
                    :aria-label='chartLabel'
                >
                    <canvas ref='canvasRef' />
                </div>

                <template
                    v-for='(row, i) in extremeRows'
                    :key='row.extreme.t'
                >
                    <div
                        v-if='i === 0 || row.day !== extremeRows[i - 1].day'
                        class='py-1 font-weight-bold small text-muted border-bottom'
                        :class='{ "mt-2": i > 0 }'
                        v-text='row.day'
                    />
                    <div class='d-flex align-items-center py-1'>
                        <component
                            :is='row.extreme.type === "high" ? IconArrowUp : IconArrowDown'
                            :size='16'
                            stroke='1'
                            :class='row.extreme.type === "high" ? "text-green" : "text-orange"'
                        />
                        <span
                            class='mx-2'
                            style='width: 3rem;'
                            v-text='row.extreme.type === "high" ? "High" : "Low"'
                        />
                        <span
                            class='flex-grow-1'
                            v-text='formatClock(row.extreme.t)'
                        />
                        <span
                            class='ms-auto font-weight-bold'
                            v-text='formatHeight(row.extreme.y)'
                        />
                    </div>
                </template>

                <div class='small text-muted mt-3'>
                    Predictions computed from harmonic constituents, not observations.
                    Weather, storm surge and river flow are not included.
                    Not for navigation.
                </div>
                <div
                    v-if='tides.station.attribution'
                    class='small text-muted mt-2'
                    style='overflow-wrap: anywhere;'
                    v-text='tides.station.attribution'
                />
            </div>
        </div>
        <div
            v-else
            class='col-12 d-flex py-2 px-2'
        >
            <div
                class='mx-2'
                style='font-size: 20px;'
            >
                No Tide Station Nearby
            </div>
        </div>
    </div>
</template>

<script setup lang='ts'>
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue';
import type { SearchReverseTides } from '../../../types.ts';
import { server } from '../../../std.ts';
import ProfileConfig from '../../../base/profile.ts';
import Chart from 'chart.js/auto';
import type { ChartData, ChartOptions, Plugin, TooltipItem } from 'chart.js';
import {
    IconWaveSine,
    IconChevronDown,
    IconChevronUp,
    IconTrendingUp,
    IconTrendingDown,
    IconArrowUp,
    IconArrowDown
} from '@tabler/icons-vue';
import {
    TablerLoading,
    TablerAlert,
    TablerInlineAlert
} from '@tak-ps/vue-tabler';

type Tides = NonNullable<SearchReverseTides['tides']>;

type Sample = { t: number; y: number };
type Extreme = Sample & { type: 'high' | 'low' };

const props = defineProps<{
    longitude: number;
    latitude: number;
}>();

const HOUR = 60 * 60 * 1000;

// The API only returns a station within 200 km. Beyond this distance the
// result is shown with a warning, since tides can differ noticeably between a
// station and a point that far from it.
const NEAR_STATION_KM = 50;

const loading = ref(true);
const error = ref<Error | undefined>();
const tides = ref<Tides | null>(null);

// The unit follows the user's Elevation Unit and Distance Unit display settings.
const distanceUnit = ref('meter');

const expanded = ref(false);
const range = ref<24 | 48>(24);
const useDeviceTime = ref(false);
const now = ref(Date.now());

const canvasRef = ref<HTMLCanvasElement | null>(null);
let chart: Chart<'line'> | null = null;
let timer: ReturnType<typeof setInterval> | undefined;

onMounted(async () => {
    try {
        const elevation = (await ProfileConfig.get('display_elevation'))?.value;
        distanceUnit.value = (await ProfileConfig.get('display_distance'))?.value || 'meter';

        const { data, error: reqError } = await server.GET('/api/search/reverse/{:longitude}/{:latitude}/tides', {
            params: {
                path: { ':longitude': props.longitude, ':latitude': props.latitude },
                query: { units: elevation === 'feet' ? 'feet' : 'meter' },
            },
        });

        if (reqError) throw new Error(reqError.message || String(reqError));
        tides.value = data.tides;
    } catch (err) {
        error.value = err instanceof Error ? err : new Error(String(err));
    } finally {
        loading.value = false;
    }

    // Keep "next tide" and the now marker current if the panel is left open
    timer = setInterval(() => {
        now.value = Date.now();
    }, 60 * 1000);
});

onBeforeUnmount(() => {
    if (timer) clearInterval(timer);
    destroyChart();
});

const timeline = computed<Sample[]>(() => {
    return (tides.value?.timeline || []).map((p) => ({ t: Date.parse(p.time), y: p.level }))
        .filter((p) => Number.isFinite(p.t));
});

const extremes = computed<Extreme[]>(() => {
    return (tides.value?.extremes || []).map((e) => ({ t: Date.parse(e.time), y: e.level, type: e.type }))
        .filter((e) => Number.isFinite(e.t));
});

// Water level now, interpolated between the two surrounding timeline samples.
// Null once the loaded window no longer covers the current time.
const currentLevel = computed<number | null>(() => {
    const t = now.value;
    const points = timeline.value;

    for (let i = 1; i < points.length; i++) {
        if (points[i].t < t) continue;
        const a = points[i - 1];
        const b = points[i];
        if (a.t > t || b.t === a.t) return null;
        return a.y + (b.y - a.y) * ((t - a.t) / (b.t - a.t));
    }

    return null;
});

const nextTides = computed(() => {
    return (['high', 'low'] as const).map((type) => ({
        label: type === 'high' ? 'High' : 'Low',
        extreme: extremes.value.find((e) => e.type === type && e.t > now.value),
    }));
});

// Heading towards the next extreme: a coming high means the tide is rising.
const rising = computed(() => {
    const next = extremes.value.find((e) => e.t > now.value);
    return next ? next.type === 'high' : false;
});

const view = computed(() => {
    const start = tides.value ? Date.parse(tides.value.start) : now.value;
    const end = tides.value ? Date.parse(tides.value.end) : now.value;

    if (range.value === 48) return { start, end };

    return {
        start: Math.max(start, now.value - 6 * HOUR),
        end: Math.min(end, now.value + 18 * HOUR),
    };
});

const extremeRows = computed(() => {
    return extremes.value
        .filter((e) => e.t >= view.value.start && e.t <= view.value.end)
        .map((extreme) => ({ extreme, day: formatDay(extreme.t) }));
});

const farStation = computed(() => (tides.value?.station.distance ?? 0) > NEAR_STATION_KM);

const unitLabel = computed(() => tides.value?.units === 'feet' ? 'ft' : 'm');

const datumLabel = computed(() => {
    const datum = tides.value?.station.datum;

    switch (datum) {
        case undefined: return 'datum';
        case 'CD': return 'chart datum';
        case 'MSL': return 'mean sea level';
        default: return datum;
    }
});

const chartLabel = computed(() => {
    if (!tides.value) return '';
    return `Tide predictions for ${tides.value.station.name} over the next ${range.value} hours.`;
});

// Tide times belong to the station, so they are shown in the station's zone by
// default. If the API gives none we show UTC rather than silently using the
// viewer's zone, as the Sun Phase section does. Intl throws a RangeError on an
// unknown zone and an exception in a computed would take down the whole Query
// panel, so the value is validated first.
const stationZone = computed(() => {
    const candidate = tides.value?.station.timezone;
    if (!candidate) return 'UTC';

    try {
        new Intl.DateTimeFormat(undefined, { timeZone: candidate });
        return candidate;
    } catch {
        return 'UTC';
    }
});

const timeZone = computed<string | undefined>(() => useDeviceTime.value ? undefined : stationZone.value);

const timeZoneLabel = computed(() => {
    try {
        const parts = new Intl.DateTimeFormat(undefined, {
            timeZone: timeZone.value,
            timeZoneName: 'short'
        }).formatToParts(new Date(now.value));

        return parts.find((part) => part.type === 'timeZoneName')?.value ?? (timeZone.value || 'Device');
    } catch {
        return timeZone.value || 'Device';
    }
});

const clockFormatter = computed(() => new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: timeZone.value
}));

const weekdayFormatter = computed(() => new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    timeZone: timeZone.value
}));

const dayFormatter = computed(() => new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'short',
    timeZone: timeZone.value
}));

const relativeTimeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

function formatClock(t: number): string {
    return clockFormatter.value.format(new Date(t));
}

function formatDay(t: number): string {
    return dayFormatter.value.format(new Date(t));
}

// Clock time, prefixed with the weekday when it is not today at the station
function formatWhen(t: number): string {
    if (formatDay(t) === formatDay(now.value)) return formatClock(t);
    return `${weekdayFormatter.value.format(new Date(t))} ${formatClock(t)}`;
}

function formatHeight(level: number): string {
    return `${level.toFixed(tides.value?.units === 'feet' ? 1 : 2)} ${unitLabel.value}`;
}

function formatStationDistance(km: number): string {
    switch (distanceUnit.value) {
        case 'kilometer': return `${km.toFixed(1)} km`;
        case 'mile': return `${(km * 0.621371).toFixed(1)} mi`;
        default: return `${Math.round(km * 1000).toLocaleString()} m`;
    }
}

function fromNow(t: number): string {
    const minutes = Math.round((t - now.value) / 60000);

    if (Math.abs(minutes) < 60) return relativeTimeFormatter.format(minutes, 'minute');
    return relativeTimeFormatter.format(Math.round(minutes / 60), 'hour');
}

watch([expanded, range, tides, useDeviceTime, now], async () => {
    await nextTick();
    renderChart();
});

function destroyChart(): void {
    if (chart) {
        chart.destroy();
        chart = null;
    }
}

// Ticks on whole local hours, every `step` hours. Chart.js would otherwise pick
// round numbers of milliseconds, which land on arbitrary clock times.
function clockTicks(min: number, max: number, step: number): number[] {
    const parts = new Intl.DateTimeFormat('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
        timeZone: timeZone.value
    });
    const quarter = 15 * 60 * 1000;
    const ticks: number[] = [];

    for (let t = Math.ceil(min / quarter) * quarter; t <= max; t += quarter) {
        const fields = parts.formatToParts(new Date(t));
        const hour = Number(fields.find((f) => f.type === 'hour')?.value);
        const minute = Number(fields.find((f) => f.type === 'minute')?.value);
        if (minute === 0 && hour % step === 0) ticks.push(t);
    }

    return ticks;
}

function renderChart(): void {
    const canvas = canvasRef.value;

    if (!expanded.value || !canvas || !tides.value || !timeline.value.length) {
        destroyChart();
        return;
    }

    const { start, end } = view.value;
    const curve = timeline.value.filter((p) => p.t >= start && p.t <= end);
    const marks = extremes.value.filter((e) => e.t >= start && e.t <= end);

    const textColor = getComputedStyle(canvas).color || '#6b7990';
    const gridColor = 'rgba(128, 128, 128, 0.2)';
    const lineColor = '#3b82f6';

    const data: ChartData<'line'> = {
        datasets: [{
            label: 'Tide',
            data: curve.map((p) => ({ x: p.t, y: p.y })),
            borderColor: lineColor,
            backgroundColor: 'rgba(59, 130, 246, 0.2)',
            fill: 'start',
            pointRadius: 0,
            pointHoverRadius: 4,
            borderWidth: 2,
            tension: 0.3,
        }, {
            label: 'High and low',
            data: marks.map((e) => ({ x: e.t, y: e.y })),
            showLine: false,
            borderColor: lineColor,
            backgroundColor: lineColor,
            pointRadius: 4,
            pointHoverRadius: 5,
        }]
    };

    // Draws the "now" line and labels each high and low with its time and height.
    // Chart.js has no built in data labels, and a plugin for two small drawings
    // is not worth a dependency.
    const decorations: Plugin<'line'> = {
        id: 'tideDecorations',
        afterDatasetsDraw(c) {
            const { ctx, chartArea, scales } = c;
            const x = scales.x;
            const y = scales.y;

            ctx.save();
            ctx.font = '11px sans-serif';
            ctx.fillStyle = textColor;
            ctx.textBaseline = 'middle';

            if (now.value >= start && now.value <= end) {
                const px = x.getPixelForValue(now.value);
                ctx.strokeStyle = '#ef4444';
                ctx.setLineDash([4, 3]);
                ctx.beginPath();
                ctx.moveTo(px, chartArea.top);
                ctx.lineTo(px, chartArea.bottom);
                ctx.stroke();
                ctx.setLineDash([]);
                ctx.fillStyle = '#ef4444';
                ctx.textAlign = 'center';
                ctx.fillText('Now', Math.min(Math.max(px, chartArea.left + 12), chartArea.right - 12), chartArea.top - 16);
                ctx.fillStyle = textColor;
            }

            for (const e of marks) {
                const px = x.getPixelForValue(e.t);
                const py = y.getPixelForValue(e.y);
                const above = e.type === 'high';

                ctx.textAlign = px < chartArea.left + 24 ? 'left' : px > chartArea.right - 24 ? 'right' : 'center';
                ctx.fillText(formatClock(e.t), px, py + (above ? -22 : 14));
                ctx.fillText(formatHeight(e.y), px, py + (above ? -10 : 26));
            }

            ctx.restore();
        }
    };

    // Space ticks about 56px apart, using the smallest whole-hour step that fits
    const spanHours = (end - start) / HOUR;
    const maxTicks = Math.max(2, Math.floor(((canvas.parentElement?.clientWidth || 300) - 60) / 56));
    const tickStep = [1, 2, 3, 6, 12, 24].find((step) => spanHours / step <= maxTicks) || 24;

    const options: ChartOptions<'line'> = {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        normalized: true,
        parsing: false,
        layout: {
            padding: { top: 30, bottom: 8 }
        },
        interaction: {
            intersect: false,
            mode: 'nearest',
            axis: 'x'
        },
        plugins: {
            legend: { display: false },
            tooltip: {
                filter: (item: TooltipItem<'line'>) => item.datasetIndex === 0,
                callbacks: {
                    title(items: TooltipItem<'line'>[]) {
                        if (!items.length) return '';
                        return formatWhen(Number(items[0].parsed.x));
                    },
                    label(item: TooltipItem<'line'>) {
                        return formatHeight(Number(item.parsed.y));
                    }
                }
            }
        },
        scales: {
            x: {
                type: 'linear',
                min: start,
                max: end,
                grid: { color: gridColor },
                ticks: {
                    color: textColor,
                    maxRotation: 0,
                    callback(value) {
                        const t = Number(value);
                        const label = formatClock(t);
                        return label === '00:00' ? weekdayFormatter.value.format(new Date(t)) : label;
                    }
                },
                afterBuildTicks(scale) {
                    scale.ticks = clockTicks(start, end, tickStep).map((value) => ({ value }));
                }
            },
            y: {
                // Room for the low tide labels, which are drawn below their points
                grace: '25%',
                grid: { color: gridColor },
                title: {
                    display: true,
                    text: `Height (${unitLabel.value})`,
                    color: textColor
                },
                ticks: {
                    color: textColor,
                    callback(value) {
                        return Number(value).toFixed(tides.value?.units === 'feet' ? 0 : 1);
                    }
                }
            }
        }
    };

    destroyChart();
    chart = new Chart(canvas, {
        type: 'line',
        data,
        options,
        plugins: [decorations]
    });
}
</script>

<style scoped>
.tide-chart-shell {
    position: relative;
    height: 240px;
}
</style>
