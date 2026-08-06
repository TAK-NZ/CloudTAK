import Config from './config.js';
import sharp from 'sharp';

export const LOGO_SIZES = [192, 512];

export async function buildLogos(config: Config): Promise<Map<number, Buffer>> {
    const logos = new Map<number, Buffer>();

    // Setting.typed() falls back to FullConfigDefaults['login::logo'] (the
    // build-time CloudTAKLogo.svg, which branding overwrites) when no admin
    // override is stored in the DB. Using the raw Setting.from() here
    // instead - as this previously did - meant a fresh deployment with no
    // DB row got an empty icon set in the PWA manifest, since from() throws
    // rather than applying the default.
    const { value: logoData } = await config.models.Setting.typed('login::logo');

    if (!logoData) return logos;

    // Strip data URL prefix and decode base64
    const base64Match = logoData.match(/^data:[^;]+;base64,(.+)$/);
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
