// Probe on the sender: for each block size, the characterization frame at that
// size, then each of its probes (PROBE_FPS frames a second for holdMs each, plus
// a static twin), then a frame rate sweep, looping until Escape.
// Payloads are the known pattern probePayload(txId, symbolId), not fresh random
// data, so the phone can measure errors against them. The first step also
// waits for the camera's exposure to settle. Every frame is built live; none is
// saved. Needs no network: the phone measures and recommends by light alone.
// See the spec, "Version 3: the optimizer".
import { createProbeSequence, buildProbeFrameV4 } from '../src/optimize/probes.js';
import { random32 } from '../src/optimize/prbs.js';
import { renderCharacterization } from '../src/optimize/characterize.js';
import { computeLayout, computeLayoutV4, fitGrid } from '../src/picture/layout.js';
import { computeReadout } from './readout.js';
import { actualFps } from '../src/picture/cadence.js';
import { setStatus } from './status.js';
import { openStage, showLoop, showImage, closeStage, isStageOpen, stageRefused, setStageNote, stageRefreshHz } from './stage.js';

const WAIT_STEP_MS = 100;
const $ = (id) => document.getElementById(id);

// Waits ms, or less if the stage closes. Returns whether it is still open.
async function hold(ms) {
  const until = performance.now() + ms;
  while (isStageOpen() && performance.now() < until) {
    await new Promise((done) => setTimeout(done, Math.min(WAIT_STEP_MS, until - performance.now())));
  }
  return isStageOpen();
}

// The frames of one probe: version 4 frames whose packets hold the known
// pattern probePayload(txId, symbolId), typed as probes. The stage's version 4
// loop counts frames up forever, so frameAt wraps the probe's own frames.
// Refine passes the layout it has already worked out for this size.
export function probeTransmission(probe, probeCount, pixels, runId, layoutV4 = null) {
  if (!layoutV4) {
    const { cols, rows } = fitGrid(pixels.widthPx, pixels.heightPx, probe.blockSize);
    layoutV4 = computeLayoutV4(cols, rows);
  }
  const count = probe.static ? 1 : Math.max(1, Math.round((probe.fps * probe.holdMs) / 1000));
  const next = random32(Date.now() ^ (probe.id * 0x9E3779B1));
  const txId = next();
  const refreshHz = stageRefreshHz();
  const shownFps = refreshHz ? actualFps(refreshHz, probe.fps) : probe.fps; // the rate the stage really shows
  const frames = [];
  for (let index = 0; index < count; index++) {
    frames.push(buildProbeFrameV4({ probe, txId, index, layoutV4, probeCount, shownFps, runId }).frameBytes);
  }
  const tx = { txId, scheme: probe.scheme, period: count, sourceFrames: count, frameAt: (i) => frames[i % count] };
  return { tx, layout: layoutV4 };
}

// One press of Probe. Every frame of the press carries one run id (kept across
// loops) so the phone tallies it apart from any other press.
async function runProbe(hooks) {
  $('probe').blur();
  const statusEl = $('probe-status');
  if (isStageOpen()) return;
  const loops = Number($('probe-loops').value); // 0 runs until Escape
  const pixels = hooks.displayPixels();
  const base = hooks.getSettings();
  const { cap } = computeReadout({ ...pixels, ...base }, 0);
  const sequence = createProbeSequence({ cap, parity: base.parity, white: base.white });
  const runId = random32(Date.now() ^ 0x5bd1e995)() || 1;
  const ctx = await openStage(pixels);
  if (!ctx) {
    if (stageRefused()) setStatus(statusEl, 'fail', 'The browser refused full screen');
    return;
  }
  const count = sequence.probes.length;
  let first = true;
  for (let loop = 1; loops === 0 || loop <= loops; loop++) {
    for (const step of sequence.steps) {
      if (!isStageOpen()) return done(statusEl, loop - 1);
      let text;
      if (step.kind === 'characterize') {
        const { cols, rows } = fitGrid(pixels.widthPx, pixels.heightPx, step.blockSize);
        showImage(ctx, renderCharacterization({
          layout: computeLayout(cols, rows), blockSize: step.blockSize, white: step.white, probeId: step.probeId, probeCount: count,
        }));
        text = `Probe: measuring the camera at block ${step.blockSize}`;
      } else {
        const { probe } = step;
        const { tx, layout } = probeTransmission(probe, count, pixels, runId);
        showLoop(ctx, { tx, layout, settings: { blockSize: probe.blockSize, scheme: probe.scheme, fps: probe.fps, white: probe.white } });
        text = `Probe ${probe.id} of ${count}: block ${probe.blockSize}, ${probe.label}`;
      }
      text += loops === 0 ? `, loop ${loop}` : `, loop ${loop} of ${loops}`;
      setStatus(statusEl, 'work', text);
      setStageNote(text);
      // The first step of a run also lets the camera's exposure settle.
      const ms = step.holdMs + (first ? sequence.settleMs : 0);
      first = false;
      if (!(await hold(ms))) return done(statusEl, loop - 1);
    }
  }
  closeStage();
  setStatus(statusEl, 'ok', `Probe finished, ${loops} ${loops === 1 ? 'loop' : 'loops'}. Read the recommendation on the phone.`);
}

function done(statusEl, loopsDone) {
  setStatus(statusEl, 'warn', `Probe stopped after ${loopsDone} full ${loopsDone === 1 ? 'loop' : 'loops'}. Read the recommendation on the phone.`);
}

/** Wires the Probe button. It is always shown: it needs no network. */
export function setupProbe(hooks) {
  $('probe').addEventListener('click', () => runProbe(hooks));
}
