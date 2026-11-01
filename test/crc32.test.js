import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from '../src/core/crc32.js';

test('known vector', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xCBF43926);
});

test('empty input', () => { assert.equal(crc32(new Uint8Array(0)), 0); });
