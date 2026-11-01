// Auto tune: shows one trial after another full screen, announces each to the
// phone through the project server, and feeds the phone's per-test counts and
// health to the tuner (src/tune/tuner.js). The Auto tune button sets block size
// and levels to the best result; the test runner (web/runner.js) reuses the
// same pieces. Needs the server with --capture.
import { createTuner } from '../src/tune/tuner.js';
import { buildTrialStream, MIN_CAPACITY } from '../src/tune/trialpayload.js';
import { encodeTransmission } from '../src/core/transmission.js';
import { frameCapacity, frameGrossBytes } from '../src/core/frame.js';
import { settingsScheme } from '../src/core/transmission.js';
import { computeLayout } from '../src/picture/layout.js';
import { computeReadout } from './readout.js';
import { setStatus } from './status.js';
import { openStage, showLoop, closeStage, isStageOpen, stageRefused, setStageNote } from './stage.js';

export const STEP_MS = 500;
const POLL_TIMEOUT_MS = 2000; // a hung request must not freeze the run
const $ = (id) => document.getElementById(id);

let hooks = null; // { getSettings, setSettings, displayPixels } from the sender
let busy = false; // a tune or test run owns the stage

export function post(event, detail) {
  const body = JSON.stringify({ source: 'sender', event, ...detail });
  fetch('/debug', { method: 'POST', body, headers: { 'Content-Type': 'application/json' } }).catch(() => {});
}

// Tells the phone, through the server, what is on screen and which camera size to use.
export async function announce(patch) {
  try {
    await fetch('/session', {
      method: 'POST', body: JSON.stringify(patch), headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
    });
  } catch {
    // The phone keeps the old state; its attempts then count as markers only.
  }
}

/**
 * Reads the phone's reports from the server. The one place feedback comes
 * from; a light status frame can replace it later. poll() returns the new
 * entries, and phone() the latest health with its arrival time.
 */
export function createPoller() {
  let lastSeq = 0;
  let phone = null;
  return {
    async skipOld() {
      try {
        lastSeq = (await (await fetch('/feedback?after=0', { cache: 'no-store', signal: AbortSignal.timeout(POLL_TIMEOUT_MS) })).json()).seq;
      } catch {
        // stale until the phone reports
      }
      phone = { visible: true, camera: 'running', noMarkersStreak: 0, reportAtMs: performance.now() };
    },
    async poll() {
      try {
        const res = await fetch(`/feedback?after=${lastSeq}`, { cache: 'no-store', signal: AbortSignal.timeout(POLL_TIMEOUT_MS) });
        if (!res.ok) return [];
        const { seq, entries } = await res.json();
        lastSeq = seq;
        for (const entry of entries) if (entry.health) phone = { ...entry.health, reportAtMs: performance.now() };
        return entries;
      } catch {
        return []; // the server is unreachable: the phone's report goes stale and runs pause
      }
    },
    phone: () => phone,
  };
}

export function frameBytesFor(settings, pixels) {
  const r = computeReadout({ ...pixels, ...settings }, 0);
  const layout = computeLayout(r.cols, r.rows);
  return { layout, capacity: frameCapacity(frameGrossBytes(layout.dataBlockCount, settingsScheme(settings)), settings.parity) };
}

// Builds a transmission of `frames` random frames at these settings, announces
// it to the phone as test `id` and shows it. Returns the transmission, or null
// when the stage closed meanwhile.
export async function showTest({ ctx, id, settings, pixels, seed, frames = 1, kind }) {
  const { layout, capacity } = frameBytesFor(settings, pixels);
  const stream = await buildTrialStream(id, capacity, seed, frames);
  const tx = encodeTransmission(stream, layout, settings);
  const test = { id, txId: tx.txId, cols: layout.cols, rows: layout.rows, blockSize: settings.blockSize, levels: settings.levels };
  await announce({ test });
  if (!isStageOpen()) return null;
  showLoop(ctx, { tx, layout, settings });
  post('test shown', { test, kind, frames: tx.count, bytes: stream.length, fps: settings.fps });
  return { tx, layout, bytes: stream.length };
}

/**
 * Runs the tuner on an open stage until it is done, stops, or the stage
 * closes. Does not close the stage or change any setting.
 * @returns {Promise<{ result: object | null, message: string }>}
 */
