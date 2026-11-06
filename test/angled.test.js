// Angled views: what a phone sees when it is not square to the screen. Cases
// marked todo are views that do not read yet; they report as todo and lose the
// flag once they do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { angledShot, stageOf } from '../src/testutil/angled.js';
import { readImage } from '../src/testutil/image.js';
import { decodeCameraFrame } from '../src/picture/reader.js';

const TODO = { todo: 'angled view not read yet' };
const PITCH_PX = 10.4; // near-side block pitch of the real capture
const OUT_OF_VIEW_CELLS = 29700; // 25856 measured with the recovery pass, plus 15 percent

function assertReads(shot, version) {
  const out = decodeCameraFrame(shot.img);
  const stage = stageOf(out, shot.packets, shot.payload);
  assert.equal(stage, 'ok', stage);
  assert.equal(out.read.version, version);
}

// Clean shots (no far-side dimming or blur): the standard search fails on every
// one of them, so they must read on the perspective pass.
function assertPerspectiveRead(opts, version) {
  const shot = angledShot({ cols: 137, rows: 77, dim: 0, blurPx: 0, ...opts });
  const out = decodeCameraFrame(shot.img);
  const stage = stageOf(out, shot.packets, shot.payload);
  assert.equal(stage, 'ok', stage);
  assert.equal(out.read.version, version);
  assert.equal(out.read.finderPass, 'perspective');
}
for (const yawDeg of [15, 25]) {
  for (const distance of [0.9, 1.6]) {
    test(`v4 137x77 at ${yawDeg} degrees, distance ${distance}, clean, decodes on the perspective pass`, () => {
      assertPerspectiveRead({ yawDeg, distance }, 4);
    });
  }
}
test('v4 at 30 degrees, close, clean, decodes', () => {
  assertPerspectiveRead({ yawDeg: 30, distance: 0.9 }, 4);
});
test('v3 at 25 degrees, close, clean, decodes as version 3', () => {
  assertPerspectiveRead({ version: 3, yawDeg: 25, distance: 0.9 }, 3);
});
// Here the standard search already tries the real triple, with the mean pitch
// estimate and its own small marker candidates, and fails; the perspective
// quad with the same triple is a different fit and must still be tried.
test('v4 80x45 at 30 degrees, distance 1.6, clean, decodes on the perspective pass with a triple the standard search tried', () => {
  assertPerspectiveRead({ cols: 80, rows: 45, yawDeg: 30, distance: 1.6 }, 4);
});
// The standard pass alone sampled 13920 strip cells on this image (the
// reader before the perspective pass); a failed read counts every pass's work.
// (Yaw 30 decodes with the homography size estimate, so this uses yaw 45.)
test('a failed perspective pass adds its work to exactCells', () => {
  const shot = angledShot({ cols: 137, rows: 77, yawDeg: 45, distance: 0.9 });
  const out = decodeCameraFrame(shot.img);
  assert.equal(out.read.reason, 'timing mismatch');
  assert.ok(out.read.exactCells > 13920, `exactCells ${out.read.exactCells}`);
});

test('v4 137x77 at 25 degrees, close (distance 0.9), far side dim 0.35 and blurred 2 px, decodes', () => {
  assertReads(angledShot({ cols: 137, rows: 77, yawDeg: 25, distance: 0.9, dim: 0.35, blurPx: 2 }), 4);
});

// Still todo (timing mismatch): the far small marker is 3.7 px a
// block along the rows and dimmed, and no scan makes it a candidate; the far
// top-right one measures 4.7 against 11.5 near, a ratio of 2.45 (over 2.4).
const YAW35 = { todo: 'the far small marker is not a candidate at 35 degrees, dimmed' };
test('v4 137x77 at 35 degrees (stretch), close (distance 0.9), far side dim 0.35 and blurred 2 px, decodes', YAW35, () => {
  assertReads(angledShot({ cols: 137, rows: 77, yawDeg: 35, distance: 0.9, dim: 0.35, blurPx: 2 }), 4);
});

test('v4 137x77 at 25 degrees with 10 degrees of pitch decodes', TODO, () => {
  assertReads(angledShot({ cols: 137, rows: 77, yawDeg: 25, pitchDeg: 10, distance: 0.9, dim: 0.35, blurPx: 2 }), 4);
});

