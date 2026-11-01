import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipCompress, gzipDecompress, sha256 } from '../src/core/compression.js';

test('gzip round trip', async () => {
  const input = new TextEncoder().encode('hello '.repeat(1000));
  const out = await gzipDecompress(await gzipCompress(input));
  assert.deepEqual(out, input);
});

test('sha256 of empty input', async () => {
  assert.equal(await sha256(new Uint8Array(0)),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});
