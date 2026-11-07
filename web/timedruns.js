// Timed runs on the sender: sends the current message or file by light again
// and again, as Start does, and times each transfer with the phone's own clock,
// from its first piece to the last. With a setting to compare, the runs
// alternate between the Send page settings (A) and that setting (B). The phone
// starts fresh before each run; only its progress comes back over the network.
// While a series runs the phone is told so, as Refine does: it keeps its screen
// awake and shows which run is on.
// The order and the summary come from src/optimize/timedruns.js. Needs the
// server with --capture. Nothing here changes the Send page settings.
import { runOrder, summarise, saveTimed, RUN_LIMIT_MS, STALL_MS } from '../src/optimize/timedruns.js';
import { phoneAwayReason } from '../src/optimize/refineloop.js';
import { setStatus } from './status.js';
import { announce, createPoller, post, today } from './tune.js';
import { choicesFor } from './choices.js';
import { createWakeLock } from './wakelock.js';
import * as stageModule from './stage.js';

const POLL_MS = 200;
const FRESH_MS = 10000; // how long a run waits for the phone to report an empty collection
const ASK_AGAIN_MS = 2000; // the request to start fresh is sent again this often while waiting
const AWAY_STOP_MS = 30000; // a phone away this long stops the series
const QUIET_NOTE_MS = 5000; // the stage says so once no new pieces came for this long
const OFF_AIM_READS = 10; // camera reads in a row with no markers: the phone lost the screen
const PHONE_WORD_MS = 10000; // the phone's run word is renewed this often, well inside its 60 s lapse
const NO_OTHER = 'none';
const $ = (id) => document.getElementById(id);
const sleepReal = (ms) => new Promise((done) => setTimeout(done, ms));

const isEmpty = (c) => c.txId === null || c.txId === undefined || !(c.count > 0);
// Pieces for version 4 (distinct ones seen), frames for version 3.
const progressOf = (c) => (Number.isFinite(c.fresh) ? c.fresh : c.have);
const seconds = (ms) => (ms / 1000).toFixed(1);
const NAMES = { a: 'A', b: 'B' };
// The transfer's frames before it repeats; one frame is read at once and gives no time.
const framesOf = (tx) => tx.sourceFrames ?? tx.count;
const ONE_FRAME = 'The transfer fits in one frame at these settings, so the phone reads it at once and there is no time to measure';
const settingsKey = (c) => JSON.stringify(c.settings);

/**
 * The word the phone shows while a series runs, sent the way Refine sends its
 * own. Each word gets a new seq, so the phone takes it as news. The seq starts
 * from the clock so it never repeats one a Refine run on this page has used.
 */
function phoneWord() {
  let seq = Date.now();
  let told = false;
  let ended = false;
  return {
    say(word) {
      told = true;
      return announce({ refine: { seq: ++seq, active: true, word, kind: 'work' } });
    },
    async end(word, kind) {
      if (!told || ended) return;
      ended = true;
      await announce({ refine: { seq: ++seq, active: false, word, kind } });
    },
  };
}

/**
 * Sets up Timed runs in the Measure panel when the server runs with --capture.
 * @param {{ hooks: { getSettings: () => object, displayPixels: () => object,
 *     buildTransmission: (settings: object, pixels: object) => ({ tx: object, layout: object, settings: object } | { problem: string }),
 *     streamBytes: () => number },
 *   capture: boolean, storage: Storage | null, screenKey: string | (() => string),
 *   menu?: { entries: () => Array<{ id: string, label: string, settings: object }> } | null,
 *   stage?: object, sleep?: (ms: number) => Promise<void> }} p menu is the Choose settings menu, whose lines other than
 *   Current are offered to compare with; stage and sleep stand in for the real ones in tests
 * @returns {{ run: () => Promise<void> } | undefined}
 */
