import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';

/**
 * Limits of the SAR engine. The relay enforces the same bounds before it calls
 * the engine, so the engine's own 400 answers never occur in practice.
 */
export const LAT: [number, number] = [-48, -33.5];
export const LNG: [number, number] = [165.5, 179.5];
export const SPEED: [number, number] = [0.1, 10];
export const HOURS: [number, number] = [0.25, 24];
export const MAX_INTERVALS = 8;
export const RADIUS: [number, number] = [1, 30];
export const MAX_BODY_BYTES = 8192;

export const TravelTimeBody = Type.Object({
    ipp: Type.Object({
        lat: Type.Number({ minimum: LAT[0], maximum: LAT[1] }),
        lng: Type.Number({ minimum: LNG[0], maximum: LNG[1] }),
    }, { additionalProperties: false }),
    speed_kmh: Type.Number({ minimum: SPEED[0], maximum: SPEED[1] }),
    intervals_hours: Type.Array(
        Type.Number({ minimum: HOURS[0], maximum: HOURS[1] }),
        { minItems: 1, maxItems: MAX_INTERVALS },
    ),
    radius_km: Type.Optional(Type.Number({ minimum: RADIUS[0], maximum: RADIUS[1] })),
}, { additionalProperties: false });

export type TravelTimeRequest = Static<typeof TravelTimeBody>;

export interface UpstreamBody {
    ipp: { lat: number; lng: number };
    speed_kmh: number;
    intervals_hours: number[];
    radius_km?: number;
}

/**
 * Rebuild the engine request from the parsed values so nothing else is forwarded
 */
export function buildUpstreamBody(body: TravelTimeRequest): UpstreamBody {
    const out: UpstreamBody = {
        ipp: { lat: body.ipp.lat, lng: body.ipp.lng },
        speed_kmh: body.speed_kmh,
        intervals_hours: [...new Set(body.intervals_hours)].sort((a, b) => a - b),
    };

    if (body.radius_km !== undefined) out.radius_km = body.radius_km;
    return out;
}
