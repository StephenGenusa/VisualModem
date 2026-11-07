// The probe sequence: block sizes from large to small, each shown in every
// probe scheme, held long enough for a phone to read it several times. The
// frames are built live from this list (web/probe.js); nothing is saved.
// See the spec, "Version 3: the optimizer".

import { frameShapeV4, buildFrameV4 } from '../core/framev4.js';
import { FRAME_TYPES, PROBE_FLAGS } from '../core/frame.js';
import { probePayload } from './prbs.js';

export const PROBE_BLOCKS = [45, 35, 28, 23, 19, 16, 13, 11, 9];
export const PROBE_SCHEMES = ['cube2', 'g4', 'gray2', 'gray4'];
export const PROBE_HOLD_MS = 2500;
export const PROBE_FPS = 4;
// After the block loop: the color cube at these frame rates, for these blocks.
export const FPS_SWEEP = { blocks: [35, 28, 23, 19], schemeId: 'cube2', fps: [4, 6, 7.5, 10, 12, 15, 20, 30] };
// After the frame rate sweep: block 28 at these frame rates with each parity,
// to find how much error correction gives the most bytes a second.
export const PARITY_SWEEP = { blockSize: 28, schemeId: 'cube2', fps: [10, 15], parity: [0, 8, 16, 24, 48] };
export const SETTLE_MS = 4000; // a camera's exposure settles after the stage opens
// Each block size starts with the characterization frame at that size: a
// camera profile per size, and a moment for the exposure to settle.
export const CHARACTERIZE_MS = 2500;
export const WHITE_MIN = 64; // below this the levels crowd together on a camera
export const PARITY_MAX = 128;

const LABELS = {
  cube2: 'Color cube, 2 levels',
  g4: 'Green 4, red and blue 2',
  gray2: 'Black and white',
  gray4: '4 shades of gray',
};

const SCHEMES = {
  cube2: { kind: 'rgb', levels: [2, 2, 2] },
  g4: { kind: 'rgb', levels: [2, 4, 2] },
  gray2: { kind: 'gray', levels: 2 },
  gray4: { kind: 'gray', levels: 4 },
};

/** A scheme's name as the sender's Color scheme select shows it. */
export function schemeLabel(scheme) {
  const id = Object.keys(SCHEMES).find((k) => JSON.stringify(SCHEMES[k]) === JSON.stringify(scheme));
  if (id) return LABELS[id];
  return scheme.kind === 'gray' ? `${scheme.levels} shades of gray` : `Color levels ${scheme.levels.join('/')}`;
}

/**
 * @param {{ cap: number, parity: number, white?: number }} options cap is the largest block the screen holds;
 *   white is the level every probe frame shows
 * @returns {{ probes: Array<{ id, blockSize, schemeId, scheme, label, fps, static, holdMs, parity, white }>,
 *   steps: Array<{ kind: 'characterize', blockSize, white, probeId, holdMs } | { kind: 'probe', probe, holdMs }>,
 *   settleMs: number, loopMs: number }} settleMs is extra time on the first step of a run
 */
export function createProbeSequence({ cap, parity, white = 255 }) {
  const blocks = PROBE_BLOCKS.filter((b) => b <= cap);
  if (cap < PROBE_BLOCKS[0]) blocks[0] = cap; // the largest block the screen holds
  const probes = [];
  const steps = [];
  // No two probes measure the same thing: same block, scheme, rate, static flag and parity.
  const add = (blockSize, schemeId, fps, isStatic, label, probeParity = parity) => {
    if (probes.some((q) => q.blockSize === blockSize && q.schemeId === schemeId && q.fps === fps
      && q.static === isStatic && q.parity === probeParity)) return;
    const probe = {
      id: probes.length + 1, blockSize, schemeId, scheme: SCHEMES[schemeId], label, fps, static: isStatic, holdMs: PROBE_HOLD_MS, parity: probeParity, white,
    };
    probes.push(probe);
    steps.push({ kind: 'probe', probe, holdMs: probe.holdMs });
  };
  const characterize = (blockSize) => {
    steps.push({ kind: 'characterize', blockSize, white, probeId: probes.length + 1, holdMs: CHARACTERIZE_MS });
  };
  for (const blockSize of blocks) {
    characterize(blockSize);
    for (const schemeId of PROBE_SCHEMES) add(blockSize, schemeId, PROBE_FPS, false, LABELS[schemeId]);
    add(blockSize, 'cube2', PROBE_FPS, true, `${LABELS.cube2}, static`);
  }
  for (const blockSize of FPS_SWEEP.blocks.filter((b) => b <= cap)) {
    for (const fps of FPS_SWEEP.fps) add(blockSize, FPS_SWEEP.schemeId, fps, false, `${LABELS[FPS_SWEEP.schemeId]}, ${fps} fps`);
  }
  if (PARITY_SWEEP.blockSize <= cap) {
    for (const probeParity of PARITY_SWEEP.parity) {
      for (const fps of PARITY_SWEEP.fps) {
        add(PARITY_SWEEP.blockSize, PARITY_SWEEP.schemeId, fps, false,
          `${LABELS[PARITY_SWEEP.schemeId]}, ${fps} fps, parity ${probeParity}`, probeParity);
      }
    }
  }
  return { probes, steps, settleMs: SETTLE_MS, loopMs: steps.reduce((t, st) => t + st.holdMs, 0) };
}

/**
 * One version 4 probe frame. Its n packets carry symbolIds index * n + k and
 * the known data probePayload(txId, symbolId, packetBytes), so the phone can
 * count the good ones and measure errors against the same pattern.
 * @param {{ probe: object, txId: number, index: number, layoutV4: object, probeCount?: number, shownFps?: number, runId?: number }} p
 *   shownFps is the rate the stage really shows (defaults to probe.fps); runId names the press of Probe or Refine;
 *   probe.refine marks a frame of a Refine test
 * @returns {{ frameBytes: Uint8Array, shape: object }}
 */
export function buildProbeFrameV4({ probe, txId, index, layoutV4, probeCount = 0, shownFps = probe.fps, runId = 0 }) {
  const shape = frameShapeV4(layoutV4, probe.scheme, probe.parity);
  const packets = [];
  for (let k = 0; k < shape.packets; k++) {
    const symbolId = index * shape.packets + k;
    packets.push({ symbolId, data: probePayload(txId, symbolId, shape.packetBytes) });
  }
  const frameBytes = buildFrameV4({
    blockSize: probe.blockSize, scheme: probe.scheme, parity: probe.parity,
    frameType: FRAME_TYPES.probe, probeId: probe.id, probeCount, probeFps: shownFps,
    probeFlags: (probe.static ? PROBE_FLAGS.static : 0) | (probe.refine ? PROBE_FLAGS.refine : 0),
    txId, sourceCount: probe.white ?? 0, streamLength: runId, packets,
  }, shape);
  return { frameBytes, shape };
}
