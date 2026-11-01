import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLayout, fitGrid, maxBlockSize } from '../src/picture/layout.js';

test('minimum grid is accepted and smaller is refused', () => {
  computeLayout(33, 20);
  assert.throws(() => computeLayout(32, 20), { code: 'GRID_TOO_SMALL' });
  assert.throws(() => computeLayout(33, 19), { code: 'GRID_TOO_SMALL' });
});
test('reserved cells on a 40 by 30 grid', () => {
  const L = computeLayout(40, 30);
  const at = (c, r) => L.reserved[r * 40 + c];
  assert.equal(at(0, 0), 1); assert.equal(at(7, 7), 1);          // tl finder and quiet corner
  assert.equal(at(8, 0), 0);                                       // data above the top timing strip
  assert.equal(at(8, 6), 1); assert.equal(at(31, 6), 1); assert.equal(at(32, 6), 1); // top timing then tr quiet
  assert.equal(at(6, 8), 1); assert.equal(at(6, 21), 1);          // left timing
  assert.equal(at(8, 29), 1); assert.equal(at(26, 29), 1); assert.equal(at(27, 29), 0); // calibration strip
  assert.equal(at(39, 8), 1); assert.equal(at(39, 23), 1); assert.equal(at(39, 24), 1); // parity strip then br quiet
  assert.equal(at(35, 25), 1); assert.equal(at(34, 24), 1);       // br finder and its quiet corner
  assert.equal(at(20, 15), 0);
  const reservedCount = L.reserved.reduce((a, b) => a + b, 0);
  assert.equal(L.dataBlockCount, 40 * 30 - reservedCount);
  assert.equal(L.dataCells[0], 8);                                 // first data cell is col 8 row 0
});
test('fitGrid and maxBlockSize', () => {
  assert.deepEqual(fitGrid(1920, 1080, 16), { cols: 120, rows: 67 });
  assert.equal(maxBlockSize(1920, 1080), 54);
  assert.equal(maxBlockSize(1080, 2340), 32);
});
