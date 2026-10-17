/**
 * Byte sequences for weather relay tests. Built in code so no binary fixtures
 * are committed. The relay only checks magic bytes, so these are not decodable images.
 */

/**
 * Minimal WebP container: `RIFF` + size + `WEBP` + one chunk with `payloadBytes` bytes
 */
export function webp(chunk: 'VP8L' | 'VP8 ' | 'VP8X' = 'VP8L', payloadBytes = 6): Buffer {
    const payload = Buffer.alloc(payloadBytes, 0x01);
    if (chunk === 'VP8L' && payloadBytes > 0) payload[0] = 0x2f;

    const pad = payloadBytes % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0);

    const chunkHeader = Buffer.alloc(8);
    chunkHeader.write(chunk, 0, 'latin1');
    chunkHeader.writeUInt32LE(payloadBytes, 4);

    const riff = Buffer.alloc(12);
    riff.write('RIFF', 0, 'latin1');
    riff.writeUInt32LE(4 + chunkHeader.byteLength + payload.byteLength + pad.byteLength, 4);
    riff.write('WEBP', 8, 'latin1');

    return Buffer.concat([riff, chunkHeader, payload, pad]);
}

/**
 * RIFF container of another type, for example `WAVE`
 */
export function riff(form: string, rest: Buffer = Buffer.from('fmt \x04\x00\x00\x00\x00\x00\x00\x00', 'latin1')): Buffer {
    const head = Buffer.alloc(12);
    head.write('RIFF', 0, 'latin1');
    head.writeUInt32LE(4 + rest.byteLength, 4);
    head.write(form, 8, 'latin1');
    return Buffer.concat([head, rest]);
}
