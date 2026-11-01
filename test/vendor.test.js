import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

// Top-level files of web/ only; web/vendor/ holds third-party copies and is skipped.
const webDir = new URL('../web/', import.meta.url);
const files = readdirSync(webDir).filter((f) => /\.(js|html|css)$/.test(f));
const remote = ['https://cdn', 'cdnjs', 'unpkg.com', 'jsdelivr'];

test('no web file loads anything from another origin', () => {
  assert.ok(files.length > 0);
  for (const f of files) {
    const text = readFileSync(new URL(f, webDir), 'utf8');
    for (const needle of remote) {
      assert.ok(!text.includes(needle), `web/${f} contains "${needle}"`);
    }
  }
});

test('the QR library is served locally', () => {
  const lib = new URL('vendor/qrcode.js', webDir);
  assert.ok(existsSync(lib), 'web/vendor/qrcode.js is missing');
  assert.ok(readFileSync(lib, 'utf8').includes('var qrcode = function'));
});
