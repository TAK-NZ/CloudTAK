import Config from '../../common/config.js';
import sharp from 'sharp';
import { FullConfigDefaults } from './defaults.js';

export const LOGO_SIZES = [192, 512];

export async function buildLogos(config: Config): Promise<Map<number, Buffer>> {
    const logos = new Map<number, Buffer>();

    // Setting.typed() falls back to FullConfigDefaults['login::logo'] (the
    // build-time CloudTAKLogo.svg, which branding overwrites) when no admin
    // override is stored in the DB. Using the raw Setting.from() here
    // instead - as this previously did - meant a fresh deployment with no
    // DB row got an empty icon set in the PWA manifest, since from() throws
    // rather than applying the default.
    //
    // typed() only substitutes the default when the row is entirely
    // absent. A DB row that exists but holds an empty string (e.g. an
    // admin cleared a previously-set custom logo via the Admin UI) is
    // returned as-is, so `logoData` can still be '' here. Treat that the
    // same as "unset" and fall back to the default logo, rather than
    // shipping an empty icon set that blocks the PWA install prompt.
    const { value: logoData } = await config.models.Setting.typed('login::logo');
    const effectiveLogoData = logoData || FullConfigDefaults['login::logo'];

    if (!effectiveLogoData) return logos;

    // Strip data URL prefix and decode base64
    const base64Match = effectiveLogoData.match(/^data:[^;]+;base64,(.+)$/);
    if (!base64Match) return logos;

    const inputBuffer = Buffer.from(base64Match[1], 'base64');

    await Promise.all(LOGO_SIZES.map(async (size) => {
        const resized = await sharp(inputBuffer)
            .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
            .png()
            .toBuffer();
        logos.set(size, resized);
    }));

    return logos;
}