export function setupTimedRuns({ hooks, capture, storage, screenKey, menu = null, stage = stageModule, sleep = sleepReal }) {
  if (!capture) return undefined;
  const keyOf = () => (typeof screenKey === 'function' ? screenKey() : screenKey);
  const entries = () => (menu ? menu.entries() : choicesFor({ hooks, storage, screenKey: keyOf() }));
  const otherSelect = $('timed-other');
  const button = $('timed');
  const statusEl = $('timed-status');
  let offered = []; // the lines in Compare with, as they were when last filled
  let running = false;

  // Refilled when it gets focus, so it holds the menu's lines as they are now.
  // The line picked stays picked while a line with the same settings is there,
  // even when its words or its place in the list change.
  const fill = () => {
    const was = offered.find((c) => c.id === otherSelect.value);
    offered = entries().filter((c) => c.id !== 'current');
    const option = (value, label) => {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = label;
      return o;
    };
    otherSelect.replaceChildren(option(NO_OTHER, 'Nothing'), ...offered.map((c) => option(c.id, c.label)));
    otherSelect.value = (was && offered.find((c) => settingsKey(c) === settingsKey(was))?.id) ?? NO_OTHER;
  };
  fill();
  otherSelect.addEventListener('focus', fill);

  async function run() {
    button.blur?.();
    if (running || stage.isStageOpen()) return;
    running = true;
    button.disabled = true;
    const computerAwake = createWakeLock();
    computerAwake.sync(true);
    const phone = phoneWord();
    try {
      await series({ hooks, stage, sleep, statusEl, phone, keep: { storage, screenKey: keyOf(), menu }, current: entries()[0], other: offered.find((c) => c.id === otherSelect.value) ?? null });
    } catch (err) {
      stage.closeStage();
      setStatus(statusEl, 'fail', `Timed runs stopped: ${err.message || err}`);
      post('timed', { kind: 'error', message: String(err.message || err) });
    } finally {
      await phone.end('Timed runs stopped', 'warn'); // only when the series ended without saying so
      running = false;
      button.disabled = false;
      computerAwake.sync(false);
      fill();
    }
  }
  button.addEventListener('click', run);
  return { run };
}

async function series({ hooks, stage, sleep, statusEl, phone, keep, current, other }) {
  const count = Number($('timed-count').value);
  const pixels = hooks.displayPixels();
  const base = hooks.getSettings();
  const streamBytes = hooks.streamBytes();
  const report = $('timed-report');
  report.replaceChildren();
  if (!(streamBytes > 0)) {
    setStatus(statusEl, 'fail', 'Nothing to send. Type a message or choose a file first.');
    return;
  }
  const builds = { a: hooks.buildTransmission({ ...base }, pixels) };
  if (!builds.a.problem && framesOf(builds.a.tx) <= 1) builds.a = { problem: `${ONE_FRAME}. Choose a larger file or a longer message` };
  if (builds.a.problem) {
    setStatus(statusEl, 'fail', `Timed runs did not start: ${builds.a.problem}.`);
    return;
  }
  if (other) builds.b = hooks.buildTransmission({ ...base, ...other.settings }, pixels);
  if (builds.b && !builds.b.problem && framesOf(builds.b.tx) <= 1) builds.b = { problem: ONE_FRAME };
  const labels = { a: current?.label ?? 'Current settings', b: other?.label ?? null };
  const order = runOrder(count, Boolean(other));
  setStatus(statusEl, 'work', 'Timed runs: starting');
  const ctx = await stage.openStage(pixels);
  if (!ctx) {
    setStatus(statusEl, stage.stageRefused() ? 'fail' : 'warn', stage.stageRefused() ? 'The browser refused full screen' : 'Timed runs stopped before the first run.');
    return;
  }
  const poller = createPoller();
  await poller.skipOld();
  post('timed', { kind: 'start', count, a: builds.a.settings, b: builds.b?.settings ?? null, labels, streamBytes, ...pixels });

  const runs = [];
  const away = { ms: 0 };
  let stopped = null;
  for (let i = 0; i < order.length; i++) {
    if (!stage.isStageOpen()) {
      stopped = 'escape';
      break;
    }
    const which = order[i];
    const built = builds[which];
    const name = `Timed run ${i + 1} of ${order.length}, ${NAMES[which]}`;
    if (built.problem) {
      runs.push({ which, ms: null, failed: built.problem });
      post('timed', { kind: 'run', which, ms: null, failed: built.problem });
      continue;
    }
    setStatus(statusEl, 'work', `${name}: waiting for the phone to start fresh`);
    await phone.say(name);
    const out = await oneRun({ ctx, built, name, poller, stage, sleep, away, statusEl, phone });
    if (out.stop) {
      stopped = out.stop;
      break;
    }
    runs.push({ which, ms: out.ms ?? null, failed: out.failed ?? null });
    post('timed', { kind: 'run', which, ms: out.ms ?? null, failed: out.failed ?? null });
    drawReport(report, runs, streamBytes, labels);
  }
  stage.closeStage();

  const summary = summarise(runs, streamBytes);
  drawReport(report, runs, streamBytes, labels);
  const done = `${runs.filter((r) => !r.failed).length} of ${order.length} runs timed`;
  if (stopped === 'escape') setStatus(statusEl, 'warn', `Timed runs stopped: the full screen was closed (Escape, a click or a tap). ${done}.`);
  else if (stopped) setStatus(statusEl, 'fail', `Timed runs stopped: ${stopped}. ${done}; the runs so far are below.`);
  else setStatus(statusEl, runs.some((r) => r.failed) ? 'warn' : 'ok', `Timed runs done: ${done}.`);
  if (stopped) await phone.end('Timed runs stopped', 'warn');
  else await phone.end(`Timed runs done: ${done}`, runs.some((r) => r.failed) ? 'warn' : 'ok');
  post('timed', { kind: 'result', runs, summary, stopped, labels, streamBytes, a: builds.a.settings, b: builds.b?.settings ?? null });
  // Each timed setting can be chosen again from the menus, with its mean time.
  const kept = ['a', 'b'].filter((w) => summary[w]?.mean).map((w) => ({ settings: builds[w].settings, mean: summary[w].mean, runs: summary[w].times.length }));
  if (keep?.storage && kept.length) {
    saveTimed(keep.storage, keep.screenKey, kept, today());
    keep.menu?.redraw?.();
  }
}

