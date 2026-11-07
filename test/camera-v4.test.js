import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLayoutV4 } from '../src/picture/layout.js';
import { renderFrame } from '../src/picture/render.js';
import { schemeFromLevels } from '../src/core/scheme.js';
import { frameShapeV4, buildFrameV4 } from '../src/core/framev4.js';
import { tiltQuad, warpToQuad, blur, brightnessContrast, noise } from '../src/testutil/distort.js';
import { decodeCameraFrame } from '../src/picture/reader.js';

const COLS = 137, ROWS = 77, BLOCK_PX = 13, W = 1920, H = 1080;

function seeded(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s >>> 24; };
}

function make(scheme, txId) {
  const layout = computeLayoutV4(COLS, ROWS);
  const shape = frameShapeV4(layout, scheme, 32);
  const next = seeded(txId);
  const packets = Array.from({ length: shape.packets }, (_, i) => ({
    symbolId: 5 + i,
    data: Uint8Array.from({ length: shape.packetBytes }, next),
  }));
  const frameBytes = buildFrameV4({
    blockSize: BLOCK_PX, scheme, parity: 32, txId, sourceCount: 100, streamLength: 20000, packets,
  }, shape);
  const screen = renderFrame({ frameBytes, index: 0, scheme, blockSize: BLOCK_PX, layout, version: 4 });
  return { packets, screen };
}

// Paints the given data cells of a screen image with seeded noise colors.
function scribble(screen, cells, seed) {
  const next = seeded(seed);
  for (const cell of cells) {
    const x0 = (cell % COLS) * BLOCK_PX, y0 = Math.floor(cell / COLS) * BLOCK_PX;
    const rgb = [next(), next(), next()];
    for (let y = y0; y < y0 + BLOCK_PX; y++) {
      for (let x = x0; x < x0 + BLOCK_PX; x++) {
        const p = (y * screen.width + x) * 4;
        screen.data[p] = rgb[0]; screen.data[p + 1] = rgb[1]; screen.data[p + 2] = rgb[2];
      }
    }
  }
}

const warp = (screen) => warpToQuad(screen, tiltQuad(screen.width, screen.height, W, H, 3, 0.88), W, H);
const degrade = (img) => noise(brightnessContrast(blur(img, 1), 0.2, 0.9), 3, 5);

function assertAllPackets(out, packets) {
  assert.ok(out.frame, out.read.reason);
  assert.equal(out.read.version, 4);
  assert.equal(out.read.layoutVersion, 4);
  assert.equal(out.read.frameHeader.version, 4);
  assert.equal(out.frame.packets.length, packets.length);
  out.frame.packets.forEach((p, i) => {
    assert.ok(p, `packet ${i}`);
    assert.equal(p.symbolId, packets[i].symbolId);
    assert.deepEqual(p.data, packets[i].data);
  });
}

for (const [name, scheme] of [['cube', schemeFromLevels(2)], ['gray 2', { kind: 'gray', levels: 2 }]]) {
  test(`a version 4 ${name} frame reads through the camera with every packet`, () => {
    const { packets, screen } = make(scheme, 0x1234abcd);
    assertAllPackets(decodeCameraFrame(degrade(warp(screen))), packets);
  });
}

test('a torn bottom still gives the header and most packets', () => {
  const scheme = schemeFromLevels(2);
  const a = make(scheme, 0x1234abcd);
  const b = make(scheme, 0x0badf00d);
  const imgA = warp(a.screen);
  const imgB = warp(b.screen);
  const from = Math.floor(H * 0.8) * W * 4;
  imgA.data.set(imgB.data.subarray(from), from);
  const out = decodeCameraFrame(degrade(imgA));
  assert.ok(out.frame, out.read.reason);
  assert.equal(out.frame.header.txId, 0x1234abcd);
  const good = out.frame.packets.filter(Boolean).length;
  assert.ok(good >= 0.7 * a.packets.length, `${good} of ${a.packets.length} packets`);
});

test('a torn frame with most packets good is read once, not twice', () => {
  const scheme = schemeFromLevels(2);
  const a = make(scheme, 0x1234abcd);
  const b = make(scheme, 0x0badf00d);
  const imgA = warp(a.screen);
  const imgB = warp(b.screen);
  const from = Math.floor(H * 0.8) * W * 4;
  imgA.data.set(imgB.data.subarray(from), from);
  const out = decodeCameraFrame(degrade(imgA));
  assert.ok(out.frame, out.read.reason);
  assert.ok(out.frame.packets.includes(null), 'the tear should cost some packets');
  assert.equal(out.read.rereads, 0);
});


test('with header copy A destroyed, copy B (the last data cells) still gives the header', () => {
  const { packets, screen } = make(schemeFromLevels(2), 0x1234abcd);
  const layout = computeLayoutV4(COLS, ROWS);
  scribble(screen, Array.from(layout.dataCells).filter((c) => Math.floor(c / COLS) <= 5), 77);
  const out = decodeCameraFrame(degrade(warp(screen)));
  assert.ok(out.frame, out.read.reason);
  assert.equal(out.frame.header.txId, 0x1234abcd);
  const good = out.frame.packets.filter(Boolean).length;
  assert.ok(good >= 0.7 * packets.length, `${good} of ${packets.length} packets`);
});

test('a frame with no header is read again on the fallback geometry when there is one', () => {
  const { screen } = make(schemeFromLevels(2), 0x1234abcd);
  const layout = computeLayoutV4(COLS, ROWS);
  const cells = Array.from(layout.dataCells);
  scribble(screen, [...cells.slice(0, 128), ...cells.slice(-128)], 78);
  const out = decodeCameraFrame(degrade(warp(screen)));
  assert.equal(out.frame, null);
  assert.equal(out.read.rereads, 1);
});

test('a hard tear gives packets from both frames', () => {
  const scheme = schemeFromLevels(2);
  const layout = computeLayoutV4(COLS, ROWS);
  const shape = frameShapeV4(layout, scheme, 32);
  const n = shape.packets;
  const frameAt = (index) => {
    const next = seeded(0x5eed + index);
    const packets = Array.from({ length: n }, (_, k) => ({
      symbolId: index * n + k,
      data: Uint8Array.from({ length: shape.packetBytes }, next),
    }));
    const frameBytes = buildFrameV4({
      blockSize: BLOCK_PX, scheme, parity: 32, txId: 0x1234abcd, sourceCount: 100, streamLength: 20000, packets,
    }, shape);
    return warp(renderFrame({ frameBytes, index, scheme, blockSize: BLOCK_PX, layout, version: 4 }));
  };
  const top = frameAt(0);
  const bottom = frameAt(1);
  const from = Math.floor(H / 2) * W * 4;
  top.data.set(bottom.data.subarray(from), from);
  const out = decodeCameraFrame(degrade(top));
  assert.ok(out.frame, out.read.reason);
  const frames = new Set(out.frame.packets.filter(Boolean).map((p) => Math.floor(p.symbolId / n)));
  assert.deepEqual([...frames].sort(), [0, 1]);
});
