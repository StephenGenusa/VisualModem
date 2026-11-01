import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodePayload, decodePayload, peekManifest } from '../src/core/payload.js';

const record = { type: 'file', name: 'notes.pdf', mime: 'application/pdf',
  data: new TextEncoder().encode('%PDF-1.4 '.repeat(2000)) };

test('plain round trip and manifest', async () => {
  const stream = await encodePayload(record);
  const m = peekManifest(stream);
  assert.equal(m.encrypted, false);
  assert.equal(m.bodyLength, stream.length - 42);
  assert.equal(m.txId, (m.bodyHash[0] << 24 | m.bodyHash[1] << 16 | m.bodyHash[2] << 8 | m.bodyHash[3]) >>> 0);
  assert.deepEqual(await decodePayload(stream), record);
});
test('encrypted round trip', async () => {
  const stream = await encodePayload(record, 'open sesame');
  assert.equal(peekManifest(stream).encrypted, true);
  assert.equal(peekManifest(stream).bodyLength, stream.length - 70);
  assert.deepEqual(await decodePayload(stream, 'open sesame'), record);
});
test('wrong and missing password', async () => {
  const stream = await encodePayload(record, 'open sesame');
  await assert.rejects(decodePayload(stream, 'wrong'), { code: 'BAD_PASSWORD' });
  await assert.rejects(decodePayload(stream), { code: 'NEEDS_PASSWORD' });
});
test('body hash mismatch', async () => {
  const stream = await encodePayload(record);
  stream[stream.length - 1] ^= 0xff;
  await assert.rejects(decodePayload(stream), { code: 'BAD_HASH' });
});
test('message type', async () => {
  const msg = { type: 'message', name: '', mime: 'text/plain', data: new TextEncoder().encode('hi') };
  assert.deepEqual(await decodePayload(await encodePayload(msg)), msg);
});
test('empty payload is refused', async () => {
  await assert.rejects(encodePayload({ ...record, data: new Uint8Array(0) }), { code: 'EMPTY_PAYLOAD' });
});
test('long filename is cut at a character boundary', async () => {
  const long = { ...record, name: 'é'.repeat(200) + '.pdf' };
  const out = await decodePayload(await encodePayload(long));
  assert.ok(new TextEncoder().encode(out.name).length <= 255);
  assert.ok(out.name.startsWith('éééé'));
  assert.ok(!out.name.includes('�'));
});
test('garbage stream', async () => {
  await assert.rejects(decodePayload(new Uint8Array(50)), { code: 'BAD_MANIFEST' });
});