test('v3 137x77 at 25 degrees, close, decodes as version 3', () => {
  assertReads(angledShot({ cols: 137, rows: 77, version: 3, yawDeg: 25, distance: 0.9, dim: 0.35, blurPx: 2 }), 3);
});

const REAL = new URL('./photos/capture-2026-11-01T22-41-33-145Z.png', import.meta.url);
test('the real angled capture finds the top-right marker within 3 pitches of (1575, 256)',
  { skip: existsSync(REAL) ? false : 'photo not present' }, () => {
    const out = decodeCameraFrame(readImage(REAL.pathname));
    assert.equal(out.read.markersFound, true);
    // The corners the reader used (a failed read reports the quad it tried).
    const tr = out.read.corners?.tr;
    assert.ok(tr, out.read.reason);
    assert.ok(Math.hypot(tr[0] - 1575, tr[1] - 256) <= 3 * PITCH_PX, `top-right at ${tr.map(Math.round)}`);
  });

// The frame shifted up so the top-left marker runs off the top of the image.
function shiftUp(img, dy, fill = [24, 24, 28]) {
  const { width, height } = img;
  const data = new Uint8ClampedArray(img.data.length);
  for (let y = 0; y < height; y++) {
    if (y + dy < height) data.set(img.data.subarray((y + dy) * width * 4, (y + dy + 1) * width * 4), y * width * 4);
    else for (let x = 0; x < width; x++) data.set([...fill, 255], (y * width + x) * 4);
  }
  return { data, width, height };
}
// Before the perspective pass this image failed with 13056 strip cells sampled in 104 ms
// (median of 5, utils-style timing on the development machine). The bound is
// on work, not the clock: the recovery pass may add its own fits, but only
// for quads that use a marker the first scan missed.
test('a marker out of view gives no frame', () => {
  const img = shiftUp(angledShot({ cols: 137, rows: 77, yawDeg: 25, distance: 0.9 }).img, 230);
  const out = decodeCameraFrame(img);
  assert.equal(out.frame, null);
  assert.ok(['no markers', 'timing mismatch'].includes(out.read.reason), out.read.reason);
  assert.ok(out.read.exactCells <= OUT_OF_VIEW_CELLS, `exactCells ${out.read.exactCells}`);
});

// A dense frame running out of view (202x113 at 6 px, enlarged 1.4x): its
// work bound, tighter than the one above, is in
// test/failcost.test.js ('out of view 202x113 x1.4'). The
// recovery scan does not run on it (no strip-joined pair of candidates).

// Small angles: the standard pass fits a false lower pair of markers whose
// quad looks frontal (140x65 and 137x65, on the top and right strips). The
// frontal check must not end the search there; both read on the perspective
// pass, as before the frontal check.
test('v4 137x77 at 5 degrees, close (distance 0.9), decodes', () => {
  assertReads(angledShot({ cols: 137, rows: 77, yawDeg: 5, distance: 0.9 }), 4);
});

test('v4 137x77 at 7 degrees, distance 1.2, decodes', () => {
  assertReads(angledShot({ cols: 137, rows: 77, yawDeg: 7, distance: 1.2 }), 4);
});

// These once failed at 'header unreadable': the standard pass fits
// 57 or 56 columns for a true 60 and the search ended there.
test('v4 60x34 at 25 degrees, distance 1.6: a wrong-size fit with no readable header does not end the search', () => {
  const shot = angledShot({ cols: 60, rows: 34, yawDeg: 25, distance: 1.6 });
  const out = decodeCameraFrame(shot.img);
  assert.equal(stageOf(out, shot.packets, shot.payload), 'ok');
  assert.equal(out.read.cols, 60);
});

test('stageOf does not call a header-only or wrong-payload read ok', () => {
  const payload = Uint8Array.from([1, 2, 3]);
  assert.equal(stageOf({ read: {}, frame: { payload: Uint8Array.from([1, 2, 4]) } }, null, payload), 'payload failed');
  assert.equal(stageOf({ read: {}, frame: { payload } }, null, payload), 'ok');
  assert.equal(stageOf({ read: {}, frame: { header: {} } }, null, payload), 'payload failed');
});
