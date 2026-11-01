import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BitWriter, BitReader } from '../src/core/bits.js';

test('writes and reads mixed widths', () => {
  const w = new BitWriter(2);
  w.write(0b101, 3); w.write(0b11, 2); w.write(0b00000001, 8); w.write(0b111, 3);
  assert.deepEqual(w.bytes(), new Uint8Array([0b10111000, 0b00001111]));
  const r = new BitReader(w.bytes());
  assert.equal(r.read(3), 0b101); assert.equal(r.read(2), 0b11);
  assert.equal(r.read(8), 1); assert.equal(r.read(3), 0b111);
  assert.equal(r.remaining(), 0);
});

test('reading past the end yields zeros', () => {
  const r = new BitReader(new Uint8Array([0xff]));
  assert.equal(r.read(8), 0xff);
  assert.equal(r.read(4), 0);
});

test('writing past capacity throws', () => {
  const w = new BitWriter(1);
  w.write(0xff, 8);
  assert.throws(() => w.write(1, 1));
});
