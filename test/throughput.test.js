import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createThroughputRun, deliveredResolution } from '../src/tune/throughput.js';

const streamBytes = 12000;

test('times each frame rate in turn', () => {
  const run = createThroughputRun({ streamBytes });
  assert.equal(run.current().fps, 2);
  run.start(0);
  run.complete(6000);
  assert.deepEqual(run.results()[0], { fps: 2, seconds: 6, bytesPerSecond: streamBytes / 6, timedOut: false });
  assert.equal(run.tick(6000, false), 'next');
  assert.equal(run.current().fps, 3);
});

test('a run that stops collecting times out and the sweep continues', () => {
  const run = createThroughputRun({ streamBytes });
  run.start(0);
  assert.equal(run.tick(17000, false), 'running');
  assert.equal(run.tick(18000, false), 'next'); // 3 loops of 12 frames at 2 fps is 18 s
  assert.deepEqual(run.results()[0], { fps: 2, seconds: null, bytesPerSecond: null, timedOut: true });
  assert.equal(run.current().fps, 3);
});

test('progress keeps a slow run alive', () => {
  const run = createThroughputRun({ streamBytes });
  run.start(0);
  for (let t = 5000, have = 1; t <= 40000; t += 5000, have++) {
    run.progress(have, t);
    assert.equal(run.tick(t, false), 'running');
  }
  run.complete(40000);
  assert.equal(run.results()[0].timedOut, false);
  assert.equal(run.results()[0].seconds, 40);
});

test('paused time does not count toward the timeout', () => {
  const run = createThroughputRun({ streamBytes });
  run.start(0);
  for (let t = 500; t <= 30000; t += 500) assert.equal(run.tick(t, t >= 5000 && t < 25000), 'running');
});

test('done after the last frame rate', () => {
  const run = createThroughputRun({ streamBytes, fpsSteps: [2, 3] });
  run.start(0);
  run.complete(6000);
  assert.equal(run.tick(6000, false), 'next');
  run.start(6000);
  run.complete(10000);
  assert.equal(run.tick(10000, false), 'done');
  assert.equal(run.current(), null);
  assert.equal(run.results().length, 2);
});

test('delivered resolution labels what the phone gave', () => {
  assert.equal(deliveredResolution({ width: 3840, height: 2160 }), '4k');
  assert.equal(deliveredResolution({ width: 2160, height: 3840 }), '4k');
  assert.equal(deliveredResolution({ width: 1920, height: 1080 }), '1080p');
  assert.equal(deliveredResolution({ width: 1440, height: 1080 }), 'other');
});
