import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupTimedRuns } from '../web/timedruns.js';

const TX_ID = 77; // one stream: both settings send the same transmission id

function el(tag = 'div') {
  const e = {
    tag, children: [], textContent: '', value: '', hidden: true, disabled: false, listeners: {},
    classList: { add() {}, remove() {} },
    appendChild(c) { this.children.push(c); return c; },
    replaceChildren(...c) { this.children = c; },
    addEventListener(type, fn) { this.listeners[type] = fn; },
    blur() {},
    createTHead() { return this.appendChild(el('thead')); },
    createTBody() { return this.appendChild(el('tbody')); },
    insertRow() { return this.appendChild(el('tr')); },
    insertCell() { return this.appendChild(el('td')); },
  };
  return e;
}
const textOf = (e) => [e.textContent, ...e.children.map(textOf)].filter(Boolean).join(' ');

/**
 * A stub Send page, project server, stage and phone on a fake clock. The phone
 * posts one report per poll of /feedback. As a real phone does, a report carries
 * the collector as it was before the server's reply, and the phone follows a new
 * reset from that reply, so the first report after a reset still shows the old run.
 * It collects only while frames are up and it is not away, and completes a run
 * after `reportsToComplete` reports.
 */
function harness({ count = 3, other = null, cannotHold = null, stuck = () => false, awayFrom = Infinity, closeAfterShows = Infinity, reportsToComplete = 3,
  awayDuring = null, offAimDuring = null, awayBlack = null, dropReset = () => false, frames = 4 } = {}) {
  const clock = { ms: 1000 };
  const realNow = performance.now;
  performance.now = () => clock.ms;
  const sleep = async (ms) => { clock.ms += ms; };

  const ids = new Map();
  const get = (id) => { if (!ids.has(id)) ids.set(id, el()); return ids.get(id); };
  globalThis.document = { getElementById: get, createElement: (tag) => el(tag) };
  globalThis.location = { hash: '#send' };
  get('timed-count').value = String(count);

  // The server.
  const session = { resetSeq: 0, resetPosts: 0, refine: [] };
  const log = [];
  const debug = [];
  // The phone.
  const phone = { seen: 0, collector: { txId: null, count: 0, have: 0, complete: false, elapsedMs: 0 }, staleCompletes: 0, reports: 0 };
  // The stage.
  const stage = { open: false, showing: null, shows: [], blacks: 0, notes: [], blackTexts: [] };
  let empty = true; // the phone's collector holds nothing yet since its last reset
  // awayDuring and offAimDuring: { run, from, reports } - for that many reports,
  // from the given report of that run's frames, the phone is away or sees no markers.
  let runReports = 0;
  let shownCount = 0;
  const during = (spell, run) => Boolean(spell) && run === spell.run && stage.showing && runReports >= spell.from && runReports < spell.from + spell.reports;
  let noMarkersStreak = 0;
  let blackReports = 0;

  const report = () => {
    phone.reports++;
    const run = stage.shows.length - 1;
    if (stage.shows.length !== shownCount) { shownCount = stage.shows.length; runReports = 0; }
    if (stage.showing) runReports++;
    if (awayBlack && !stage.showing && stage.shows.length === awayBlack.before) blackReports++;
    const awayOnBlack = Boolean(awayBlack) && !stage.showing && stage.shows.length === awayBlack.before && blackReports <= awayBlack.reports;
    const away = stage.shows.length >= awayFrom || during(awayDuring, run) || awayOnBlack;
    const offAim = during(offAimDuring, run);
    noMarkersStreak = offAim ? noMarkersStreak + 5 : 0;
    // Collect from what is on screen, before posting.
    if (!away && !offAim && stage.showing && !phone.collector.complete && !(stuck(run) && phone.collector.have >= 2)) {
      const have = phone.collector.have + 1;
      phone.collector = { txId: stage.showing.txId, count: reportsToComplete, have, complete: have >= reportsToComplete, elapsedMs: 10000 + 1000 * run };
      empty = false;
    }
    const collector = { ...phone.collector };
    if (collector.complete && phone.seen < session.resetSeq) phone.staleCompletes++;
    log.push({ seq: log.length + 1, health: { visible: !away, camera: 'running', noMarkersStreak }, collector });
    // The reply.
    if (session.resetSeq !== phone.seen) {
      phone.seen = session.resetSeq;
      phone.collector = { txId: null, count: 0, have: 0, complete: false, elapsedMs: 0 };
      empty = true;
    }
  };

  globalThis.fetch = async (url, opts = {}) => {
    if (url === '/session') {
      const patch = JSON.parse(opts.body);
      if (patch.reset === true && !dropReset(++session.resetPosts)) session.resetSeq++;
      if ('refine' in patch) session.refine.push({ ...patch.refine, atMs: clock.ms });
      return { ok: true, json: async () => ({}) };
    }
    if (url === '/debug') {
      debug.push(JSON.parse(opts.body));
      return { ok: true };
    }
    if (url.startsWith('/feedback')) {
      const after = Number(/after=(\d+)/.exec(url)[1]);
      if (after > 0 || log.length === 0) report();
      return { ok: true, json: async () => ({ seq: log.length, entries: log.filter((e) => e.seq > after) }) };
    }
    throw new Error(`unexpected ${url}`);
  };

  const fakeStage = {
    openStage: async () => { stage.open = true; return { ctx: true }; },
    showLoop: (_ctx, { tx }) => {
      stage.showing = tx;
      stage.shows.push(tx);
      if (stage.shows.length > closeAfterShows) fakeStage.closeStage();
    },
    showBlack: (_ctx, text = '') => { stage.showing = null; stage.blacks++; stage.blackTexts.push(text); },
    closeStage: () => { stage.open = false; stage.showing = null; },
    isStageOpen: () => stage.open,
    stageRefused: () => false,
    setStageNote(text) {
      if (stage.throwOnNote) throw new Error('boom');
      stage.notes.push(text);
    },
  };

  const base = { blockSize: 30, levels: 2, scheme: 'cube', parity: 24, fps: 8, white: 255, fountain: true };
  const applied = [];
  const built = [];
  const hooks = {
    getSettings: () => ({ ...base }),
    setSettings: (patch) => applied.push(patch),
    displayPixels: () => ({ widthPx: 1920, heightPx: 1080 }),
    streamBytes: () => 120000,
    buildTransmission: (settings) => {
      built.push(settings);
      if (cannotHold && settings.blockSize === cannotHold) return { problem: 'Too large for these settings' };
      return { tx: { txId: TX_ID, blockSize: settings.blockSize, K: 40 * frames, packetsPerFrame: 40, sourceFrames: frames }, layout: { cols: 10, rows: 10 }, settings };
    },
  };
  let entries = [
    { id: 'current', label: 'Current: block 30, parity 24, 8 fps', settings: { blockSize: 30, parity: 24, fps: 8, white: 255 } },
    ...(other ? [{ id: 'probe', label: "Probe's best (block 40)", settings: other }] : []),
  ];
  const writes = [];
  const storage = { getItem: () => null, setItem: (k, v) => writes.push([k, v]) };
  const api = setupTimedRuns({ hooks, capture: true, storage, screenKey: '1920x1080', menu: { entries: () => entries }, stage: fakeStage, sleep });
  if (other) get('timed-other').value = 'probe';

  const result = () => debug.find((d) => d.event === 'timed' && d.kind === 'result');
  const cleanup = () => {
    performance.now = realNow;
    delete globalThis.document;
    delete globalThis.location;
    delete globalThis.fetch;
  };
  const setEntries = (next) => { entries = next; };
  return { api, get, stage, session, setEntries, clock, phone, debug, result, applied, built, writes, base, hooks, cleanup, report: () => textOf(get('timed-report')), status: () => get('timed-status').textContent };
}

