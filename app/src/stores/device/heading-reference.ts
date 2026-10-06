/**
 * Client-side preference for the north reference used by the web compass.
 *
 * Stored in localStorage (per device) so it needs no API or database change.
 * Only the web compass is affected: iOS `webkitCompassHeading` is already true
 * north and the native plugin path is left as the plugin reports it.
 */

export type HeadingReference = 'true' | 'magnetic';

export const HEADING_REFERENCE_KEY = 'cloudtak-heading-reference';

export const HEADING_REFERENCE_LABELS: Record<HeadingReference, string> = {
    true: 'True North',
    magnetic: 'Magnetic North'
};

export function headingReferenceFromLabel(label: string | undefined | null): HeadingReference {
    return label === HEADING_REFERENCE_LABELS.magnetic ? 'magnetic' : 'true';
}

// The compass reads this for every sensor event, so avoid hitting storage each time
let cached: HeadingReference | undefined;

export function getHeadingReference(): HeadingReference {
    if (cached) return cached;

    try {
        cached = localStorage.getItem(HEADING_REFERENCE_KEY) === 'magnetic' ? 'magnetic' : 'true';
    } catch {
        cached = 'true';
    }

    return cached;
}

export function setHeadingReference(reference: HeadingReference): void {
    cached = reference;

    try {
        localStorage.setItem(HEADING_REFERENCE_KEY, reference);
    } catch {
        // Storage unavailable (private mode / quota): the preference just does not persist
    }
}
