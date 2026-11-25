import test from 'node:test';
import assert from 'node:assert';
import { BasemapProtocol } from '../stateless/lib/interface-basemap.js';

// Hillshade layers point at the shared `__terrain__` raster-dem source, not at the
// overlay's own source, so validation must not type that source after the overlay.
test('BasemapProtocol.isValidStyle - hillshade on __terrain__ in a vector overlay', () => {
    assert.doesNotThrow(() => BasemapProtocol.isValidStyle('vector', [
        { id: '1-bg', type: 'background', paint: { 'background-color': '#fff' } },
        { id: '1-land', type: 'fill', source: '1', 'source-layer': 'land' },
        { id: '1-hillshade', type: 'hillshade', source: '__terrain__' },
    ]));
});

test('BasemapProtocol.isValidStyle - hillshade on a named source', () => {
    assert.doesNotThrow(() => BasemapProtocol.isValidStyle('raster', [
        { id: 'hs', type: 'hillshade', source: 'dem' },
    ]));
});

test('BasemapProtocol.isValidStyle - still rejects a mismatched layer type', () => {
    assert.throws(() => BasemapProtocol.isValidStyle('raster', [
        { id: 'fill', type: 'fill', source: '1', 'source-layer': 'land' },
    ]));
});

test('BasemapProtocol.json - omits vector_layers when unknown', () => {
    const json = BasemapProtocol.json({ name: 'x', url: 'https://example.com/{z}/{x}/{y}', type: 'vector' } as never);
    assert.equal(json.vector_layers, undefined);
});
