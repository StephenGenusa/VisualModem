import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLayout } from '../src/picture/layout.js';
import { renderFrame } from '../src/picture/render.js';
import { homographyFromPoints, applyHomography } from '../src/picture/homography.js';
import { warpToQuad, tiltQuad, blur, bloom, rotate90, noise } from '../src/testutil/distort.js';
import { toGray, binarize, findFinderCandidates, orientFinders } from '../src/picture/finder.js';

const layout = computeLayout(40, 30);
// Bytes that fill every data cell without repeating every 256 bytes: the old i * 7
// fill repeated, and in version 3 it happened to hide the small marker's ring.
const fill = new Uint8Array(1200).map((_, i) => (i * 7 + (i >> 8) * 13) & 255);
const frame = renderFrame({ frameBytes: fill, index: 0, levels: 4, blockSize: 8, layout });
const expect = (p, x, y, tol) => assert.ok(Math.hypot(p[0] - x, p[1] - y) <= tol, `got ${p} want ${x},${y}`);

test('clean render: all four markers at block centers', () => {
  const g = toGray(frame); const b = binarize(g, frame.width, frame.height);
  const o = orientFinders(findFinderCandidates(b, frame.width, frame.height));
  expect(o.tl, 3.5 * 8, 3.5 * 8, 1); expect(o.tr, 36.5 * 8, 3.5 * 8, 1);
  expect(o.bl, 3.5 * 8, 26.5 * 8, 1); expect(o.br, 37.5 * 8, 27.5 * 8, 1);
  assert.ok(Math.abs(o.pitch - 8) < 0.5);
});
test('rotated 90 degrees still orients', () => {
  const r = rotate90(frame);
  const o = orientFinders(findFinderCandidates(binarize(toGray(r), r.width, r.height), r.width, r.height));
  expect(o.tl, r.width - 3.5 * 8, 3.5 * 8, 1);
  expect(o.tr, r.width - 3.5 * 8, 36.5 * 8, 1);
});
test('warped and blurred within 2 pixels', () => {
  const quad = tiltQuad(frame.width, frame.height, 640, 480, 25, 0.8);
  const img = blur(warpToQuad(frame, quad, 640, 480), 1);
  const o = orientFinders(findFinderCandidates(binarize(toGray(img), 640, 480), 640, 480));
  const H = homographyFromPoints([[0, 0], [frame.width, 0], [frame.width, frame.height], [0, frame.height]], quad);
  const want = applyHomography(H, 3.5 * 8, 3.5 * 8);
  expect(o.tl, want[0], want[1], 2);
  assert.ok(o.br, 'br marker found');
});
test('camera bloom: white spreading 2 pixels into black at 9 pixel blocks still finds all markers', () => {
  // Measured on a phone photo of a TV: runs of 13, 22, 12, 4 pixels where
  // 9, 9, 27, 9, 9 were drawn. The center and the outer ring fell outside the
  // plain ratio check.
  const f = renderFrame({ frameBytes: new Uint8Array(500).map((_, i) => i * 7), index: 0, levels: 2, blockSize: 9, layout });
  const img = blur(bloom(f, 2), 1);
  const o = orientFinders(findFinderCandidates(binarize(toGray(img), img.width, img.height), img.width, img.height));
  assert.ok(o, 'markers found');
  expect(o.tl, 3.5 * 9, 3.5 * 9, 2); expect(o.tr, 36.5 * 9, 3.5 * 9, 2);
  expect(o.bl, 3.5 * 9, 26.5 * 9, 2);
  assert.ok(Math.abs(o.pitch - 9) < 1.5, `pitch ${o.pitch}`);
});
test('no markers in noise', () => {
  const data = new Uint8ClampedArray(300 * 300 * 4); let s = 3;
  for (let i = 0; i < data.length; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; data[i] = s >> 16; }
  assert.equal(orientFinders(findFinderCandidates(binarize(toGray({ data, width: 300, height: 300 }), 300, 300), 300, 300)), null);
});
test('a spurious marker in line with the top edge does not take a corner', () => {
  const c = findFinderCandidates(binarize(toGray(frame), frame.width, frame.height), frame.width, frame.height);
  const o = orientFinders([...c, { x: 600, y: 28, pitch: 8, size: 7 }]);
  expect(o.tr, 36.5 * 8, 3.5 * 8, 1);
  assert.ok(o.br, 'br marker found');
});
test('a marker with an inconsistent pitch is not chosen', () => {
  const c = findFinderCandidates(binarize(toGray(frame), frame.width, frame.height), frame.width, frame.height);
  // With pitch ignored, this fake tr and a fake br at its predicted spot would win on span.
  const o = orientFinders([...c, { x: 600, y: 28, pitch: 20, size: 7 }, { x: 612, y: 224, pitch: 8, size: 5 }]);
  expect(o.tr, 36.5 * 8, 3.5 * 8, 1);
});
test('br candidates reach past the nearest guess and are ordered by distance', () => {
  const c = findFinderCandidates(binarize(toGray(frame), frame.width, frame.height), frame.width, frame.height)
    .filter((k) => k.size === 7);
  // The prediction is (300, 220) at pitch 8. One candidate 9 pitches away, one too far, one with a wrong pitch.
  const far = { x: 300 + 72, y: 220, pitch: 8, size: 5 };
  const near = { x: 300 - 24, y: 220, pitch: 8, size: 5 };
  const tooFar = { x: 300, y: 220 + 13 * 8, pitch: 8, size: 5 };
  const wrongPitch = { x: 300 + 8, y: 220, pitch: 14, size: 5 };
  const o = orientFinders([...c, far, tooFar, wrongPitch, near]);
  assert.deepEqual(o.brCandidates, [[near.x, near.y], [far.x, far.y]]);
  assert.equal(o.options[0].tl, o.tl);
});
test('a marker whose black center reflects the room is still found', () => {
  // Measured on a phone photo of a TV: the bottom left marker's center read
  // 125 from a reflected lamp, its white ring 254 and the dark bezel beside it 35.
  const f = renderFrame({ frameBytes: new Uint8Array(500).map((_, i) => i * 7), index: 0, levels: 2, blockSize: 9, layout });
  const pad = 60, W = f.width + 2 * pad, H = f.height + 2 * pad;
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      const fx = x - pad, fy = y - pad;
      let v = 35; // bezel
      const inside = fx >= 0 && fy >= 0 && fx < f.width && fy < f.height;
      if (inside) v = f.data[(fy * f.width + fx) * 4];
      // A reflection lifts the screen's dark parts in the lower left quarter, not the bezel.
      if (inside && fx < f.width / 2 && fy > f.height / 2 && v < 128) v = 125;
      data[o] = data[o + 1] = data[o + 2] = v; data[o + 3] = 255;
    }
  }
  const img = blur({ data, width: W, height: H }, 1);
  const o = orientFinders(findFinderCandidates(binarize(toGray(img), W, H), W, H));
  assert.ok(o, 'markers found');
  expect(o.bl, pad + 3.5 * 9, pad + 26.5 * 9, 2);
});