test('a series alternates A and B and reports each time from the phone\'s elapsed time', async () => {
  const h = harness({ count: 3, other: { blockSize: 40, parity: 16, fps: 10, white: 230 } });
  try {
    await h.api.run();
    const { runs, summary } = h.result();
    assert.deepEqual(runs.map((r) => r.which), ['a', 'b', 'a', 'b', 'a', 'b']);
    assert.deepEqual(runs.map((r) => r.ms), [10000, 11000, 12000, 13000, 14000, 15000]);
    assert.deepEqual(h.stage.shows.map((t) => t.blockSize), [30, 40, 30, 40, 30, 40], 'B is A with the entry\'s settings');
    assert.deepEqual(summary.a.times, [10000, 12000, 14000]);
    assert.equal(summary.b.mean, 13000);
    assert.equal(h.stage.open, false, 'the stage closes at the end');
    assert.ok(h.stage.blacks >= 6, 'black between runs');
    assert.match(h.report(), /12\.0/, 'A\'s mean, in seconds');
    assert.match(h.report(), /10\.0 KB\/s/, '120000 bytes over 12 s');
    assert.match(h.status(), /6 of 6/);
  } finally {
    h.cleanup();
  }
});

test('a late complete from the previous run is not counted', async () => {
  const h = harness({ count: 3 });
  try {
    await h.api.run();
    assert.ok(h.phone.staleCompletes >= 2, 'the phone did report the old run complete after a reset');
    // Same transmission id each run: only the empty report first tells them apart.
    assert.deepEqual(h.result().runs.map((r) => r.ms), [10000, 11000, 12000]);
  } finally {
    h.cleanup();
  }
});

