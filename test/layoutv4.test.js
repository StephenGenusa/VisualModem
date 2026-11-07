import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLayout, computeLayoutV4 } from '../src/picture/layout.js';
import { schemeColors, schemeFromLevels } from '../src/core/scheme.js';

const GRIDS = [[33, 20], [64, 36], [137, 77], [213, 120], [240, 135]];

test('213 by 120 has 18 alignment patterns and 48 pilots', () => {
  const l = computeLayoutV4(213, 120);
  assert.equal(l.align.length, 18);
  assert.equal(l.pilots.length, 48);
});

test('version 4 data cells are version 3 data cells, with their indices', () => {
  for (const [c, r] of GRIDS) {
    const l = computeLayoutV4(c, r);
    const v3 = computeLayout(c, r);
    assert.equal(l.v3Index.length, l.dataCells.length);
    for (let i = 0; i < l.dataCells.length; i++) {
      assert.equal(l.dataCells[i], v3.dataCells[l.v3Index[i]]);
      if (i > 0) assert.ok(l.v3Index[i] > l.v3Index[i - 1]);
    }
  }
});

test('the first header copy sits on the version 3 header cells', () => {
  for (const [c, r] of GRIDS) {
    const l = computeLayoutV4(c, r);
    for (let i = 0; i < 128; i++) assert.equal(l.v3Index[i], i);
  }
});

test('pilots, alignment patterns and bottom timing are never data', () => {
  for (const [c, r] of GRIDS) {
    const l = computeLayoutV4(c, r);
    const data = new Set(l.dataCells);
    for (const p of l.pilots) assert.ok(!data.has(p));
    for (const a of l.align) {
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) assert.ok(!data.has((a.row + dy) * c + a.col + dx));
    }
    for (let x = l.timingBottom.colStart; x <= l.timingBottom.colEnd; x++) assert.ok(!data.has(l.timingBottom.row * c + x));
    const first = new Set(l.dataCells.slice(0, 128));
    const last = new Set(l.dataCells.slice(-128));
    const v3 = computeLayout(c, r);
    // A pilot lies between the first and last 128 candidates, so before/after
    // those data cells in cell order.
    for (const p of l.pilots) {
      assert.ok(p > l.dataCells[127] && p < l.dataCells[l.dataCells.length - 128]);
      assert.ok(!first.has(p) && !last.has(p));
      assert.equal(v3.reserved[p], 0);
    }
  }
});

test('the layout depends only on the grid size', () => {
  assert.deepEqual(computeLayoutV4(213, 120).pilots, computeLayoutV4(213, 120).pilots);
  assert.notDeepEqual(computeLayoutV4(213, 120).pilots, computeLayoutV4(213, 121).pilots);
});

test('small grids have no alignment patterns', () => {
  const l = computeLayoutV4(33, 20);
  assert.equal(l.align.length, 0);
  assert.equal(l.pilots.length, 48);
});

// The fastest of three, so other work on the machine does not fail the test.
test('a 1920 by 1080 grid lays out in under 1500 ms', () => {
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    computeLayoutV4(1920, 1080);
    best = Math.min(best, performance.now() - t);
  }
  assert.ok(best < 1500, `took ${best} ms`);
});

test('schemeColors lists every color once', () => {
  assert.equal(new Set(schemeColors(schemeFromLevels(2)).map(String)).size, 8);
  assert.equal(new Set(schemeColors({ kind: 'rgb', levels: [2, 4, 2] }).map(String)).size, 16);
  assert.deepEqual(schemeColors({ kind: 'gray', levels: 4 }), [[0, 0, 0], [85, 85, 85], [170, 170, 170], [255, 255, 255]]);
});

// A 32 bit FNV-1a over the Int32 values, byte by byte, low byte first.
function fnv(values) {
  let h = 0x811c9dc5;
  for (const v of values) {
    for (let k = 0; k < 4; k++) { h ^= (v >>> (8 * k)) & 255; h = Math.imul(h, 0x01000193) >>> 0; }
  }
  return h;
}

test('the 213 by 120 layout is frozen: pilots and data cell positions', () => {
  const l = computeLayoutV4(213, 120);
  assert.deepEqual(Array.from(l.pilots.slice(0, 8)), [230, 504, 977, 1759, 2216, 2387, 3281, 4781]);
  assert.equal(l.dataCells.length, 24228);
  assert.equal(fnv(l.pilots), 855805728);
  assert.equal(fnv(l.dataCells), 2889776194);
});
