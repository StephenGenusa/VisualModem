import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCameraStarter } from '../web/camera.js';

// A fake open: each call is held until the test settles it.
function harness() {
  const log = { opens: [], streams: [], errors: [], starting: 0 };
  const starter = createCameraStarter({
    open: (isCurrent) => new Promise((resolve, reject) => {
      log.opens.push({ isCurrent, resolve, reject });
    }),
    onStarting: () => { log.starting++; },
    onStream: (s) => log.streams.push(s),
    onError: (e) => log.errors.push(e),
  });
  return { starter, log };
}
function fakeStream() {
  const s = { stopped: false, getTracks: () => [{ stop: () => { s.stopped = true; } }] };
  return s;
}
const tick = () => new Promise((r) => setImmediate(r));

test('a second start while opening does not open again', async () => {
  const { starter, log } = harness();
  starter.start();
  starter.start();
  assert.equal(log.opens.length, 1);
  const s = fakeStream();
  log.opens[0].resolve(s);
  await tick();
  assert.deepEqual(log.streams, [s]);
  assert.equal(s.stopped, false);
  starter.start(); // already running: nothing
  assert.equal(log.opens.length, 1);
});

test('pageshow right after load gives a running camera, not an error', async () => {
  const { starter, log } = harness();
  starter.start(); // main
  starter.start(); // pageshow
  log.opens[0].resolve(fakeStream());
  await tick();
  assert.equal(log.streams.length, 1);
  assert.equal(log.errors.length, 0);
});

test('a stop during opening lets the next start open again', async () => {
  const { starter, log } = harness();
  starter.start();
  starter.stop();
  assert.equal(log.opens[0].isCurrent(), false);
  starter.start();
  assert.equal(log.opens.length, 2);
  const stale = fakeStream();
  const fresh = fakeStream();
  log.opens[0].resolve(stale);
  log.opens[1].resolve(fresh);
  await tick();
  assert.equal(stale.stopped, true);
  assert.deepEqual(log.streams, [fresh]);
});

test('a failed open shows its error and a later start tries again', async () => {
  const { starter, log } = harness();
  starter.start();
  log.opens[0].reject(new Error('boom'));
  await tick();
  assert.equal(log.errors.length, 1);
  assert.equal(log.errors[0].message, 'boom');
  starter.start();
  assert.equal(log.opens.length, 2);
});

test('a stale failure is not reported', async () => {
  const { starter, log } = harness();
  starter.start();
  starter.stop();
  log.opens[0].reject(new Error('aborted'));
  await tick();
  assert.equal(log.errors.length, 0);
});

test('a size switch during an open ends with one stream at the new size', async () => {
  const { starter, log } = harness();
  starter.start(); // 1080p, still opening
  starter.stop(); // size switch
  starter.start(); // 4k
  const old = fakeStream();
  const next = fakeStream();
  log.opens[1].resolve(next);
  log.opens[0].resolve(old);
  await tick();
  assert.deepEqual(log.streams, [next]);
  assert.equal(old.stopped, true);
  assert.equal(next.stopped, false);
});