test('a run with no new pieces for 30 s fails and the series goes on', async () => {
  const h = harness({ count: 3, stuck: (run) => run === 0 });
  try {
    await h.api.run();
    const { runs } = h.result();
    assert.equal(runs.length, 3);
    assert.equal(runs[0].ms, null);
    assert.match(runs[0].failed, /No new pieces for 30 s/);
    assert.deepEqual(runs.slice(1).map((r) => r.ms), [11000, 12000]);
    assert.match(h.report(), /No new pieces for 30 s/);
  } finally {
    h.cleanup();
  }
});

test('a phone away for 30 s stops the series with the runs so far', async () => {
  const h = harness({ count: 5, awayFrom: 2 });
  try {
    const started = performance.now();
    await h.api.run();
    const r = h.result();
    assert.deepEqual(r.runs.map((x) => x.ms), [10000], 'the run in progress is not counted');
    assert.match(r.stopped, /background/);
    assert.match(h.status(), /stopped/i);
    assert.match(h.status(), /background/);
    assert.equal(h.stage.open, false);
    assert.ok(performance.now() - started < 120000, 'no hang');
  } finally {
    h.cleanup();
  }
});

test('B whose frame cannot hold the data fails its runs with the reason, and A\'s still run', async () => {
  const h = harness({ count: 3, other: { blockSize: 99, parity: 16, fps: 10, white: 230 }, cannotHold: 99 });
  try {
    await h.api.run();
    const { runs } = h.result();
    assert.deepEqual(runs.map((r) => r.which), ['a', 'b', 'a', 'b', 'a', 'b']);
    assert.deepEqual(runs.filter((r) => r.which === 'a').map((r) => r.ms), [10000, 11000, 12000]);
    for (const r of runs.filter((x) => x.which === 'b')) assert.equal(r.failed, 'Too large for these settings');
    assert.deepEqual(h.stage.shows.map((t) => t.blockSize), [30, 30, 30], 'B shows nothing');
  } finally {
    h.cleanup();
  }
});

test('A whose frame cannot hold the data does not start', async () => {
  const h = harness({ count: 3 });
  try {
    h.hooks.buildTransmission = () => ({ problem: 'Too large for these settings' });
    await h.api.run();
    assert.equal(h.stage.shows.length, 0);
    assert.equal(h.stage.open, false);
    assert.match(h.status(), /Too large for these settings/);
  } finally {
    h.cleanup();
  }
});

test('Escape stops the series and keeps the runs finished', async () => {
  const h = harness({ count: 5, closeAfterShows: 1 }); // closed as the second run's frames go up
  try {
    await h.api.run();
    assert.deepEqual(h.result().runs.map((r) => r.ms), [10000]);
    assert.match(h.status(), /Escape/);
  } finally {
    h.cleanup();
  }
});

test('nothing changes the Send page settings', async () => {
  const h = harness({ count: 3, other: { blockSize: 40, parity: 16, fps: 10, white: 230 } });
  try {
    await h.api.run();
    assert.deepEqual(h.applied, []);
    assert.ok(h.writes.every(([k]) => k.startsWith('visual-modem:timed:')), 'only the timed list is stored');
    assert.deepEqual(h.hooks.getSettings(), h.base);
    assert.equal(h.result().runs.length, 6);
  } finally {
    h.cleanup();
  }
});

test('Compare with offers Nothing and the Choose settings lines other than Current', () => {
  const h = harness({ count: 3, other: { blockSize: 40, parity: 16, fps: 10, white: 230 } });
  try {
    const options = h.get('timed-other').children;
    assert.deepEqual(options.map((o) => o.value), ['none', 'probe']);
    assert.deepEqual(options.map((o) => o.textContent), ['Nothing', "Probe's best (block 40)"]);
    assert.equal(h.get('grp-dev').hidden, true, 'the panel itself is shown by the capture check');
  } finally {
    h.cleanup();
  }
});

