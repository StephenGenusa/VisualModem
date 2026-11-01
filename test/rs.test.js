import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rsEncode, rsDecode } from '../src/core/rs.js';

const data = Uint8Array.from({ length: 200 }, (_, i) => (i * 37) & 0xff);

test('round trip with no errors', () => {
  const cw = rsEncode(data, 32);
  assert.equal(cw.length, 232);
  const out = rsDecode(cw, 32);
  assert.deepEqual(out.data, data); assert.equal(out.corrected, 0);
});
test('corrects up to parity / 2 byte errors', () => {
  const cw = rsEncode(data, 32);
  for (let i = 0; i < 16; i++) cw[i * 13] ^= 0x5a;
  const out = rsDecode(cw, 32);
  assert.deepEqual(out.data, data); assert.equal(out.corrected, 16);
});
test('returns null beyond the correction limit', () => {
  const cw = rsEncode(data, 32);
  for (let i = 0; i < 17; i++) cw[i * 13] ^= 0x5a;
  assert.equal(rsDecode(cw, 32), null);
});
test('short codeword', () => {
  const short = data.subarray(0, 10);
  const cw = rsEncode(short, 8);
  cw[3] ^= 0xff; cw[12] ^= 0x01;
  assert.deepEqual(rsDecode(cw, 8).data, short);
});
test('parity zero is identity', () => {
  assert.deepEqual(rsEncode(data, 0), data);
  assert.deepEqual(rsDecode(data, 0).data, data);
});
