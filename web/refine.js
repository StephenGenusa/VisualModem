// Refine on the sender: shows each test the search asks for, polls the phone's
// counts and hands them to refineStep (src/optimize/refineloop.js), which makes
// every decision. This file only does what needs a page: the stage, the clock,
// the network, storage and the result on the page. Needs the server with --capture.
import { createSearch, spaceFor, TEST_MS } from '../src/optimize/search.js';
import {
  refineStep, createRefineState, createScreenShapes, blocksToPrepare, resultRows, describeSettings,
  loadWinners, saveWinner, saveLastResult, seedsFrom, seedCountFor, LONG_RUN_MINUTES,
} from '../src/optimize/refineloop.js';
import { random32 } from '../src/optimize/prbs.js';
import { settingsScheme } from '../src/core/transmission.js';
import { actualFps } from '../src/picture/cadence.js';
import { computeReadout } from './readout.js';
import { formatClock } from './rxstatus.js';
import { setStatus } from './status.js';
import { announce, createPoller, post, today } from './tune.js';
import { probeTransmission } from './probe.js';
import { createWakeLock } from './wakelock.js';
import { openStage, showLoop, closeStage, isStageOpen, stageRefused, setStageNote, setStageBanner, stageRefreshHz } from './stage.js';

const POLL_MS = 200;
const RESULT_KEEP_MS = 600000; // how long the phone keeps showing the result
const NO_PROBE_COUNT = 0; // a Refine test is one of no fixed number; the refine flag says so
const MAX_LOGGED_ROWS = 60; // the result's log entry stays small
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

let hooks = null;
let choices = null; // the Send page's settings menu
let running = false;
let phoneSeq = 0;

const tellPhone = (active, word, kind) => announce({ refine: { seq: ++phoneSeq, active, word, kind } });

function browserStorage() {
  try {
    return localStorage;
  } catch {
    return null;
  }
}


/**
 * Keeps a finished run's result for the settings menu and redraws the menu.
 * Only a run that set a winner that is not provisional is kept: a run stopped
 * with Escape, one with no winner, or one whose winner is provisional keeps
 * nothing, so the result before it stays offered. on is the scheme id and
 * levels the run used.
 */
export function keepLastResult(storage, screenKey, { result, outcome, on }, menu, day) {
  if (!result.winner || !outcome.apply || outcome.provisional) return;
  saveLastResult(storage, screenKey, result, day, on);
  menu?.redraw();
}

// One test's frames, up on the stage. Its probe id and the run id are in every frame.
function display({ ctx, candidate, probeId, testMs, pixels, runId, shapes }) {
  const { blockSize, scheme, parity, fps, white } = candidate;
  const probe = { id: probeId, blockSize, scheme, parity, fps, white, static: false, refine: true, holdMs: testMs };
  const { tx, layout } = probeTransmission(probe, NO_PROBE_COUNT, pixels, runId, shapes.layoutOf(blockSize));
  showLoop(ctx, { tx, layout, settings: { blockSize, scheme, fps, white } });
}

function drawTable(result) {
  const box = $('refine-table');
  const rows = resultRows(result);
  if (!rows.length) {
    box.replaceChildren();
    return;
  }
  const table = document.createElement('table');
  const head = table.createTHead().insertRow();
  for (const h of ['Settings', 'Mean KB/s', 'Range KB/s', 'Readings', 'Still in the running']) {
    const th = document.createElement('th');
    th.textContent = h;
    head.appendChild(th);
  }
  const body = table.createTBody();
  for (const r of rows) {
    const tr = body.insertRow();
    for (const text of [r.settings, r.mean, r.range, r.readings, r.alive ? 'Yes' : 'No']) tr.insertCell().textContent = String(text);
  }
  box.replaceChildren(table);
}

function coverageText({ coverage, tests }) {
  return ` ${tests} ${tests === 1 ? 'test' : 'tests'}: ${coverage.full} ${coverage.full === 1 ? 'setting' : 'settings'} with full tests, ${coverage.screened} with a short look.`;
}