// A perspective view: x = 100 + 800u / (1 + g u), y = 100 + (600v + k u) / (1 + g u).
// Its local scale at u = 1 is (1 + g)^-1.5 of that at u = 0, so g = 0.443 makes
// the far markers 0.577 of the near ones' pitch, as on the real capture.
function perspectiveQuad(pitchTl, pitchTr, pitchBl) {
  const g = 0.443, k = 300 * (1 + g) - 300;
  const at = (u, v) => ({ x: 100 + (800 * u) / (1 + g * u), y: 100 + (600 * v + k * u) / (1 + g * u) });
  return [
    { ...at(0, 0), pitch: pitchTl, size: 7 }, { ...at(1, 0), pitch: pitchTr, size: 7 },
    { ...at(0, 1), pitch: pitchBl, size: 7 }, { ...at(1, 1), pitch: pitchTr, size: 5 },
  ];
}
test('a far-side marker 6.0 against 10.4 and 10.5 is rejected by default and kept with perspective', () => {
  const c = perspectiveQuad(10.4, 6.0, 10.5);
  assert.equal(orientFinders(c), null);
  const o = orientFinders(c, { perspective: true });
  assert.ok(o, 'kept with perspective');
  expect(o.tl, c[0].x, c[0].y, 0.01); expect(o.tr, c[1].x, c[1].y, 0.01); expect(o.bl, c[2].x, c[2].y, 0.01);
  expect(o.br, c[3].x, c[3].y, 0.01);
  assert.deepEqual(o.pitches, { tl: 10.4, tr: 6.0, bl: 10.5 });
});
test('pitches 10 and 4 (ratio 2.5) are rejected either way', () => {
  const c = perspectiveQuad(10, 4, 10);
  assert.equal(orientFinders(c), null);
  assert.equal(orientFinders(c, { perspective: true }), null);
});

test('relaxed candidates stay few on a dark noisy image', () => {
  const W = 1920, H = 1080, data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) data.set([30, 30, 30, 255], i * 4);
  const img = noise({ data, width: W, height: H }, 6, 1);
  // Tile 16 is the plan's value; the reader's recovery pass uses 8 (see RECOVERY_TILE).
  for (const tile of [16, 8]) {
    const c = findFinderCandidates(binarize(toGray(img), W, H, tile), W, H, { outerMin: 0.25 });
    assert.ok(c.filter((k) => k.size === 7).length <= 20, `tile ${tile}: ${c.filter((k) => k.size === 7).length} size 7 candidates`);
  }
});

test('candidates carry their row and column block lengths', () => {
  const quad = tiltQuad(frame.width, frame.height, 640, 480, 25, 0.8);
  const img = warpToQuad(frame, quad, 640, 480);
  const c = findFinderCandidates(binarize(toGray(img), 640, 480), 640, 480);
  assert.ok(c.length > 0);
  for (const k of c) assert.ok(Math.abs((k.pitchX + k.pitchY) / 2 - k.pitch) < 1e-9, JSON.stringify(k));
});

test('with require, perspective quads all use a required candidate', () => {
  const c = perspectiveQuad(10.4, 6.0, 10.5);
  // Decoys: a second top-right and a second small marker, near the real ones.
  const decoyTr = { ...c[1], x: c[1].x + 3, y: c[1].y + 2 }, decoyBr = { ...c[3], x: c[3].x - 2, y: c[3].y + 3 };
  const all = [...c, decoyTr, decoyBr];
  const free = orientFinders(all, { perspective: true });
  assert.ok(free.options.some((o) => o.tr[0] === c[1].x), 'the real top-right forms a quad without require');
  const o = orientFinders(all, { perspective: true, require: new Set([decoyTr]) });
  assert.ok(o.options.length > 0);
  for (const q of o.options) assert.deepEqual(q.tr, [decoyTr.x, decoyTr.y]);
  // A required small marker may complete a triple of old candidates.
  const s = orientFinders(all, { perspective: true, require: new Set([decoyBr]) });
  for (const q of s.options) assert.deepEqual(q.br, [decoyBr.x, decoyBr.y]);
});
