import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupChoices } from '../web/choices.js';
import { keepLastResult } from '../web/refine.js';
import { saveLastResult, refineOutcome } from '../src/optimize/refineloop.js';

const KEY = '1920x1080';
const s = (blockSize, parity, fps, white = 255) => ({ blockSize, parity, fps, white });

function memoryStorage() {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)) };
}

// A stub page: the menu, a phone report server and the Send page's settings.
function page({ hash = '#send', feedback = [] } = {}) {
  const listeners = {};
  const menu = {
    value: '', disabled: false, options: [], rebuilt: 0,
    replaceChildren(...opts) { this.options = opts; this.value = opts[0]?.value ?? ''; this.rebuilt++; },
    addEventListener(type, fn) { listeners[type] = fn; },
  };
  const applyListeners = {};
  const apply = { disabled: false, addEventListener(type, fn) { applyListeners[type] = fn; } };
  globalThis.document = {
    activeElement: null,
    getElementById: (id) => ({ 'settings-choice': menu, 'settings-apply': apply }[id] ?? null),
    createElement: () => ({ value: '', textContent: '' }),
  };
  globalThis.location = { hash };
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    const after = Number(/after=(\d+)/.exec(url)?.[1] ?? 0);
    const seq = feedback.length ? feedback.at(-1).seq : 0;
    return { ok: true, json: async () => ({ seq, entries: feedback.filter((e) => e.seq > after) }) };
  };
  let current = { ...s(30, 24, 8), levels: 2, scheme: 'cube' };
  const applied = [];
  const hooks = {
    getSettings: () => ({ ...current }),
    setSettings: (patch) => { applied.push(patch); current = { ...current, ...patch }; },
    displayPixels: () => ({ widthPx: 1920, heightPx: 1080 }),
  };
  const timers = [];
  const every = (fn, ms) => timers.push({ fn, ms });
  const clock = { ms: 0 };
  const now = () => clock.ms;
  // Picking a line in the menu only selects it; Apply sets it.
  const select = (id) => { menu.value = id; listeners.change?.(); };
  const press = () => applyListeners.click();
  const choose = (id) => { select(id); if (!apply.disabled) press(); };
  const focus = () => { globalThis.document.activeElement = menu; };
  const blur = () => { globalThis.document.activeElement = null; listeners.blur?.(); };
  const ids = () => menu.options.map((o) => o.value);
  const labels = () => menu.options.map((o) => o.textContent);
  return { menu, apply, press, hooks, applied, calls, timers, every, now, clock, select, choose, focus, blur, ids, labels, feedback,
    setCurrent(patch) { current = { ...current, ...patch }; } };
}

function cleanup() {
  delete globalThis.document;
  delete globalThis.location;
  delete globalThis.fetch;
}

const winnerResult = (c, mean) => ({ winner: c, ranked: [{ candidate: c, mean, readings: 4, alive: true }], tied: [], byConditions: null });
// A finished run as the Refine page has it: the result, what it means, and the scheme it ran on.
const finished = (result, how = 'done', on = { scheme: 'cube', levels: 2 }) => ({
  result, outcome: refineOutcome({ result, how, previous: s(30, 24, 8), markersSeen: true }), on,
});

test('choosing an entry sets block, parity, frame rate and white, and the menu shows Current again', () => {
  try {
    const storage = memoryStorage();
    saveLastResult(storage, KEY, winnerResult(s(25, 40, 12, 230), 30000), '2026-11-07');
    const p = page();
    setupChoices({ hooks: p.hooks, storage, screenKey: KEY, capture: false, every: p.every });
    assert.deepEqual(p.ids(), ['current', 'refine-winner', 'default']);
    assert.equal(p.menu.options[0].textContent, 'Current: block 30, parity 24, 8 fps');
    p.choose('refine-winner');
    assert.deepEqual(p.applied, [{ ...s(25, 40, 12, 230), scheme: 'cube', levels: 2 }]);
    assert.equal(p.menu.value, 'current');
    assert.equal(p.menu.options[0].textContent, 'Current: block 25, parity 40, 12 fps, white 230');
    // The chosen settings are now current, so they are not offered twice.
    assert.deepEqual(p.ids(), ['current', 'default']);
    p.choose('default');
    assert.deepEqual(p.applied[1], { blockSize: 23, parity: 32, fps: 10, white: 255, levels: 2, scheme: 'cube' });
    assert.equal(p.menu.value, 'current');
    // Choosing Current changes nothing.
    p.choose('current');
    assert.equal(p.applied.length, 2);
  } finally {
    cleanup();
  }
});

