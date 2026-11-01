import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../web/app.css', import.meta.url), 'utf8');
const IDS = ['sage', 'parchment', 'linen'];

const PAIRS = [
  ['fg','bg',4.5], ['fg','surface',4.5], ['fg','surface-2',4.5], ['fg','send-bg',4.5], ['fg','probe-bg',4.5], ['fg','dev-bg',4.5],
  ['muted','bg',4.5], ['muted','surface',4.5], ['muted','send-bg',4.5], ['muted','probe-bg',4.5], ['muted','dev-bg',4.5],
  ['link','bg',4.5], ['link','send-bg',4.5], ['link','probe-bg',4.5], ['link','dev-bg',4.5], ['link','surface',4.5],
  ['send-ink','send-bg',4.5], ['probe-ink','probe-bg',4.5], ['dev-ink','dev-bg',4.5], ['send-ink','surface',4.5], ['probe-ink','surface',4.5],
  ['on-accent','accent',4.5], ['muted','surface-2',4.5], ['muted','track',4.5],
  ['accent','bg',3], ['accent','send-bg',3], ['border','bg',3], ['border','surface',3],
  ['send-edge','bg',3], ['probe-edge','bg',3], ['dev-edge','bg',3], ['send-edge','send-bg',3], ['probe-edge','probe-bg',3], ['dev-edge','dev-bg',3],
  ['focus','bg',3], ['focus','surface',3], ['focus','send-bg',3], ['focus','probe-bg',3], ['accent','track',3], ['border','surface',3],
  ['ok','surface',4.5], ['work','surface',4.5], ['warn','surface',4.5], ['fail','surface',4.5],
  ['ok','ok-bg',4.5], ['work','work-bg',4.5], ['warn','warn-bg',4.5], ['fail','fail-bg',4.5], ['ok','track',3],
];
const TOKENS = [...new Set([...PAIRS.flat().filter((x) => typeof x === 'string'), 'cam-bg'])];

// The six token sets: three light ones at the top level, and each dark one as
// :root[data-theme="NAME-dark"]. The media block holds only the follow-the-system sage dark.
const mediaAt = css.indexOf('@media (prefers-color-scheme: dark)');
assert.ok(mediaAt > 0, 'dark media block present');
let depth = 0, end = -1;
for (let i = css.indexOf('{', mediaAt); i < css.length; i++) {
  if (css[i] === '{') depth++;
  else if (css[i] === '}' && --depth === 0) { end = i; break; }
}
const mediaCss = css.slice(mediaAt, end + 1);
const topCss = css.slice(0, mediaAt) + css.slice(end + 1);

function grab(scope, sel) {
  const m = new RegExp(`(?:^|[{}/])\\s*${sel}\\s*\\{([^}]*)\\}`).exec(scope);
  const out = {};
  if (!m) return out;
  for (const [, k, v] of m[1].matchAll(/--([\w-]+):\s*([^;]+);/g)) out[k] = v.trim();
  return out;
}
const lightSel = (id) => (id === 'sage' ? ':root,\\s*:root\\[data-theme="sage"\\]' : `:root\\[data-theme="${id}"\\]`);
const sets = [];
for (const id of IDS) {
  sets.push({ id, mode: 'light', p: grab(topCss, lightSel(id)) });
  sets.push({ id, mode: 'dark', p: grab(topCss, `:root\\[data-theme="${id}-dark"\\]`) });
}

const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test('every theme defines every token', () => {
  assert.equal(sets.length, 6);
  for (const { id, mode, p } of sets) {
    for (const t of TOKENS) assert.match(p[t] ?? '', /^#[0-9a-fA-F]{6}$/, `${id} ${mode} --${t}`);
  }
});

test('contrast pairs pass', () => {
  let checks = 0;
  for (const { id, mode, p } of sets) {
    for (const [f, b, need] of PAIRS) {
      const r = ratio(p[f], p[b]);
      assert.ok(r >= need, `${id} ${mode} ${f} on ${b}: ${r.toFixed(2)} < ${need}`);
      checks++;
    }
  }
  assert.equal(checks, 294);
});

test('frame surfaces stay black', () => {
  for (const { id, mode, p } of sets) assert.match(p['cam-bg'], /^#0{3}(0{3})?$/, `${id} ${mode} --cam-bg`);
  for (const sel of ['.stage', '.preview-box']) {
    const m = new RegExp(`${sel.replace('.', '\\.')}\\s*\\{([^}]*)\\}`).exec(css);
    assert.ok(m, sel);
    assert.match(m[1], /background:\s*#000\s*;/, sel);
  }
});

test('explicit choices win over the system media query', () => {
  // Following the system: only an unset data-theme matches inside the media block, so an explicit
  // light choice (data-theme="sage" etc.) is never overridden by prefers-color-scheme: dark.
  assert.match(mediaCss, /:root:not\(\[data-theme\]\)\s*\{/);
  assert.doesNotMatch(mediaCss, /:root\[data-theme/, 'no explicit-theme selector inside the media block');
  assert.doesNotMatch(mediaCss, /:root\s*\{/, 'no bare :root inside the media block');
  // The media sage dark is the same set as the explicit sage-dark.
  const follow = grab(mediaCss, ':root:not\\(\\[data-theme\\]\\)');
  const explicit = grab(topCss, ':root\\[data-theme="sage-dark"\\]');
  assert.deepEqual(follow, explicit);
  assert.ok(Object.keys(follow).length > 20);
  // The explicit dark selectors sit at the top level, so they apply without the media query.
  for (const id of IDS) assert.match(topCss, new RegExp(`:root\\[data-theme="${id}-dark"\\]\\s*\\{`));
});
