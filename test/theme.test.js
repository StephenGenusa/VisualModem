import { test } from 'node:test';
import assert from 'node:assert/strict';
import { THEMES, DEFAULT_THEME, resolveTheme, loadTheme, saveTheme, shownTheme } from '../web/theme.js';

test('six themes: each theme light then dark, sage light first', () => {
  assert.deepEqual(THEMES.map((t) => t.id),
    ['sage', 'sage-dark', 'parchment', 'parchment-dark', 'linen', 'linen-dark']);
  assert.deepEqual(THEMES.map((t) => t.name),
    ['Sage light', 'Sage dark', 'Parchment light', 'Parchment dark', 'Linen light', 'Linen dark']);
  assert.equal(DEFAULT_THEME, null, 'no default choice: follow the system');
  for (const t of THEMES) assert.equal(t.swatch.length, 3);
  assert.notDeepEqual(THEMES[0].swatch, THEMES[1].swatch);
});
test('unknown or missing values mean follow the system (null); known ids pass through', () => {
  for (const v of [null, undefined, '', 'bogus', 'SAGE', 'auto']) assert.equal(resolveTheme(v), null);
  for (const t of THEMES) assert.equal(resolveTheme(t.id), t.id);
  assert.equal(resolveTheme('linen'), 'linen', 'an old save means that theme in light mode');
});
test('a storage that throws loads null and saving does not throw', () => {
  const bad = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.equal(loadTheme(bad), null);
  assert.doesNotThrow(() => saveTheme(bad, 'linen-dark'));
  assert.equal(loadTheme(null), null);
});
test('the chip showing: the saved choice, else sage or sage-dark per the system', () => {
  assert.equal(shownTheme(null, false), 'sage');
  assert.equal(shownTheme(null, true), 'sage-dark');
  assert.equal(shownTheme('linen', true), 'linen');
  assert.equal(shownTheme('parchment-dark', false), 'parchment-dark');
});
test('a saved theme round-trips under vm-theme', () => {
  const m = new Map(); const s = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) };
  saveTheme(s, 'parchment-dark');
  assert.equal(m.get('vm-theme'), 'parchment-dark');
  assert.equal(loadTheme(s), 'parchment-dark');
  m.set('vm-theme', 'junk');
  assert.equal(loadTheme(s), null);
});
