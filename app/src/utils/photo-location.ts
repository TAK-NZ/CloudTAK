import { gps } from 'exifr';

export type PhotoLocation = {
    lng: number;
    lat: number;
};

/** File types that can carry EXIF GPS data and that exifr can read */
const EXIF_NAME = /\.(jpe?g|heic|heif)$/i;
const EXIF_MIME = /^image\/(jpeg|heic|heif)$/i;

/** A photo is fetched in chunks, but cap the number in flight so a large gallery does not flood the API */
const MAX_CONCURRENT = 3;

/** Photo content is addressed by its hash so the same hash always has the same location */
const cache = new Map<string, PhotoLocation | null>();
const inflight = new Map<string, Promise<PhotoLocation | null>>();

const waiting: Array<() => void> = [];
let active = 0;

async function slot(): Promise<void> {
    if (active >= MAX_CONCURRENT) {
        await new Promise<void>((resolve) => waiting.push(resolve));
    }

    active++;
}

function release(): void {
    active--;
    waiting.shift()?.();
}

/**
 * Whether the file could contain EXIF location data
 */
export function mayHavePhotoLocation(name: string, mimeType?: string): boolean {
    return EXIF_NAME.test(name) || (!!mimeType && EXIF_MIME.test(mimeType));
}

/**
 * The location a photo was taken at according to its EXIF data, if it has one
 *
 * Only the start of the file is read where the server allows it. A failed read
 * is not cached so it is retried later; a photo without a location is.
 *
 * @param hash - The content hash, used as the cache key
 * @param url - URL the photo can be fetched from
 */
export async function photoLocation(hash: string, url: string): Promise<PhotoLocation | null> {
    if (cache.has(hash)) return cache.get(hash) ?? null;

    const running = inflight.get(hash);
    if (running) return running;

    const read = (async (): Promise<PhotoLocation | null> => {
        await slot();

        try {
            const result = await gps(url);

            const lat = Number(result?.latitude);
            const lng = Number(result?.longitude);

            const found = result
                && Number.isFinite(lat) && Number.isFinite(lng)
                && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
                // Cameras without a GPS fix often write 0,0
                && !(lat === 0 && lng === 0);

            const location = found ? { lng, lat } : null;

            cache.set(hash, location);

            return location;
        } catch (err) {
            console.debug(`Could not read the location of photo ${hash}`, err);

            return null;
        } finally {
            release();
            inflight.delete(hash);
        }
    })();

    inflight.set(hash, read);

    return read;
}
