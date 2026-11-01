import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeScheme, decodeScheme, schemeFromLevels, bitsPerBlock, schemeName, SCHEME_CHOICES,
} from '../src/core/scheme.js';
import { blocksFromBytes, bytesFromBlocks, grossBytes, schemeThresholds, levelValue } from '../src/core/symbols.js';

const ALL = [...SCHEME_CHOICES.map((c) => c.scheme ?? schemeFromLevels(2)), { kind: 'rgb', levels: [256, 256, 256] },
  { kind: 'rgb', levels: [4, 8, 2] }, { kind: 'gray', levels: 16 }];

test('encode and decode round trip every scheme', () => {
  for (const s of ALL) {
    const [a, b] = encodeScheme(s);
    assert.deepEqual(decodeScheme(a, b), s, schemeName(s));
  }
});

test('unknown scheme bytes decode to null', () => {
  assert.equal(decodeScheme(2, 0), null);
  assert.equal(decodeScheme(1, 3), null);
  assert.equal(decodeScheme(1, 256), null);
  assert.equal(decodeScheme(0, 0x40), null); // bits above the r code
});

test('bits per block', () => {
  assert.equal(bitsPerBlock({ kind: 'rgb', levels: [2, 2, 2] }), 3);
  assert.equal(bitsPerBlock({ kind: 'rgb', levels: [2, 4, 2] }), 4);
  assert.equal(bitsPerBlock({ kind: 'gray', levels: 4 }), 2);
  assert.equal(bitsPerBlock({ kind: 'rgb', levels: [256, 256, 256] }), 24);
});

test('scheme names and choices', () => {
  assert.equal(schemeName({ kind: 'rgb', levels: [2, 4, 2] }), 'rgb 2/4/2');
  assert.equal(schemeName({ kind: 'gray', levels: 4 }), 'gray 4');
  assert.deepEqual(SCHEME_CHOICES.map((c) => c.id), ['cube', 'g4', 'gray2', 'gray4']);
  assert.deepEqual(schemeFromLevels(4), { kind: 'rgb', levels: [4, 4, 4] });
});

test('symbols round trip at every scheme', () => {
  const bytes = Uint8Array.from({ length: 301 }, (_, i) => (i * 131 + 7) & 0xff);
  for (const s of ALL) {
    const blockCount = Math.ceil(bytes.length * 8 / bitsPerBlock(s));
    const rgb = blocksFromBytes(bytes, s, blockCount);
    assert.equal(rgb.length, blockCount * 3);
    assert.deepEqual(bytesFromBlocks(rgb, s, schemeThresholds(s)).subarray(0, bytes.length), bytes, schemeName(s));
    assert.equal(grossBytes(blockCount, s), Math.floor(blockCount * bitsPerBlock(s) / 8));
  }
});

test('gray decides on brightness under a color cast', () => {
  const s = { kind: 'gray', levels: 4 };
  const bytes = Uint8Array.from({ length: 64 }, (_, i) => (i * 97 + 3) & 0xff);
  const blockCount = bytes.length * 4;
  const rgb = blocksFromBytes(bytes, s, blockCount);
  const cast = [1.15, 1.0, 0.8];
  const tinted = rgb.map((v, i) => Math.min(255, Math.round(v * cast[i % 3])));
  const lum = (v) => 0.299 * Math.min(255, v * 1.15) + 0.587 * v + 0.114 * v * 0.8;
  const y = [0, 1, 2].map((k) => (lum(levelValue(4, k)) + lum(levelValue(4, k + 1))) / 2);
  assert.deepEqual(bytesFromBlocks(tinted, s, { y }), bytes);
});

test('a number still means the version 2 cube', () => {
  assert.equal(grossBytes(100, 4), 75);
  assert.deepEqual(Array.from(blocksFromBytes(new Uint8Array([0b11001000]), 4, 1)), [255, 0, 170]);
});
