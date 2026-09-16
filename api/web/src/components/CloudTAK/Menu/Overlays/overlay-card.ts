import type Overlay from '../../../../base/overlay-class.ts';

export type OverlayBadge = { label: string; variant: string };
export type OverlayStatus = { label: string; variant: string; tooltip?: string };
export type OverlayCard = {
    overlay: Overlay;
    visible: boolean;
    status: OverlayStatus;
    badges: OverlayBadge[];
    offline: boolean;
};

/** Whether an overlay has an expandable details panel. Mission overlays are managed from MenuMission and are not expandable here. */
export function hasOverlayDetails(overlay: Overlay): boolean {
    return overlay.type === 'raster'
        || overlay.type === 'vector';
}
