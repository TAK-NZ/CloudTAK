import { Marker } from 'maplibre-gl';
import type { Map as MapLibreMap } from 'maplibre-gl';

const SIZE = 64;
const COLOR = '#d63939';

/** Events that count as interacting with CloudTAK. A programmatic map move fires none of them */
const INTERACTION_EVENTS = ['pointerdown', 'wheel', 'keydown'] as const;

let active: Marker | undefined;

/**
 * A ring with four ticks. Each shape is drawn twice, a wide white one under a colored one,
 * so it shows on both light and dark basemaps
 */
function crosshairSVG(animate: boolean): string {
    const shapes = (stroke: string, width: number) => `
        <circle cx="32" cy="32" r="14" fill="none" stroke="${stroke}" stroke-width="${width}">
            ${animate ? '<animate attributeName="r" values="14;19;14" dur="1.5s" repeatCount="indefinite"/>' : ''}
        </circle>
        <path d="M32 4V24M32 40V60M4 32H24M40 32H60" fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round"/>
        <circle cx="32" cy="32" r="1.5" fill="${stroke}" stroke="none"/>
    `;

    return `
        <svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
            ${shapes('#ffffff', 6)}
            ${shapes(COLOR, 2.5)}
        </svg>
    `;
}

/**
 * Take the crosshair off the map, if there is one
 */
export function hideCrosshair(): void {
    for (const event of INTERACTION_EVENTS) {
        document.removeEventListener(event, hideCrosshair, true);
    }

    active?.remove();
    active = undefined;
}

/**
 * Mark a location with a temporary crosshair, for example after zooming to it
 *
 * It goes away on the next interaction anywhere in the page - a click or tap, a scroll or pinch
 * on the map, or a key press. Only one crosshair exists at a time
 *
 * @param map - The map to draw on
 * @param lngLat - The location to mark
 */
export function showCrosshair(map: MapLibreMap, lngLat: [number, number]): void {
    hideCrosshair();

    const reduceMotion = typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const element = document.createElement('div');
    element.className = 'cloudtak-crosshair';
    element.style.width = `${SIZE}px`;
    element.style.height = `${SIZE}px`;
    // Never get in the way of the interaction that removes it
    element.style.pointerEvents = 'none';
    element.innerHTML = crosshairSVG(!reduceMotion);

    active = new Marker({ element, anchor: 'center' })
        .setLngLat(lngLat)
        .addTo(map);

    // Listen from the next event on, so the click that got us here cannot remove it
    for (const event of INTERACTION_EVENTS) {
        document.addEventListener(event, hideCrosshair, { capture: true, passive: true });
    }
}