function loggedResult(result) {
  const shown = result.ranked.filter((r) => r.readings > 0 || r.rough !== null).slice(0, MAX_LOGGED_ROWS);
  const plain = ({ blockSize, parity, fps, white }) => ({ blockSize, parity, fps, white });
  return {
    winner: result.winner && plain(result.winner),
    leader: result.leader && plain(result.leader),
    provisional: result.provisional,
    separated: result.separated,
    tests: result.tests,
    coverage: result.coverage,
    tied: (result.tied ?? []).map(plain),
    candidates: (result.candidates ?? []).map(plain),
    reference: result.reference,
    conditionsChanged: result.conditionsChanged,
    byConditions: result.byConditions && Object.fromEntries(Object.entries(result.byConditions).map(([k, v]) => [k, v && { ...v, candidate: plain(v.candidate) }])),
    passes: (result.passes ?? []).map((p) => p && { ...p, candidate: plain(p.candidate) }),
    ranked: shown.map((r) => ({ ...r, candidate: plain(r.candidate) })),
  };
}

function finish({ action, state, statusEl, screenKey, shown, on }) {
  const { outcome, result } = action;
  closeStage();
  if (outcome.apply) {
    const { blockSize, parity, fps, white } = outcome.apply;
    hooks.setSettings({ blockSize, parity, fps, white });
    const row = result.ranked.find((r) => r.candidate === outcome.apply);
    if (!outcome.provisional && row) {
      saveWinner(browserStorage(), screenKey, { blockSize, parity, fps, white, ...on, mean: row.mean, readings: row.readings, widthShare: state.share, savedOn: today() });
    }
  }
  keepLastResult(browserStorage(), screenKey, { result, outcome, on }, choices, today());
  setStatus(statusEl, outcome.kind, outcome.message + (result.tests ? coverageText(result) : ''));
  drawTable(result);
  post('refine', { kind: 'result', runId: state.runId, how: action.how, lostAim: state.lostAim, moved: state.moved, shown, applied: outcome.apply && describeSettings(outcome.apply), provisional: outcome.provisional, previous: state.previous, result: loggedResult(result) });
  const seq = phoneSeq + 1;
  setTimeout(() => { if (seq === phoneSeq && !running) announce({ refine: null }); }, RESULT_KEEP_MS);
  return tellPhone(false, outcome.word, outcome.kind);
}

