import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupRefine } from '../web/refine.js';

function page(hash) {
  const calls = [];
  const el = () => ({ hidden: true, addEventListener() {} });
  const ids = new Map();
  globalThis.document = { getElementById: (id) => { if (!ids.has(id)) ids.set(id, el()); return ids.get(id); } };
  globalThis.location = { hash };
  globalThis.fetch = async (url, opts = {}) => { calls.push({ url, body: opts.body }); return { ok: true }; };
  return { calls, ids };
}

test('only the Send tab clears the word on the phone', () => {
  try {
    for (const [hash, clears] of [['#receive', false], ['#send', true], ['', true]]) {
      const { calls, ids } = page(hash);
      setupRefine({}, true);
      assert.equal(ids.get('grp-refine').hidden, false);
      assert.equal(calls.filter((c) => c.url === '/session').length, clears ? 1 : 0, `hash "${hash}"`);
      if (clears) assert.deepEqual(JSON.parse(calls[0].body), { refine: null });
    }
    const { calls, ids } = page('#send');
    setupRefine({}, false);
    assert.equal(calls.length, 0);
    assert.equal(ids.size, 0, 'with no capture server the page is left alone');
  } finally {
    delete globalThis.document;
    delete globalThis.location;
    delete globalThis.fetch;
  }
});