/**
 * One run: a black stage until the phone reports an empty collection, then the
 * transfer until the phone reports it complete with this transmission's id.
 * A run during which the phone was away, or lost the screen after its first
 * piece, is not timed: the phone's clock runs on through such a spell.
 * @returns {Promise<{ ms: number } | { failed: string } | { stop: string }>}
 */
async function oneRun({ ctx, built, name, poller, stage, sleep, away, statusEl, phone }) {
  const waiting = `${name}: waiting for the phone to start fresh`;
  let blackText = waiting;
  stage.showBlack(ctx, blackText);
  await announce({ reset: true });
  let asks = 1;
  let sinceAskMs = 0;
  let sinceWordMs = 0;
  let reported = false; // the phone reported since the request to start fresh
  const { tx, layout, settings } = built;
  let showing = false;
  let waitedMs = 0; // waiting for the empty report, phone present
  let activeMs = 0; // showing, phone present
  let quietMs = 0; // showing, phone present, since the last new piece
  let progress = -1;
  let awayDuringMs = 0; // showing, phone away
  let awayWhy = null;
  let offAimReads = 0; // the most reads in a row with no markers, after this run's first piece
  let note = name;
  const setNote = (text, kind) => {
    if (text === note) return;
    note = text;
    stage.setStageNote(text);
    setStatus(statusEl, kind, text);
  };
  let last = performance.now();
  for (;;) {
    if (!stage.isStageOpen()) return { stop: 'escape' };
    const entries = await poller.poll();
    const polledAt = performance.now();
    for (const e of entries) {
      const c = e?.collector;
      if (!c) continue;
      if (!showing) {
        reported = true;
        // A report from before the reset (the last run complete, say) is not
        // this run's; the run starts only once the phone holds nothing, and
        // while it is there to read.
        if (!isEmpty(c) || phoneAwayReason({ lastReportMs: polledAt, health: e.health }, polledAt)) continue;
        showing = true;
        stage.showLoop(ctx, { tx, layout, settings });
        stage.setStageNote(name);
        setStatus(statusEl, 'work', name);
        break; // the rest of this batch is from before the frames went up
      }
      if (c.txId !== tx.txId) continue;
      if (progress > 0) offAimReads = Math.max(offAimReads, e.health?.noMarkersStreak ?? 0);
      if (progressOf(c) > progress) {
        progress = progressOf(c);
        quietMs = 0;
      }
      if (c.complete) {
        if (awayDuringMs > 0) return { failed: `The phone was away for ${Math.round(awayDuringMs / 1000)} s during the run (${awayWhy})` };
        if (offAimReads >= OFF_AIM_READS) return { failed: `The phone found no markers in ${offAimReads} camera reads in a row during the run` };
        return Number.isFinite(c.elapsedMs) && c.elapsedMs > 0 ? { ms: c.elapsedMs } : { failed: 'The phone gave no time for the transfer' };
      }
    }
    const now = performance.now();
    const dt = now - last;
    last = now;
    sinceWordMs += dt;
    if (sinceWordMs >= PHONE_WORD_MS) {
      sinceWordMs = 0;
      await phone.say(name);
    }
    const health = poller.phone();
    const why = phoneAwayReason({ lastReportMs: health?.reportAtMs ?? null, health }, now);
    if (!showing) {
      sinceAskMs += dt;
      if (sinceAskMs >= ASK_AGAIN_MS) {
        // A request lost on the way, or a stale camera image read after the
        // reset, leaves the phone holding something: ask again.
        sinceAskMs = 0;
        asks++;
        await announce({ reset: true });
      }
      const text = why ? `${waiting}. ${why}` : waiting;
      if (text !== blackText) {
        blackText = text;
        stage.showBlack(ctx, text);
      }
    }
    if (why) {
      // The computer's clocks wait while the phone is away; the phone's does not.
      away.ms += dt;
      if (away.ms >= AWAY_STOP_MS) return { stop: why };
      if (showing) {
        awayDuringMs += dt;
        awayWhy = why;
        setNote(`${name} is waiting. ${why}`, 'warn');
      } else {
        setStatus(statusEl, 'warn', `${name} is waiting. ${why}`);
      }
    } else {
      away.ms = 0;
      if (!showing) {
        waitedMs += dt;
        if (waitedMs >= FRESH_MS) {
          return {
            failed: reported
              ? `The phone reported but did not start fresh within 10 s (asked ${asks} times). If this repeats, reload the Receive page on the phone; it may be out of date`
              : 'The phone sent no report within 10 s',
          };
        }
      } else {
        activeMs += dt;
        quietMs += dt;
        if (quietMs >= STALL_MS) return { failed: 'No new pieces for 30 s' };
        if (activeMs >= RUN_LIMIT_MS) return { failed: 'Longer than 3 minutes' };
        setNote(quietMs >= QUIET_NOTE_MS ? `${name}: no new pieces for ${Math.floor(quietMs / 1000)} s` : name, quietMs >= QUIET_NOTE_MS ? 'warn' : 'work');
      }
    }
    await sleep(POLL_MS);
  }
}