test('a run during which the phone was away for 10 s is not timed and stays out of the summary', async () => {
  const h = harness({ count: 3, reportsToComplete: 6, awayDuring: { run: 1, from: 2, reports: 50 } });
  try {
    await h.api.run();
    const { runs, summary } = h.result();
    assert.equal(runs.length, 3);
    assert.equal(runs[1].ms, null);
    assert.match(runs[1].failed, /away for 1\d s during the run/);
    assert.match(runs[1].failed, /background/);
    assert.deepEqual(summary.a.times, [10000, 12000]);
    assert.match(h.report(), /not timed/);
  } finally {
    h.cleanup();
  }
});

test('a run during which the phone lost the markers is not timed', async () => {
  const h = harness({ count: 3, reportsToComplete: 6, offAimDuring: { run: 2, from: 2, reports: 10 } });
  try {
    await h.api.run();
    const { runs, summary } = h.result();
    assert.equal(runs[2].ms, null);
    assert.match(runs[2].failed, /no markers/);
    assert.match(h.report(), /Run 3, A, not timed: /);
    assert.deepEqual(summary.a.times, [10000, 11000]);
  } finally {
    h.cleanup();
  }
});

test('the phone is told a series is running, run by run, and told when it ends', async () => {
  const h = harness({ count: 2 });
  try {
    await h.api.run();
    const said = h.session.refine;
    assert.ok(said.some((r) => r.active === true && r.word === 'Timed run 1 of 2, A'));
    assert.ok(said.some((r) => r.active === true && r.word === 'Timed run 2 of 2, A'));
    const last = said.at(-1);
    assert.equal(last.active, false);
    assert.match(last.word, /Timed runs done/);
    assert.equal(new Set(said.map((r) => r.seq)).size, said.length, 'each word is news to the phone');
  } finally {
    h.cleanup();
  }
});

test('a long run keeps telling the phone it is running', async () => {
  const h = harness({ count: 1, stuck: () => true }); // stalls for 30 s, then fails
  try {
    await h.api.run();
    const active = h.session.refine.filter((r) => r.active);
    const gaps = active.slice(1).map((r, i) => r.atMs - active[i].atMs);
    assert.ok(active.length >= 3);
    assert.ok(Math.max(...gaps) <= 15000, `gaps ${gaps}`);
  } finally {
    h.cleanup();
  }
});

test('the phone is told the series stopped when Escape ends it', async () => {
  const h = harness({ count: 5, closeAfterShows: 1 });
  try {
    await h.api.run();
    const last = h.session.refine.at(-1);
    assert.equal(last.active, false);
    assert.match(last.word, /stopped/);
  } finally {
    h.cleanup();
  }
});

test('the phone is told the series stopped when the series throws', async () => {
  const h = harness({ count: 2 });
  try {
    h.stage.throwOnNote = true;
    await h.api.run();
    assert.match(h.status(), /stopped: boom/);
    const last = h.session.refine.at(-1);
    assert.equal(last.active, false);
    assert.match(last.word, /stopped/);
  } finally {
    h.cleanup();
  }
});

test('the stage says why a run waits: phone away, and no new pieces', async () => {
  const h = harness({ count: 2, stuck: (run) => run === 1, awayDuring: { run: 0, from: 1, reports: 15 } });
  try {
    await h.api.run();
    assert.ok(h.stage.notes.some((n) => /Timed run 1 of 2, A is waiting\. The Receive page is in the background/.test(n)), h.stage.notes.join(' | '));
    assert.ok(h.stage.notes.some((n) => /Timed run 2 of 2, A: no new pieces for \d+ s/.test(n)), h.stage.notes.join(' | '));
  } finally {
    h.cleanup();
  }
});

test('the black wait screen says why the phone has not started fresh', async () => {
  const h = harness({ count: 2, awayBlack: { before: 1, reports: 15 } }); // away while run 2 waits on black
  try {
    await h.api.run();
    assert.ok(h.stage.blackTexts.some((t) => /Timed run 2 of 2, A: waiting for the phone to start fresh\. The Receive page is in the background/.test(t)), h.stage.blackTexts.join(' | '));
  } finally {
    h.cleanup();
  }
});

test('a transfer that fits in one frame does not start, and says what to do', async () => {
  const h = harness({ count: 3, frames: 1 });
  try {
    await h.api.run();
    assert.equal(h.stage.open, false);
    assert.equal(h.stage.shows.length, 0);
    assert.match(h.status(), /one frame/);
    assert.match(h.status(), /larger file or a longer message/);
  } finally {
    h.cleanup();
  }
});