test('the menu is disabled while Refine runs', () => {
  try {
    const p = page();
    const menu = setupChoices({ hooks: p.hooks, storage: memoryStorage(), screenKey: KEY, capture: false, every: p.every });
    assert.equal(p.menu.disabled, false);
    menu.setBusy(true);
    assert.equal(p.menu.disabled, true);
    p.select('default');
    assert.equal(p.apply.disabled, true);
    p.press();
    assert.deepEqual(p.applied, [], 'nothing is applied while busy');
    assert.equal(p.menu.value, 'current');
    menu.redraw();
    assert.equal(p.menu.disabled, true, 'a redraw keeps it disabled');
    menu.setBusy(false);
    assert.equal(p.menu.disabled, false);
    // A control changed by hand: the redraw keeps Current true.
    p.hooks.setSettings({ blockSize: 40 });
    menu.redraw();
    assert.equal(p.menu.options[0].textContent, 'Current: block 40, parity 24, 8 fps');
  } finally {
    cleanup();
  }
});

test('a Refine result is kept and appears in the menu after a reload', () => {
  try {
    const storage = memoryStorage();
    const p = page();
    const menu = setupChoices({ hooks: p.hooks, storage, screenKey: KEY, capture: false, every: p.every });
    assert.deepEqual(p.ids(), ['current', 'default']);
    keepLastResult(storage, KEY, finished(winnerResult(s(27, 48, 10), 41000)), menu, '2026-11-07');
    assert.deepEqual(p.ids(), ['current', 'refine-winner', 'default'], 'shown at once');
    // A run with no winner leaves the last result alone.
    keepLastResult(storage, KEY, finished({ winner: null, leader: s(19, 16, 15), ranked: [], tied: [] }), menu, '2026-11-08');
    const again = page();
    setupChoices({ hooks: again.hooks, storage, screenKey: KEY, capture: false, every: again.every });
    assert.deepEqual(again.ids(), ['current', 'refine-winner', 'default']);
    assert.equal(again.menu.options[1].textContent, 'Fastest here - 41.0 KB/s (block 27, parity 48, 10 fps)');
    // Another screen size has its own.
    const other = page();
    setupChoices({ hooks: other.hooks, storage, screenKey: '1280x720', capture: false, every: other.every });
    assert.deepEqual(other.ids(), ['current', 'default']);
  } finally {
    cleanup();
  }
});

test('a Probe best the phone already held when the page loaded is not offered, and a new one ages from when it was first seen', async () => {
  try {
    const best = (blockSize, bytesPerSecond) => ({ blockSize, scheme: 'gray4', levels: 4, parity: 16, fps: 10, white: 255, bytesPerSecond });
    const p = page({ feedback: [{ seq: 1, probeBest: best(31, 15000) }] });
    const menu = setupChoices({ hooks: p.hooks, storage: memoryStorage(), screenKey: KEY, capture: true, every: p.every, now: p.now });
    await menu.ready;
    assert.equal(p.timers.length, 1);
    assert.equal(p.timers[0].ms, 2000);
    // The phone keeps reporting the best it held before the page loaded: never offered.
    p.feedback.push({ seq: 2, probeBest: best(31, 15000) });
    p.clock.ms = 2000;
    await p.timers[0].fn();
    assert.deepEqual(p.ids(), ['current', 'default'], 'the old best is not offered');
    // A Probe run after the page loaded gives a new best.
    p.feedback.push({ seq: 3, probeBest: null }, { seq: 4, probeBest: best(35, 12000) }, { seq: 5, probeBest: null });
    p.clock.ms = 4000;
    await p.timers[0].fn();
    assert.deepEqual(p.ids(), ['current', 'probe', 'default']);
    assert.equal(p.menu.options[1].textContent, "Probe's best - 12.0 KB/s, just now (block 35, parity 16, 10 fps, 4 shades of gray)");
    // Reported again and again, it still ages from when this page first saw it.
    p.feedback.push({ seq: 6, probeBest: best(35, 12000) });
    p.clock.ms = 4000 + 3 * 60000;
    await p.timers[0].fn();
    assert.equal(p.menu.options[1].textContent, "Probe's best - 12.0 KB/s, 3 min ago (block 35, parity 16, 10 fps, 4 shades of gray)");
    p.choose('probe');
    assert.deepEqual(p.applied, [{ blockSize: 35, parity: 16, fps: 10, white: 255, levels: 4, scheme: 'gray4' }]);
    // On the Receive tab nothing is polled.
    const before = p.calls.length;
    globalThis.location.hash = '#receive';
    await p.timers[0].fn();
    assert.equal(p.calls.length, before);
  } finally {
    cleanup();
  }
});

test('with nothing buffered, the first best the phone reports after the page loaded is the one it already held', async () => {
  try {
    const best = { blockSize: 31, scheme: 'cube', levels: 2, parity: 16, fps: 10, white: 255, bytesPerSecond: 15000 };
    const p = page();
    const menu = setupChoices({ hooks: p.hooks, storage: memoryStorage(), screenKey: KEY, capture: true, every: p.every, now: p.now });
    await menu.ready;
    p.feedback.push({ seq: 1, probeBest: best }, { seq: 2, probeBest: best });
    await p.timers[0].fn();
    assert.deepEqual(p.ids(), ['current', 'default']);
    p.feedback.push({ seq: 3, probeBest: { ...best, blockSize: 33, bytesPerSecond: 14000 } });
    await p.timers[0].fn();
    assert.deepEqual(p.ids(), ['current', 'probe', 'default']);
  } finally {
    cleanup();
  }
});

