/**
 * Pure helpers that turn a device orientation (W3C Euler angles or a
 * device->earth quaternion) into a compass heading.
 *
 * `360 - alpha` is only right when the phone is flat or the screen is upright
 * with no roll, and it ignores the screen rotation. These helpers work on the
 * device axes instead, so they stay well conditioned for every hand-held pose.
 */

export type Vec3 = [number, number, number];
/** Device axes expressed in the earth frame (x = East, y = North, z = Up). */
export interface DeviceAxes { x: Vec3; y: Vec3; z: Vec3 }

const RAD = Math.PI / 180;

/** W3C Z-X'-Y'' Euler angles (degrees) -> device axes (columns of the spec rotation matrix). */
export function axesFromEuler(alpha: number, beta: number, gamma: number): DeviceAxes {
    const a = alpha * RAD;
    const b = beta * RAD;
    const g = gamma * RAD;
    const cZ = Math.cos(a);
    const sZ = Math.sin(a);
    const cX = Math.cos(b);
    const sX = Math.sin(b);
    const cY = Math.cos(g);
    const sY = Math.sin(g);

    return {
        x: [cZ * cY - sZ * sX * sY, cY * sZ + cZ * sX * sY, -cX * sY],
        y: [-cX * sZ, cZ * cX, sX],
        z: [cZ * sY + cY * sZ * sX, sZ * sY - cZ * cY * sX, cX * cY]
    };
}

/** `[x, y, z, w]` device->earth quaternion (AbsoluteOrientationSensor) -> device axes. */
export function axesFromQuaternion([x, y, z, w]: [number, number, number, number]): DeviceAxes {
    return {
        x: [1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w)],
        y: [2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w)],
        z: [2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y)]
    };
}

function smoothstep(lo: number, hi: number, v: number): number {
    const t = Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
    return t * t * (3 - 2 * t);
}

function unitHoriz(v: Vec3): [number, number] | null {
    const m = Math.hypot(v[0], v[1]);
    return m < 0.1 ? null : [v[0] / m, v[1] / m];
}

/**
 * Heading (degrees clockwise from the sensor's north) the user is pointing the device.
 *
 * - Screen roughly horizontal: direction of the top of the screen (uses `screenAngle`).
 * - Screen roughly vertical: direction of the back camera (-z); `screenAngle` is irrelevant.
 * - In between the two directions are blended by the vertical component of the screen normal.
 *
 * Returns `null` for degenerate poses (e.g. pointing straight at the sky or ground).
 */
export function headingFromAxes(ax: DeviceAxes, screenAngle = 0): number | null {
    const quarter = ((Math.round(screenAngle / 90) % 4) + 4) % 4;
    // Screen "up" in device coordinates: 0 -> +y, 90 -> +x, 180 -> -y, 270 -> -x
    const top: Vec3 = quarter === 0 ? ax.y
        : quarter === 1 ? ax.x
            : quarter === 2 ? [-ax.y[0], -ax.y[1], -ax.y[2]]
                : [-ax.x[0], -ax.x[1], -ax.x[2]];

    const t = unitHoriz(top);
    const c = unitHoriz([-ax.z[0], -ax.z[1], -ax.z[2]]);
    const s = smoothstep(0.3, 0.7, ax.z[2]); // cos(tilt from flat)

    const east = (t ? s * t[0] : 0) + (c ? (1 - s) * c[0] : 0);
    const north = (t ? s * t[1] : 0) + (c ? (1 - s) * c[1] : 0);
    if (Math.hypot(east, north) < 0.05) return null;

    return (((Math.atan2(east, north) / RAD) % 360) + 360) % 360;
}

export function headingFromEuler(
    alpha: number | null | undefined,
    beta: number | null | undefined,
    gamma: number | null | undefined,
    screenAngle = 0
): number | null {
    if (typeof alpha !== 'number' || !Number.isFinite(alpha)) return null;
    return headingFromAxes(
        axesFromEuler(alpha, Number.isFinite(beta) ? beta as number : 0, Number.isFinite(gamma) ? gamma as number : 0),
        screenAngle
    );
}