export function runTune({ ctx, base, pixels, levelOptions = [2, 4], status }) {
  const { cap } = computeReadout({ ...pixels, ...base }, 0);
  const tuner = createTuner({
    maxBlock: cap,
    levelOptions,
    capacity: (blockSize, levels) => frameBytesFor({ ...base, blockSize, levels }, pixels).capacity,
  });
  const poller = createPoller();
  const seed = (Date.now() & 0x7fffffff) >>> 0;
  let shownId = null;
  let stepping = false;
  return new Promise((resolve) => {
    let timer = null;
    let ended = false;
    const end = (value) => {
      ended = true;
      clearInterval(timer);
      resolve(value);
    };
    const step = async () => {
      if (stepping || ended) return;
      stepping = true;
      try {
        if (!isStageOpen()) return end({ result: null, message: 'Stopped. The settings were not changed.' });
        const entries = await poller.poll();
        for (const entry of entries) {
          for (const [testId, counts] of Object.entries(entry.tests ?? {})) tuner.addCounts(Number(testId), counts);
        }
        const trial = tuner.current();
        if (trial.id !== shownId) {
          const settings = { ...base, blockSize: trial.blockSize, levels: trial.levels };
          const shown = await showTest({ ctx, id: trial.id, settings, pixels, seed, kind: trial.kind });
          if (!shown) return end({ result: null, message: 'Stopped. The settings were not changed.' });
          tuner.shown(trial.id, performance.now());
          shownId = trial.id;
        }
        const r = tuner.tick(performance.now(), poller.phone());
        status(r.message);
        setStageNote(r.state === 'running' ? '' : r.message); // the page is behind the stage
        if (r.state === 'done') end({ result: tuner.result(), message: 'Done' });
        else if (r.state === 'stopped') end({ result: null, message: r.message });
      } catch (err) {
        end({ result: null, message: `Stopped: ${err.message || err}` });
      } finally {
        stepping = false;
      }
    };
    poller.skipOld().then(() => {
      timer = setInterval(step, STEP_MS);
      step();
    });
  });
}

export function describeLevels(perLevel) {
  return perLevel.map((p) => (p.usable
    ? `${p.levels} levels: smallest block ${p.smallestBlock}, working ${p.workingBlock}, ${p.bytesPerFrame} bytes per frame`
    : `${p.levels} levels: not readable`)).join('; ');
}

/** Checks a run can start, then opens the stage. Returns { ctx, base, pixels } or null. */
export async function beginRun(statusEl) {
  if (busy || isStageOpen()) return null;
  const pixels = hooks.displayPixels();
  // Auto tune and the test runner search the color cube's levels.
  const base = { ...hooks.getSettings(), scheme: 'cube' };
  const { cap } = computeReadout({ ...pixels, ...base }, 0);
  const { capacity } = frameBytesFor({ ...base, blockSize: Math.min(45, cap), levels: 2 }, pixels);
  if (capacity < MIN_CAPACITY) {
    setStatus(statusEl, 'fail', `Testing needs ${MIN_CAPACITY} bytes per frame, and this screen holds ${capacity} at block `
      + `${Math.min(45, cap)}. Choose less parity, then try again.`);
    return null;
  }
  busy = true;
  const ctx = await openStage(pixels);
  if (!ctx) {
    busy = false;
    if (stageRefused()) setStatus(statusEl, 'fail', 'The browser refused full screen');
    return null;
  }
  return { ctx, base, pixels };
}

export async function endRun() {
  busy = false;
  closeStage();
  await announce({ test: null });
}

async function autoTune() {
  $('tune').blur();
  const statusEl = $('tune-status');
  const run = await beginRun(statusEl);
  if (!run) return;
  // A run that was interrupted can leave the phone at 4K; Auto tune measures at the default.
  await announce({ camera: '1080p', test: null });
  post('tune start', { settings: run.base, ...run.pixels });
  const { result, message } = await runTune({ ...run, status: (text) => setStatus(statusEl, 'work', `Auto tune: ${text}`) });
  await endRun();
  if (!result) {
    setStatus(statusEl, 'warn', `Auto tune: ${message}`);
    post('tune stopped', { message });
    return;
  }
  const { best, perLevel } = result;
  hooks.setSettings({ blockSize: best.workingBlock, levels: best.levels, scheme: 'cube' });
  setStatus(statusEl, 'ok', `Auto tune: ${describeLevels(perLevel)}. Set block ${best.workingBlock}, ${best.levels} levels.`);
  post('tune result', { result });
}

/**
 * Shows the Auto tune button when the server runs with --capture.
 * @param {{ getSettings: () => object, setSettings: (patch: object) => void, displayPixels: () => object }} senderHooks
 * @returns {Promise<boolean>} whether capture is on
 */
export async function setupTune(senderHooks) {
  hooks = senderHooks;
  try {
    const res = await fetch('/capture', { cache: 'no-store' });
    if (!res.ok || !(await res.json()).enabled) return false;
  } catch {
    return false;
  }
  $('grp-dev').hidden = false; // the Development group shows only with capture on
  $('tune').hidden = false;
  $('tune').addEventListener('click', autoTune);
  return true;
}
