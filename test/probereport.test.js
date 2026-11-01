import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportRows, PARTIAL_GAIN_NOTE } from '../tools/probe-report-format.js';
import { summarizeAttempts } from '../src/optimize/attemptlog.js';

const base = { blockSize: 20, scheme: 'x', fps: 4, static: false, stage: 'ok', txId: 1, index: 0, decodeMs: 1, grabMs: 1, ok: true };

test('the report rows show a Partial gain column, "-" without whole frames', () => {
  const [a] = reportRows(summarizeAttempts([{ ...base, packetMask: '1111' }, { ...base, packetMask: '1100' }]));
  assert.equal(a['Partial gain'], '1.50');
  const [b] = reportRows(summarizeAttempts([{ ...base, packetMask: '1100' }]));
  assert.equal(b['Partial gain'], '-');
  assert.match(PARTIAL_GAIN_NOTE, /estimate/);
});
