// The reader remembers which finder pass worked. Held at an angle, every
// attempt otherwise spends its time on a standard search that fails before the
// perspective pass succeeds. A hint runs the named pass first and falls back to
// the normal order; it must never change what can be read, and a wrong one
// must cost little.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { angledShot, stageOf } from '../src/testutil/angled.js';
import { FAIL_CASES } from '../src/testutil/failcases.js';
import { readImage } from '../src/testutil/image.js';
import { decodeCameraFrame } from '../src/picture/reader.js';
import { nextFinderHint } from '../src/optimize/readroute.js';

const REAL = new URL('photos/capture-2026-11-01T22-41-33-145Z.png', import.meta.url).pathname;
const failing = FAIL_CASES.filter((c) => c.kind !== 'reading');
const ids = (out) => out.frame.packets.map((p) => p && p.symbolId);

test('an angled frame costs far less work with its hint', () => {
  const shot = angledShot({ cols: 137, rows: 77, dim: 0, blurPx: 0, yawDeg: 25, distance: 0.9 });
  const plain = decodeCameraFrame(shot.img);
  const hinted = decodeCameraFrame(shot.img, { hint: 'perspective' });
  assert.equal(stageOf(plain, shot.packets, shot.payload), 'ok');
  assert.equal(stageOf(hinted, shot.packets, shot.payload), 'ok');
  assert.deepEqual(ids(hinted), ids(plain));
  assert.equal(plain.read.finderPass, 'perspective');
  assert.equal(hinted.read.finderPass, 'perspective');
  assert.ok(hinted.read.exactCells * 3 <= plain.read.exactCells, `${hinted.read.exactCells} of ${plain.read.exactCells} cells`);
  assert.ok(hinted.read.finderCandidates <= plain.read.finderCandidates, `${hinted.read.finderCandidates} of ${plain.read.finderCandidates} candidates`);
});

test('a stale hint on a straight frame still reads', () => {
  const shot = angledShot({ cols: 137, rows: 77, dim: 0, blurPx: 0, yawDeg: 0, distance: 0.9 });
  const plain = decodeCameraFrame(shot.img);
  for (const hint of ['perspective', 'recovery']) {
    const hinted = decodeCameraFrame(shot.img, { hint });
    assert.equal(stageOf(hinted, shot.packets, shot.payload), 'ok', hint);
    assert.deepEqual(ids(hinted), ids(plain), hint);
  }
});

test('a stale recovery hint on a frame the perspective pass reads still reads', () => {
  const shot = angledShot({ cols: 137, rows: 77, dim: 0, blurPx: 0, yawDeg: 25, distance: 0.9 });
  const hinted = decodeCameraFrame(shot.img, { hint: 'recovery' });
  assert.equal(stageOf(hinted, shot.packets, shot.payload), 'ok');
  assert.equal(hinted.read.finderPass, 'perspective');
});

for (const { name, build } of failing) {
  const img = build();
  const plain = decodeCameraFrame(img);
  test(`a hint on an image with no frame costs little extra: ${name}`, () => {
    const hinted = decodeCameraFrame(img, { hint: 'perspective' });
    assert.equal(hinted.frame, null);
    assert.equal(hinted.read.reason, plain.read.reason);
    assert.ok((hinted.read.exactCells ?? 0) <= (plain.read.exactCells ?? 0) * 1.15, `cells ${hinted.read.exactCells} of ${plain.read.exactCells}`);
    assert.ok(hinted.read.finderCandidates <= plain.read.finderCandidates * 1.15, `candidates ${hinted.read.finderCandidates} of ${plain.read.finderCandidates}`);
  });
  test(`a wrong hint never produces a frame the no-hint read would reject: ${name}`, () => {
    assert.equal(plain.frame, null);
    assert.equal(decodeCameraFrame(img, { hint: 'perspective' }).frame, null);
    assert.equal(decodeCameraFrame(img, { hint: 'recovery' }).frame, null);
  });
}

test('nextFinderHint names the pass that produced a frame', () => {
  const frame = { header: {} };
  assert.equal(nextFinderHint({ finderPass: 'standard' }, frame), null);
  assert.equal(nextFinderHint({ finderPass: 'perspective' }, frame), 'perspective');
  assert.equal(nextFinderHint({ finderPass: 'recovery' }, frame), 'recovery');
  // A version 4 frame with no good packet clears the hint; one good packet keeps it.
  assert.equal(nextFinderHint({ finderPass: 'perspective' }, { packets: [null, null] }), null);
  assert.equal(nextFinderHint({ finderPass: 'recovery' }, { packets: [] }), null);
  assert.equal(nextFinderHint({ finderPass: 'perspective' }, { packets: [null, { symbolId: 3 }] }), 'perspective');
  for (const finderPass of ['standard', 'perspective', 'recovery', undefined]) {
    assert.equal(nextFinderHint({ finderPass }, null), null, String(finderPass));
  }
});

test('a version 3 frame at an angle with its hint still decodes as version 3', () => {
  const shot = angledShot({ version: 3, cols: 137, rows: 77, dim: 0, blurPx: 0, yawDeg: 25, distance: 0.9 });
  const plain = decodeCameraFrame(shot.img);
  const hinted = decodeCameraFrame(shot.img, { hint: 'perspective' });
  assert.equal(stageOf(hinted, shot.packets, shot.payload), 'ok');
  assert.equal(hinted.read.version, 3);
  assert.equal(hinted.read.finderPass, 'perspective');
  assert.equal(hinted.read.edges, plain.read.edges);
  assert.ok(hinted.read.exactCells < plain.read.exactCells, `${hinted.read.exactCells} of ${plain.read.exactCells} cells`);
});

// This capture reaches the recovery pass and its header does not read, with
// or without the hint: the same corners, and no more work.
test('the real angled capture reads the same with its hint', { skip: !existsSync(REAL) }, () => {
  const img = readImage(REAL);
  const plain = decodeCameraFrame(img);
  assert.equal(plain.read.finderPass, 'recovery');
  const hinted = decodeCameraFrame(img, { hint: 'recovery' });
  assert.equal(hinted.read.finderPass, 'recovery');
  assert.equal(Boolean(hinted.frame), Boolean(plain.frame));
  assert.deepEqual(hinted.read.corners, plain.read.corners);
  assert.ok(hinted.read.exactCells <= plain.read.exactCells, `${hinted.read.exactCells} of ${plain.read.exactCells} cells`);
});