function drawReport(box, runs, streamBytes, labels) {
  const summary = summarise(runs, streamBytes);
  const table = document.createElement('table');
  const head = table.createTHead().insertRow();
  for (const h of ['Setting', 'Times (s)', 'Mean (s)', 'Range (s)', 'Speed', 'Not timed']) {
    const th = document.createElement('th');
    th.textContent = h;
    head.appendChild(th);
  }
  const body = table.createTBody();
  for (const which of ['a', 'b']) {
    const side = summary[which];
    if (!side) continue;
    const row = body.insertRow();
    const cells = side.mean === null
      ? [`${NAMES[which]}: ${labels[which]}`, '-', '-', '-', '-', String(side.failed)]
      : [`${NAMES[which]}: ${labels[which]}`, side.times.map(seconds).join(', '), seconds(side.mean),
        `${seconds(side.min)} to ${seconds(side.max)}`, `${(side.bytesPerSecond / 1000).toFixed(1)} KB/s`, String(side.failed)];
    for (const text of cells) row.insertCell().textContent = text;
  }
  const parts = [table];
  if (summary.b) {
    const p = document.createElement('p');
    p.textContent = summary.differ === null
      ? 'Too few timed runs to compare: each setting needs 2.'
      : `${summary.differ ? `${NAMES[summary.faster]} is faster beyond the noise (95%)` : 'A and B do not differ beyond the noise (95%)'}: ${ratioText(summary.ratio)}.`;
    parts.push(p);
  }
  const failed = runs.map((r, i) => ({ ...r, n: i + 1 })).filter((r) => r.failed);
  if (failed.length) {
    const list = document.createElement('ul');
    for (const r of failed) {
      const li = document.createElement('li');
      li.textContent = `Run ${r.n}, ${NAMES[r.which]}, not timed: ${r.failed}`;
      list.appendChild(li);
    }
    parts.push(list);
  }
  box.replaceChildren(...parts);
}

// B's time against A's, from the geometric means of their timed runs.
function ratioText(ratio) {
  const pct = Math.round(Math.abs(ratio - 1) * 100);
  return pct === 0 ? 'B took about the same time as A' : `B took ${pct}% ${ratio > 1 ? 'more' : 'less'} time than A`;
}
