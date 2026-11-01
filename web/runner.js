// The test runner: for each phone camera size, switches the phone's camera,
// runs Auto tune, then times a multi-frame file at a sweep of frame rates.
// Fills a report table and posts the report to the debug log.
import { createThroughputRun, deliveredResolution, THROUGHPUT_FRAMES } from '../src/tune/throughput.js';
import { phonePause } from '../src/tune/tuner.js';
import { isStageOpen, setStageNote } from './stage.js';
import { setStatus } from './status.js';
import { STEP_MS, announce, createPoller, beginRun, endRun, runTune, showTest, describeLevels, post } from './tune.js';

const CAMERAS = ['1080p', '4k'];
const SWITCH_WAIT_MS = 15000;
const THROUGHPUT_ID_BASE = 100000; // test ids for throughput files, apart from tune trials
// The phone posts the moment a file completes, so polling often keeps the
// measured time within about this much of the real one.
const SWEEP_POLL_MS = 100;
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

// Asks the phone for a camera size and waits for a report from it. Returns
// the video size and attempt times the phone reported, whatever it delivered.
async function switchCamera(camera, poller) {
  await announce({ camera, test: null });
  setStageNote(`Switching the phone's camera to ${camera}`);
  const until = performance.now() + SWITCH_WAIT_MS;
  let video = null;
  while (performance.now() < until && isStageOpen()) {
    await sleep(STEP_MS);
    for (const entry of await poller.poll()) {
      const v = entry.health && entry.health.video;
      if (v && v.resolution === camera && v.width > 0) video = v;
    }
    if (video) break;
  }
  setStageNote('');
  return video;
}

// Times one file per frame rate. Returns the throughput results.
async function sweep({ ctx, settings, pixels, poller, attemptMs, status }) {
  const seed = (Date.now() & 0x7fffffff) >>> 0;
  let run = null;
  let shown = null;
  let id = THROUGHPUT_ID_BASE;
  while (isStageOpen()) {
    if (!shown) {
      const fps = run ? run.current().fps : null;
      const rate = fps ?? 2;
      shown = await showTest({ ctx, id: ++id, settings: { ...settings, fps: rate }, pixels, seed, frames: THROUGHPUT_FRAMES, kind: 'throughput' });
      if (!shown) break;
      if (!run) run = createThroughputRun({ streamBytes: shown.bytes, frameCount: shown.tx.count });
      run.start(performance.now());
    }
    await sleep(SWEEP_POLL_MS);
    for (const entry of await poller.poll()) {
      attemptMs.push(...(entry.attemptMs ?? []));
      const c = entry.collector;
      if (c && c.txId === shown.tx.txId) {
        run.progress(c.have, performance.now());
        if (c.complete) run.complete(performance.now());
      }
    }
    const pause = phonePause(performance.now(), poller.phone());
    setStageNote(pause ?? '');
    status(pause ?? `Throughput at ${run.current().fps} frames per second`);
    const state = run.tick(performance.now(), Boolean(pause));
    if (state === 'done') return run.results();
    if (state === 'next') shown = null;
  }
  return run ? run.results() : [];
}

function renderReport(rows) {
  const table = document.createElement('table');
  const head = table.createTHead().insertRow();
  const fpsList = [...new Set(rows.flatMap((r) => r.throughput.map((t) => t.fps)))];
  for (const h of ['Camera', 'Delivered', 'Attempt ms', 'Levels found', 'Best', ...fpsList.map((f) => `${f} fps`)]) {
    const th = document.createElement('th');
    th.textContent = h;
    head.appendChild(th);
  }
  const body = table.createTBody();
  for (const r of rows) {
    const tr = body.insertRow();
    const cells = [
      r.camera,
      r.video ? `${r.video.width} × ${r.video.height} (${r.delivered})` : 'no report',
      r.medianAttemptMs ?? '',
      r.tune ? describeLevels(r.tune.perLevel) : r.stopped,
      r.tune ? `block ${r.tune.best.workingBlock}, ${r.tune.best.levels} levels, ${r.tune.best.bytesPerFrame} bytes per frame` : '',
      ...fpsList.map((f) => {
        const t = r.throughput.find((x) => x.fps === f);
        if (!t) return '';
        return t.timedOut ? 'timed out' : `${Math.round(t.bytesPerSecond)} B/s (${t.seconds.toFixed(1)} s)`;
      }),
    ];
    for (const text of cells) tr.insertCell().textContent = String(text);
  }
  $('test-report').replaceChildren(table);
}

async function runTests() {
  $('run-tests').blur();
  const statusEl = $('tune-status');
  const start = await beginRun(statusEl);
  if (!start) return;
  const { ctx, base, pixels } = start;
  const status = (text, kind = 'work') => setStatus(statusEl, kind, `Tests: ${text}`);
  post('tests start', { settings: base, ...pixels });
  const rows = [];
  for (const camera of CAMERAS) {
    if (!isStageOpen()) break;
    const poller = createPoller();
    await poller.skipOld();
    status(`switching the phone's camera to ${camera}`);
    const video = await switchCamera(camera, poller);
    const row = { camera, video, delivered: video ? deliveredResolution(video) : 'no report', throughput: [] };
    rows.push(row);
    if (!video) {
      // The phone did not report a running camera at this size; tuning would only pause.
      row.stopped = `The phone's camera did not start at ${camera}.`;
      continue;
    }
    status(`${camera}: auto tune`);
    const { result, message } = await runTune({ ctx, base, pixels, levelOptions: [2, 4], status: (t) => status(`${camera}: ${t}`) });
    if (!result) {
      row.stopped = message;
      continue;
    }
    row.tune = { best: result.best, perLevel: result.perLevel };
    const attemptMs = [];
    const settings = { ...base, blockSize: result.best.workingBlock, levels: result.best.levels };
    row.throughput = await sweep({ ctx, settings, pixels, poller, attemptMs, status: (t) => status(`${camera}: ${t}`) });
    row.medianAttemptMs = median(attemptMs);
  }
  await announce({ camera: '1080p', test: null });
  await endRun();
  renderReport(rows);
  const finished = rows.length === CAMERAS.length;
  status(finished ? 'done' : 'stopped early', finished ? 'ok' : 'warn');
  post('test report', { report: rows });
}

/** Shows the Run tests button when capture is on. */
export function setupRunner(captureOn) {
  if (!captureOn) return;
  $('run-tests').hidden = false;
  $('run-tests').addEventListener('click', runTests);
}
