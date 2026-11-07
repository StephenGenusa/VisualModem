import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWakeLock } from '../web/wakelock.js';

function fakes() {
  const log = { requests: 0, released: 0, sentinels: [] };
  const nav = {
    wakeLock: {
      async request() {
        log.requests++;
        const listeners = [];
        const sentinel = {
          addEventListener: (_, f) => listeners.push(f),
          async release() { log.released++; listeners.forEach((f) => f()); },
          lost() { listeners.forEach((f) => f()); },
        };
        log.sentinels.push(sentinel);
        return sentinel;
      },
    },
  };
  return { nav, doc: { visibilityState: 'visible' }, log };
}

test('holds the lock while wanted and lets go after', async () => {
  const { nav, doc, log } = fakes();
  const lock = createWakeLock(nav, doc);
  await lock.sync(true);
  await lock.sync(true);
  assert.equal(log.requests, 1);
  await lock.sync(false);
  assert.equal(log.released, 1);
  await lock.sync(false);
  assert.equal(log.released, 1);
});

test('takes it again after the browser let it go, once the page is visible', async () => {
  const { nav, doc, log } = fakes();
  const lock = createWakeLock(nav, doc);
  await lock.sync(true);
  doc.visibilityState = 'hidden';
  log.sentinels[0].lost();
  await lock.sync(true);
  assert.equal(log.requests, 1, 'a hidden page cannot ask');
  doc.visibilityState = 'visible';
  await lock.sync(true);
  assert.equal(log.requests, 2);
});

test('a browser without it, or one that refuses, is harmless', async () => {
  await assert.doesNotReject(createWakeLock({}, { visibilityState: 'visible' }).sync(true));
  const refusing = { wakeLock: { request: async () => { throw new Error('denied'); } } };
  const lock = createWakeLock(refusing, { visibilityState: 'visible' });
  await assert.doesNotReject(lock.sync(true));
  await assert.doesNotReject(lock.sync(false));
});

test('a request answered after the wish ended is let go', async () => {
  const { nav, doc, log } = fakes();
  const lock = createWakeLock(nav, doc);
  const asking = lock.sync(true);
  const ending = lock.sync(false);
  await Promise.all([asking, ending]);
  assert.equal(log.requests, 1);
  assert.equal(log.released, 1);
});
