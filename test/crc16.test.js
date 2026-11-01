import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc16 } from '../src/core/crc16.js';

test('crc16 is CRC-16/CCITT-FALSE', () => {
  assert.equal(crc16(new TextEncoder().encode('123456789')), 0x29B1);
  assert.equal(crc16(new Uint8Array(0)), 0xFFFF);
});
