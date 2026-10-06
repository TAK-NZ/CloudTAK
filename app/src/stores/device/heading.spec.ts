import { describe, expect, it } from 'vitest';
import { axesFromQuaternion, headingFromAxes, headingFromEuler } from './heading.ts';

const TOLERANCE = 1;

/** Smallest absolute difference between two headings, in degrees. */
function diff(a: number, b: number): number {
    return Math.abs((((a - b) % 360) + 540) % 360 - 180);
}

type Row = {
    name: string;
    euler: [number | null, number, number];
    screen?: number;
    truth: number | null;
};

// Flat phone, top edge pointing at heading H: alpha = 360 - H
const flat = (h: number): [number, number, number] => [(360 - h) % 360, 0, 0];
// Upright phone (screen vertical), back camera pointing at heading H: alpha = 360 - H
const upright = (h: number): [number, number, number] => [(360 - h) % 360, 90, 0];

const rows: Row[] = [
    ...[0, 90, 180, 270].map((h): Row => ({ name: `flat ${h}`, euler: flat(h), truth: h })),
    ...[0, 90, 180, 270].map((h): Row => ({ name: `upright ${h}`, euler: upright(h), truth: h })),
    // Reading pose: top edge raised (pitch) with the phone rolled left/right
    { name: 'reading pitch 20 roll +20', euler: [260, 20, 20], truth: 100 },
    { name: 'reading pitch 20 roll -20', euler: [260, 20, -20], truth: 100 },
    { name: 'reading pitch 45 roll +20', euler: [260, 45, 20], truth: 100 },
    { name: 'reading pitch 45 roll -20', euler: [260, 45, -20], truth: 100 },
    // Negative gamma while flat
    { name: 'flat negative gamma', euler: [260, 0, -10], truth: 100 },
    // Values Chrome reports for an upright phone at camera level pointing at 100, rolled 5/15/30
    { name: 'upright camera level roll 5', euler: [350, 85, -90], truth: 100 },
    { name: 'upright camera level roll 15', euler: [350, 75, -90], truth: 100 },
    { name: 'upright camera level roll 30', euler: [350, 60, -90], truth: 100 },
    // Camera elevated / lowered, with roll (Chrome Euler values, rounded to whole degrees)
    { name: 'elevation +10 roll 15', euler: [203, 108, 56], truth: 100 },
    { name: 'elevation -10 roll 10', euler: [305, 76, -45], truth: 100 },
    { name: 'elevation +30 roll 15', euler: [232, 123, 24], truth: 100 },
    { name: 'elevation +1 roll 2', euler: [197, 92, 63], truth: 100 },
    { name: 'elevation -1 roll 2', euler: [323, 88, -63], truth: 100 },
    // Landscape, flat phone, user faces 100: screen top is device +x (90) or -x (270)
    { name: 'landscape 90 flat', euler: [350, 0, 0], screen: 90, truth: 100 },
    { name: 'landscape 270 flat', euler: [170, 0, 0], screen: 270, truth: 100 },
    { name: 'landscape 180 flat', euler: [80, 0, 0], screen: 180, truth: 100 },
    // Landscape with the phone upright does not depend on the screen angle
    { name: 'landscape 90 upright', euler: upright(100), screen: 90, truth: 100 },
    // Degenerate poses
    { name: 'alpha null', euler: [null, 0, 0], truth: null },
    { name: 'screen facing down (camera at the sky)', euler: [260, 180, 0], truth: null }
];

describe('headingFromEuler', () => {
    for (const row of rows) {
        it(row.name, () => {
            const heading = headingFromEuler(row.euler[0], row.euler[1], row.euler[2], row.screen ?? 0);
            if (row.truth === null) {
                expect(heading).toBeNull();
            } else {
                expect(heading).not.toBeNull();
                expect(diff(heading as number, row.truth)).toBeLessThanOrEqual(TOLERANCE);
            }
        });
    }

    it('treats missing beta and gamma as zero', () => {
        expect(diff(headingFromEuler(260, null, undefined) as number, 100)).toBeLessThanOrEqual(TOLERANCE);
    });

    it('returns null for non-finite alpha', () => {
        expect(headingFromEuler(Number.NaN, 0, 0)).toBeNull();
    });

    it('always returns a value in [0, 360)', () => {
        for (let alpha = 0; alpha < 360; alpha += 15) {
            const heading = headingFromEuler(alpha, 10, 5) as number;
            expect(heading).toBeGreaterThanOrEqual(0);
            expect(heading).toBeLessThan(360);
        }
    });
});

type Quat = [number, number, number, number];

function qmul(a: Quat, b: Quat): Quat {
    const [ax, ay, az, aw] = a;
    const [bx, by, bz, bw] = b;
    return [
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz
    ];
}

/** Rotation about the earth Up axis so that the device top points at `heading` when flat. */
function yaw(heading: number): Quat {
    const half = (-heading * Math.PI) / 360;
    return [0, 0, Math.sin(half), Math.cos(half)];
}

/** Device rotation about its own x axis (pitch), positive raises the top edge. */
function pitch(degrees: number): Quat {
    const half = (degrees * Math.PI) / 360;
    return [Math.sin(half), 0, 0, Math.cos(half)];
}

describe('headingFromAxes with quaternions', () => {
    it('flat phone for N/E/S/W', () => {
        for (const h of [0, 90, 180, 270]) {
            const heading = headingFromAxes(axesFromQuaternion(yaw(h)));
            expect(diff(heading as number, h)).toBeLessThanOrEqual(TOLERANCE);
        }
    });

    it('upright phone for N/E/S/W', () => {
        for (const h of [0, 90, 180, 270]) {
            const heading = headingFromAxes(axesFromQuaternion(qmul(yaw(h), pitch(90))));
            expect(diff(heading as number, h)).toBeLessThanOrEqual(TOLERANCE);
        }
    });

    it('reading pose (pitch 20 and 45)', () => {
        for (const p of [20, 45]) {
            const heading = headingFromAxes(axesFromQuaternion(qmul(yaw(100), pitch(p))));
            expect(diff(heading as number, 100)).toBeLessThanOrEqual(TOLERANCE);
        }
    });

    it('landscape screen angle with a flat phone', () => {
        // Device x axis (screen top at angle 90) points at 100 => device top points at 10
        expect(diff(headingFromAxes(axesFromQuaternion(yaw(10)), 90) as number, 100)).toBeLessThanOrEqual(TOLERANCE);
        // Device -x axis (screen top at angle 270) points at 100 => device top points at 190
        expect(diff(headingFromAxes(axesFromQuaternion(yaw(190)), 270) as number, 100)).toBeLessThanOrEqual(TOLERANCE);
    });

    it('returns null when the back camera points at the sky', () => {
        expect(headingFromAxes(axesFromQuaternion(qmul(yaw(100), pitch(180))))).toBeNull();
    });
});
