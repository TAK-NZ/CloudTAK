import sharp from 'sharp';
import Config from '../../common/config.js';
import { fromProtocol } from './factory-basemap.js';
import { pointToTileFraction } from './tilebelt.js';
import { Basemap_Type, BasemapTerrain_Encoding } from '../../common/enums.js';

/**
 * Decode a raster-dem pixel's RGB triplet into an elevation in meters.
 *
 * Supports the two encodings CloudTAK basemaps can be configured with
 * (BasemapTerrain_Encoding). Formulas match the standard Mapbox Terrain-RGB
 * and Terrarium encodings (the same ones MapLibre GL JS decodes internally
 * for `raster-dem` sources) - see:
 *   https://docs.mapbox.com/data/tilesets/reference/mapbox-terrain-rgb-v1/
 *   https://github.com/tilezen/joerd/blob/master/docs/formats.md#terrarium
 */
function decodeElevation(
    encoding: BasemapTerrain_Encoding,
    r: number,
    g: number,
    b: number,
): number {
    if (encoding === BasemapTerrain_Encoding.TERRARIUM) {
        return (r * 256 + g + b / 256) - 32768;
    }

    // Mapbox Terrain-RGB
    return -10000 + (r * 256 * 256 + g * 256 + b) * 0.1;
}

/**
 * Look up the real-world elevation (in meters) at a given lng/lat by
 * fetching and decoding the single raster-dem tile pixel that covers it.
 *
 * This deliberately avoids MapLibre GL JS's queryTerrainElevation(), which
 * only returns a value once 3D terrain rendering has been enabled via
 * map.setTerrain() - a GPU-heavy mode that isn't otherwise needed for a
 * one-off elevation lookup, and can be unreliable/crash-prone on constrained
 * hardware. This reads the same underlying tile data server-side instead.
 *
 * Returns null if no terrain basemap is configured, the point falls outside
 * its bounds, or the tile can't be fetched/decoded.
 */
export async function getElevation(
    config: Config,
    longitude: number,
    latitude: number,
): Promise<number | null> {
    try {
        const terrainSetting = await config.models.Setting.typed('map::terrain', null);
        const terrainId = terrainSetting.value;
        if (!terrainId) return null;

        const basemap = await config.models.Basemap.from(Number(terrainId));
        if (basemap.type !== Basemap_Type.TERRAIN) return null;

        const zoom = Math.min(basemap.maxzoom ?? 15, 15);
        const [xFrac, yFrac] = pointToTileFraction(longitude, latitude, zoom);
        const x = Math.floor(xFrac);
        const y = Math.floor(yFrac);

        const protocol = fromProtocol(basemap.protocol, basemap);
        const tile = await protocol.tileBuffer(zoom, x, y);

        const tilesize = basemap.tilesize || 256;
        const image = sharp(tile);
        const { data, info } = await image
            .raw()
            .toBuffer({ resolveWithObject: true });

        // Pixel coordinate within the tile that the query point falls on.
        // xFrac/yFrac are fractional tile coordinates (0-1 within the tile,
        // plus the integer tile index) - the fractional part maps directly
        // to a pixel offset once scaled by the tile's pixel dimensions.
        const px = Math.min(
            info.width - 1,
            Math.floor((xFrac - x) * (info.width || tilesize)),
        );
        const py = Math.min(
            info.height - 1,
            Math.floor((yFrac - y) * (info.height || tilesize)),
        );

        const idx = (py * info.width + px) * info.channels;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];

        const encoding = (basemap.encoding as BasemapTerrain_Encoding) || BasemapTerrain_Encoding.MAPBOX;
        return decodeElevation(encoding, r, g, b);
    } catch (err) {
        console.warn('Elevation lookup failed:', err instanceof Error ? err.message : String(err));
        return null;
    }
}
