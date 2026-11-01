import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextAttemptDelay, MIN_GAP_MS, JITTER_MS } from '../src/tune/pacing.js';

test('a slow decode starts the next attempt at once, plus jitter', () => {
  assert.equal(nextAttemptDelay({ sinceGrabMs: 80, random: () => 0 }), 0);
  assert.equal(nextAttemptDelay({ sinceGrabMs: 80, random: () => 0.5 }), JITTER_MS / 2);
});

test('a fast decode waits for a new camera frame', () => {
  assert.equal(nextAttemptDelay({ sinceGrabMs: 10, random: () => 0 }), 24);
});

test('jitter is bounded', () => {
  assert.ok(nextAttemptDelay({ sinceGrabMs: 0, random: () => 0.999 }) < MIN_GAP_MS + JITTER_MS);
  assert.ok(nextAttemptDelay({ sinceGrabMs: 500, random: () => 0.999 }) < JITTER_MS);
});