test('a transfer of two frames is timed', async () => {
  const h = harness({ count: 1, frames: 2 });
  try {
    await h.api.run();
    assert.deepEqual(h.result().runs.map((r) => r.ms), [10000]);
  } finally {
    h.cleanup();
  }
});

test('Compare with keeps its pick when the line\'s words change with age', () => {
  const h = harness({ count: 3, other: { blockSize: 40, parity: 16, fps: 10, white: 230 } });
  try {
    const other = { blockSize: 40, parity: 16, fps: 10, white: 230 };
    h.setEntries([
      { id: 'current', label: 'Current: block 30, parity 24, 8 fps', settings: { blockSize: 30, parity: 24, fps: 8, white: 255 } },
      { id: 'probe', label: "Probe's best - 9.0 KB/s, 4 min ago (block 40)", settings: other },
    ]);
    h.get('timed-other').listeners.focus();
    assert.equal(h.get('timed-other').value, 'probe');
  } finally {
    h.cleanup();
  }
});

test('Compare with drops its pick when the line now holds other settings', () => {
  const h = harness({ count: 3, other: { blockSize: 40, parity: 16, fps: 10, white: 230 } });
  try {
    h.setEntries([
      { id: 'current', label: 'Current: block 30, parity 24, 8 fps', settings: { blockSize: 30, parity: 24, fps: 8, white: 255 } },
      { id: 'probe', label: "Probe's best (block 36)", settings: { blockSize: 36, parity: 16, fps: 10, white: 230 } },
    ]);
    h.get('timed-other').listeners.focus();
    assert.equal(h.get('timed-other').value, 'none');
  } finally {
    h.cleanup();
  }
});

test('a lost request to start fresh is sent again, and the run goes ahead', async () => {
  const h = harness({ count: 2, dropReset: (n) => n === 2 }) // the second run's first request;
  try {
    await h.api.run();
    assert.deepEqual(h.result().runs.map((r) => r.ms), [10000, 11000]);
  } finally {
    h.cleanup();
  }
});

test('a phone that reports but never starts fresh fails the run with that reason', async () => {
  const h = harness({ count: 2, dropReset: (n) => n >= 2 });
  try {
    await h.api.run();
    const { runs } = h.result();
    assert.equal(runs[0].ms, 10000);
    assert.match(runs[1].failed, /reported but did not start fresh within 10 s/);
    assert.match(runs[1].failed, /out of date/);
  } finally {
    h.cleanup();
  }
});

test('the verdict names the faster setting', async () => {
  const h = harness({ count: 3, other: { blockSize: 40, parity: 16, fps: 10, white: 230 } });
  try {
    await h.api.run();
    // A: 10, 12, 14 s; B: 11, 13, 15 s. Too close to call; the report still gives the ratio.
    assert.match(h.report(), /do not differ beyond the noise \(95%\)/);
    assert.match(h.report(), /B took \d+% more time than A/);
  } finally {
    h.cleanup();
  }
});

test('a finished series keeps each timed setting and its mean time for the menus', async () => {
  const h = harness({ count: 3, other: { blockSize: 40, parity: 16, fps: 10, white: 230 } });
  try {
    await h.api.run();
    const stored = h.writes.filter(([k]) => k === 'visual-modem:timed:1920x1080');
    assert.equal(stored.length, 1);
    const list = JSON.parse(stored[0][1]);
    assert.deepEqual(list.map((t) => [t.settings.blockSize, t.mean, t.runs]), [[30, 12000, 3], [40, 13000, 3]]);
    assert.match(list[0].savedOn, /^\d{4}-\d{2}-\d{2}$/);
  } finally {
    h.cleanup();
  }
});

test('Compare with keeps its pick when the same settings move to another line', () => {
  const h = harness({ count: 3, other: { blockSize: 40, parity: 16, fps: 10, white: 230 } });
  try {
    const other = { blockSize: 40, parity: 16, fps: 10, white: 230 };
    h.setEntries([
      { id: 'current', label: 'Current: block 30, parity 24, 8 fps', settings: { blockSize: 30, parity: 24, fps: 8, white: 255 } },
      { id: 'timed-0', label: 'Timed - 5.3 s over 10 runs (block 40)', settings: other },
    ]);
    h.get('timed-other').listeners.focus();
    assert.equal(h.get('timed-other').value, 'timed-0');
  } finally {
    h.cleanup();
  }
});
