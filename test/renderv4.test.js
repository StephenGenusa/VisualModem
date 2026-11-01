import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLayoutV4 } from '../src/picture/layout.js';
import { renderFrame } from '../src/picture/render.js';
import { readImageFrame } from '../src/picture/filereader.js';
import { schemeColors, schemeFromLevels } from '../src/core/scheme.js';
import { frameShapeV4, buildFrameV4 } from '../src/core/framev4.js';

function seeded(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s >>> 24; };
}

function make(cols, rows, blockSize, scheme, index = 0) {
  const layout = computeLayoutV4(cols, rows);
  const shape = frameShapeV4(layout, scheme, 32);
  const next = seeded(11);
  const packets = Array.from({ length: shape.packets }, (_, i) => ({
    symbolId: 5 + i,
    data: Uint8Array.from({ length: shape.packetBytes }, next),
  }));
  const frameBytes = buildFrameV4({
    blockSize, scheme, parity: 32, txId: 0xabcdef01, sourceCount: 100, streamLength: 20000, packets,
  }, shape);
  const img = renderFrame({ frameBytes, index, scheme, blockSize, layout, version: 4 });
  return { layout, packets, img };
}

const pixel = (img, layout, blockSize, col, row) => {
  const o = ((row * blockSize) * img.width + col * blockSize) * 4;
  return [img.data[o], img.data[o + 1], img.data[o + 2]];
};

for (const [name, scheme] of [['cube 2', schemeFromLevels(2)], ['gray 2', { kind: 'gray', levels: 2 }]]) {
  test(`a version 4 frame image reads back exactly (${name})`, () => {
    const { layout, packets, img } = make(137, 77, 2, scheme);
    const out = readImageFrame(img);
    assert.ok(out);
    assert.equal(out.frame.header.version, 4);
    assert.equal(out.blockSize, 2);
    assert.deepEqual(out.scheme, scheme);
    assert.equal(out.layout.dataBlockCount, layout.dataBlockCount);
    assert.equal(out.frame.packets.length, packets.length);
    out.frame.packets.forEach((p, i) => {
      assert.equal(p.symbolId, packets[i].symbolId);
      assert.deepEqual(p.data, packets[i].data);
    });
  });
}

test('the right strip shows the frame index parity', () => {
  const scheme = schemeFromLevels(2);
  for (const [index, top] of [[4, 0], [5, 255]]) {
    const { layout, img } = make(137, 77, 2, scheme, index);
    const col = layout.cols - 1;
    assert.equal(layout.timingRight.rowStart, 8);
    assert.deepEqual(pixel(img, layout, 2, col, 8), [top, top, top]);
    assert.deepEqual(pixel(img, layout, 2, col, 9), [255 - top, 255 - top, 255 - top]);
  }
});

test('alignment patterns and pilots are drawn', () => {
  const scheme = schemeFromLevels(2);
  const { layout, img } = make(213, 120, 1, scheme);
  const a = layout.align[0];
  assert.deepEqual(pixel(img, layout, 1, a.col, a.row), [0, 0, 0]);
  assert.deepEqual(pixel(img, layout, 1, a.col + 1, a.row), [255, 255, 255]);
  assert.deepEqual(pixel(img, layout, 1, a.col + 2, a.row + 2), [0, 0, 0]);
  const p = layout.pilots[0];
  assert.deepEqual(pixel(img, layout, 1, p % layout.cols, Math.floor(p / layout.cols)), [...schemeColors(scheme)[0]]);
});
