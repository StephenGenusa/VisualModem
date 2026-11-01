import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLayout } from '../src/picture/layout.js';
import { decodeCameraFrame } from '../src/picture/reader.js';
import { chromaBlur, colorCast } from '../src/testutil/distort.js';
import {
  CHARACTERIZATION_PATCHES, characterizationLayout, renderCharacterization, analyzeCharacterization,
} from '../src/optimize/characterize.js';

const layout = computeLayout(80, 45);

function profileOf(img) {
  const { read, sample } = decodeCameraFrame(img);
  assert.equal(read.markersFound, true, read.reason);
  return { read, profile: analyzeCharacterization(sample, layout, read.pitch) };
}

test('the patch list is fixed', () => {
  assert.equal(CHARACTERIZATION_PATCHES.length, 8 + 8 + 9 + 2);
  const ids = new Set(CHARACTERIZATION_PATCHES.map((p) => p.id));
  assert.equal(ids.size, CHARACTERIZATION_PATCHES.length);
  const colors = CHARACTERIZATION_PATCHES.map((p) => p.color.join(','));
  assert.ok(colors.includes('255,0,128') && colors.includes('0,140,70'));
});

test('the layout is deterministic and places every patch and target', () => {
  const a = characterizationLayout(layout), b = characterizationLayout(layout);
  assert.deepEqual(a, b);
  assert.deepEqual(new Set(a.patches.map((p) => p.id)), new Set(CHARACTERIZATION_PATCHES.map((p) => p.id)));
  assert.equal(a.targets.length, 6);
  for (const t of a.targets) { assert.equal(t.cells.length, 64); assert.equal(t.phase.length, 64); }
  const used = [...a.patches.flatMap((p) => p.cells), ...a.targets.flatMap((t) => t.cells)];
  assert.equal(new Set(used).size, used.length, 'no cell is used twice');
});

test('the characterization frame header says frameType 1', () => {
  const { read, frame } = decodeCameraFrame(renderCharacterization({ layout, blockSize: 9, probeId: 5, probeCount: 36 }));
  assert.equal(read.frameType, 1);
  assert.equal(frame.header.frameType, 1);
  assert.equal(frame.header.blockSize, 9);
  assert.equal(frame.header.probeId, 5); assert.equal(frame.header.probeCount, 36);
});

test('a clean characterization frame measures full contrast at every size', () => {
  const { profile } = profileOf(renderCharacterization({ layout, blockSize: 9 }));
  assert.equal(profile.measured, true);
  for (const s of [1, 2, 4]) {
    assert.ok(profile.luma[s] >= 0.9, `luma ${s}: ${profile.luma[s]}`);
    assert.ok(profile.chroma[s] >= 0.9, `chroma ${s}: ${profile.chroma[s]}`);
  }
  assert.deepEqual(profile.patches['gray-7'].mean.map(Math.round), [255, 255, 255]);
});

test('color blur lowers chroma contrast at size 1, not luma', () => {
  const img = chromaBlur(renderCharacterization({ layout, blockSize: 9 }), 9);
  const { profile } = profileOf(img);
  assert.ok(profile.chroma[1] < 0.5, `chroma 1: ${profile.chroma[1]}`);
  assert.ok(profile.luma[1] > 0.8, `luma 1: ${profile.luma[1]}`);
  assert.ok(profile.chroma[4] > 0.7, `chroma 4: ${profile.chroma[4]}`);
});

test('a color cast shows in the profile', () => {
  const m = [1.1, 1, 0.85];
  const img = colorCast(renderCharacterization({ layout, blockSize: 9, white: 200 }), m);
  const { profile } = profileOf(img);
  const avg = (m[0] + m[1] + m[2]) / 3;
  m.forEach((v, c) => assert.ok(Math.abs(profile.cast[c] - v / avg) < 0.03, `cast ${profile.cast}`));
});

test('too small to measure', () => {
  const p = analyzeCharacterization(() => [0, 0, 0], layout, 2);
  assert.equal(p.measured, false);
  assert.equal(p.reason, 'too small');
  assert.equal(p.luma, undefined);
  assert.equal(p.chroma, undefined);
  assert.equal(p.cast, undefined);
});