async function run(statusEl) {
  const limitMinutes = Number($('refine-limit').value);
  const pixels = hooks.displayPixels();
  const base = hooks.getSettings();
  const previous = { blockSize: base.blockSize, parity: base.parity, fps: base.fps, white: base.white };
  const { cap } = computeReadout({ ...pixels, ...base }, 0);
  const scheme = settingsScheme(base);
  const screenKey = `${pixels.widthPx}x${pixels.heightPx}`;
  setStatus(statusEl, 'work', 'Refine: starting');
  $('refine-table').replaceChildren();
  // Full screen must be asked for at once, while the button press still counts.
  const ctx = await openStage(pixels);
  if (!ctx) {
    setStatus(statusEl, stageRefused() ? 'fail' : 'warn', stageRefused() ? 'The browser refused full screen' : "Refine stopped. The Send page's settings were not changed.");
    return;
  }
  const shapes = createScreenShapes({
    widthPx: pixels.widthPx, heightPx: pixels.heightPx, scheme,
    shownFps: (fps) => { const hz = stageRefreshHz(); return hz ? actualFps(hz, fps) : fps; },
  });
  const seeds = seedsFrom(previous, loadWinners(browserStorage(), screenKey), shapes, scheme, seedCountFor(limitMinutes));
  if (!seeds.length) {
    closeStage();
    setStatus(statusEl, 'fail', `This screen holds no data at ${describeSettings(previous)}. Choose less parity or a smaller block, then try again.`);
    return;
  }
  // The layouts cost a test's time if left until they are needed: all of them, now.
  tellPhone(true, 'Refine starting', 'work');
  const { parity: parities } = spaceFor(cap, seeds);
  for (const blockSize of blocksToPrepare(cap, seeds)) {
    if (!isStageOpen()) break;
    shapes.prepare(blockSize, parities);
    await sleep(0);
  }
  const next = random32(Date.now() ^ 0x2545f491);
  const runId = next() || 1;
  const search = createSearch({
    cap, seeds, fixed: { scheme }, random: () => next() / 0x100000000, ceilingOf: shapes.ceilingOf, longRun: limitMinutes >= LONG_RUN_MINUTES,
  });
  const poller = createPoller();
  await poller.skipOld();
  post('refine', { kind: 'start', runId, limitMinutes, previous, cap, ...pixels, seeds });
  const withScheme = (c) => ({ ...c, scheme });
  const showIt = (candidate, probeId, testMs) => display({ ctx, candidate: withScheme(candidate), probeId, testMs, pixels, runId, shapes });
  // Something to aim at and expose for while the phone is awaited.
  if (isStageOpen()) showIt(seeds[0], 0, TEST_MS);

  let state = createRefineState({ search, limitMs: limitMinutes * 60000, runId, shapes, previous, first: seeds[0] });
  let shown = false;
  let testsShown = 0;
  let banner = null;
  for (;;) {
    const entries = await poller.poll();
    const step = refineStep(state, { nowMs: performance.now(), entries, shown, stopped: !isStageOpen() });
    state = step.state;
    const { action } = step;
    shown = false;
    if (action.type === 'finish') return finish({ action, state, statusEl, screenKey, shown: testsShown, on: { scheme: base.scheme, levels: base.levels } });
    if (action.type === 'abort') {
      closeStage();
      setStatus(statusEl, 'fail', action.message);
      post('refine', { kind: 'abort', runId, message: action.message });
      return tellPhone(false, 'Refine stopped: see the computer', 'fail');
    }
    if (action.type === 'record') {
      const { reading, counted, why, reason, probeId, testMs, shown: wasShown } = action;
      const { blockSize, parity, fps, white } = action.candidate;
      post('refine', { kind: 'test', runId, probeId, candidate: { blockSize, parity, fps, white }, reason, testMs, counted, shown: wasShown, why, reading });
      continue;
    }
    if (action.type === 'show') {
      // Closed meanwhile: the next step sees that and ends the run.
      if (!isStageOpen()) continue;
      showIt(action.candidate, action.probeId, action.testMs);
      shown = true;
      banner = null;
      if (action.probeId === 0) {
        setStageNote('Refine: the camera is settling');
        tellPhone(true, 'Refine starting', 'work');
        continue;
      }
      testsShown++;
      const left = formatClock(action.remainingMs);
      if (action.aimLost) {
        // The frames stay up, with no banner: the retest is what shows the aim is back.
        const lost = `The phone lost its aim. Refine shows ${describeSettings(action.candidate)} until it reads again`;
        setStageNote(lost);
        setStatus(statusEl, 'warn', lost);
        tellPhone(true, 'Refine: aim lost', 'warn');
        continue;
      }
      const text = `Refine test ${testsShown}, ${left} left: ${describeSettings(action.candidate)}`;
      setStageNote(text);
      setStatus(statusEl, 'work', text);
      tellPhone(true, `Refine ${left} left`, 'work');
      continue;
    }
    // A wait. Nothing on screen is being measured while there is a reason given.
    if (action.why && action.why !== banner && isStageOpen()) {
      banner = action.why;
      setStageBanner(ctx, `Refine is waiting. ${action.why}`);
      setStatus(statusEl, 'warn', `Refine is waiting. ${action.why}`);
      tellPhone(true, `Refine waiting: ${action.why}`, 'warn');
    }
    await sleep(POLL_MS);
  }
}

async function runRefine() {
  $('refine').blur();
  const statusEl = $('refine-status');
  if (running || isStageOpen()) return;
  running = true;
  choices?.setBusy(true);
  const computerAwake = createWakeLock();
  computerAwake.sync(true);
  try {
    await run(statusEl);
  } catch (err) {
    closeStage();
    setStatus(statusEl, 'fail', `Refine stopped: ${err.message || err}. The Send page's settings were not changed.`);
    post('refine', { kind: 'error', message: String(err.message || err) });
    tellPhone(false, 'Refine stopped', 'fail');
  } finally {
    running = false;
    choices?.setBusy(false);
    computerAwake.sync(false);
  }
}

/** Shows Refine when the server runs with --capture. menu is the settings menu, redrawn when a run finishes. */
export function setupRefine(pageHooks, captureOn, menu = null) {
  if (!captureOn) return;
  hooks = pageHooks;
  choices = menu;
  $('grp-refine').hidden = false;
  $('refine').addEventListener('click', runRefine);
  // Whatever a page before this one left on the phone. The phone loads this page
  // too, and its reload must not wipe a result or a running word.
  if (location.hash !== '#receive') announce({ refine: null });
}