test('a Refine run on another scheme keeps it: no entry repeats Current, and choosing it sets scheme and levels', () => {
  try {
    const storage = memoryStorage();
    const p = page();
    p.setCurrent({ ...s(23, 40, 12), scheme: 'g4', levels: 4 });
    const menu = setupChoices({ hooks: p.hooks, storage, screenKey: KEY, capture: false, every: p.every });
    keepLastResult(storage, KEY, finished(winnerResult(s(23, 40, 12), 37400), 'done', { scheme: 'g4', levels: 4 }), menu, '2026-11-07');
    assert.deepEqual(p.ids(), ['current', 'default'], 'the winner is what is set now');
    assert.equal(p.labels()[0], 'Current: block 23, parity 40, 12 fps, Green 4, red and blue 2');
    p.choose('default');
    assert.deepEqual(p.ids(), ['current', 'refine-winner']);
    assert.equal(p.labels()[1], 'Fastest here - 37.4 KB/s (block 23, parity 40, 12 fps, Green 4, red and blue 2)');
    p.choose('refine-winner');
    assert.deepEqual(p.applied.at(-1), { ...s(23, 40, 12), scheme: 'g4', levels: 4 });
  } finally {
    cleanup();
  }
});

test('a Refine run stopped with Escape, or with only a provisional winner, keeps the earlier result', () => {
  try {
    const storage = memoryStorage();
    const p = page();
    const menu = setupChoices({ hooks: p.hooks, storage, screenKey: KEY, capture: false, every: p.every });
    keepLastResult(storage, KEY, finished(winnerResult(s(27, 48, 10), 41000)), menu, '2026-11-07');
    const label = p.labels()[1];
    keepLastResult(storage, KEY, finished(winnerResult(s(19, 16, 15), 50000), 'stopped'), menu, '2026-11-08');
    assert.equal(p.labels()[1], label, 'a stopped run saves nothing');
    keepLastResult(storage, KEY, finished(winnerResult(s(19, 16, 15), 50000), 'away'), menu, '2026-11-08');
    assert.equal(p.labels()[1], label, 'a provisional winner is not saved');
    keepLastResult(storage, KEY, finished({ ...winnerResult(s(19, 16, 15), 50000), provisional: true }), menu, '2026-11-08');
    assert.equal(p.labels()[1], label, 'a provisional winner is not saved');
  } finally {
    cleanup();
  }
});

test('picking a line only selects it; Apply sets it, so arrowing through the menu sets nothing', () => {
  try {
    const p = page();
    setupChoices({ hooks: p.hooks, storage: memoryStorage(), screenKey: KEY, capture: false, every: p.every });
    assert.equal(p.apply.disabled, true, 'nothing to apply while Current is shown');
    p.select('default');
    assert.deepEqual(p.applied, []);
    assert.equal(p.apply.disabled, false);
    p.select('current');
    assert.equal(p.apply.disabled, true);
    p.choose('default');
    assert.equal(p.applied.length, 1);
    assert.equal(p.menu.value, 'current');
  } finally {
    cleanup();
  }
});

test('the menu is not rebuilt while it has focus, and is rebuilt when it loses it', async () => {
  try {
    const best = { blockSize: 31, scheme: 'cube', levels: 2, parity: 16, fps: 10, white: 255, bytesPerSecond: 15000 };
    const p = page({ feedback: [{ seq: 1, probeBest: null }] });
    const menu = setupChoices({ hooks: p.hooks, storage: memoryStorage(), screenKey: KEY, capture: true, every: p.every, now: p.now });
    await menu.ready;
    p.focus();
    p.select('default');
    const rebuilt = p.menu.rebuilt;
    p.feedback.push({ seq: 2, probeBest: best });
    await p.timers[0].fn();
    assert.equal(p.menu.rebuilt, rebuilt, 'left alone while focused');
    assert.equal(p.menu.value, 'default');
    p.blur();
    assert.deepEqual(p.ids(), ['current', 'probe', 'default']);
    assert.equal(p.menu.value, 'default', 'the line picked stays picked when its words are unchanged');
  } finally {
    cleanup();
  }
});

test('with no capture server nothing is polled and the menu still offers Current and Safe default', async () => {
  try {
    const p = page({ feedback: [{ seq: 1, probeBest: { blockSize: 31, scheme: 'cube', levels: 2, parity: 16, fps: 10, white: 255, bytesPerSecond: 15000 } }] });
    const menu = setupChoices({ hooks: p.hooks, storage: null, screenKey: KEY, capture: false, every: p.every });
    await menu.ready;
    assert.equal(p.timers.length, 0);
    assert.equal(p.calls.length, 0);
    assert.deepEqual(p.ids(), ['current', 'default']);
    assert.equal(p.menu.options[1].textContent, 'Safe default (block 23, parity 32, 10 fps)');
  } finally {
    cleanup();
  }
});
