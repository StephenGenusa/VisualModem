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
export const FPS_SWEEP = { blocks: [35, 28], schemeId: 'cube2', fps: [4, 6, 7.5, 10, 15] };
export const SETTLE_MS = 4000; // a camera's exposure settles after the stage opens
// Each block size starts with the characterization frame at that size: a
// camera profile per size, and a moment for the exposure to settle.
export const CHARACTERIZE_MS = 2500;

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
 * @param {{ cap: number, parity: number }} options cap is the largest block the screen holds
 * @returns {{ probes: Array<{ id, blockSize, schemeId, scheme, label, fps, static, holdMs, parity }>,
 *   steps: Array<{ kind: 'characterize', blockSize, probeId, holdMs } | { kind: 'probe', probe, holdMs }>,
 *   settleMs: number, loopMs: number }} settleMs is extra time on the first step of a run
 */
export function createProbeSequence({ cap, parity }) {
  const blocks = PROBE_BLOCKS.filter((b) => b <= cap);
  if (cap < PROBE_BLOCKS[0]) blocks[0] = cap; // the largest block the screen holds
  const probes = [];
  const steps = [];
  const add = (blockSize, schemeId, fps, isStatic, label) => {
    const probe = {
      id: probes.length + 1, blockSize, schemeId, scheme: SCHEMES[schemeId], label, fps, static: isStatic, holdMs: PROBE_HOLD_MS, parity,
    };
    probes.push(probe);
    steps.push({ kind: 'probe', probe, holdMs: probe.holdMs });
  };
  for (const blockSize of blocks) {
    steps.push({ kind: 'characterize', blockSize, probeId: probes.length + 1, holdMs: CHARACTERIZE_MS });
    for (const schemeId of PROBE_SCHEMES) add(blockSize, schemeId, PROBE_FPS, false, LABELS[schemeId]);
    add(blockSize, 'cube2', PROBE_FPS, true, `${LABELS.cube2}, static`);
  }
  for (const blockSize of FPS_SWEEP.blocks.filter((b) => b <= cap)) {
    for (const fps of FPS_SWEEP.fps) add(blockSize, FPS_SWEEP.schemeId, fps, false, `${LABELS[FPS_SWEEP.schemeId]}, ${fps} fps`);
  }
  return { probes, steps, settleMs: SETTLE_MS, loopMs: steps.reduce((t, s) => t + s.holdMs, 0) };
}

/**
 * One version 4 probe frame. Its n packets carry symbolIds index * n + k and
 * the known data probePayload(txId, symbolId, packetBytes), so the phone can
 * count the good ones and measure errors against the same pattern.
 * @param {{ probe: object, txId: number, index: number, layoutV4: object, probeCount?: number, shownFps?: number }} p
 *   shownFps is the rate the stage really shows (defaults to probe.fps)
 * @returns {{ frameBytes: Uint8Array, shape: object }}
 */
export function buildProbeFrameV4({ probe, txId, index, layoutV4, probeCount = 0, shownFps = probe.fps }) {
  const shape = frameShapeV4(layoutV4, probe.scheme, probe.parity);
  const packets = [];
  for (let k = 0; k < shape.packets; k++) {
    const symbolId = index * shape.packets + k;
    packets.push({ symbolId, data: probePayload(txId, symbolId, shape.packetBytes) });
  }
  const frameBytes = buildFrameV4({
    blockSize: probe.blockSize, scheme: probe.scheme, parity: probe.parity,
    frameType: FRAME_TYPES.probe, probeId: probe.id, probeCount, probeFps: shownFps,
    probeFlags: probe.static ? PROBE_FLAGS.static : 0,
    txId, sourceCount: 0, streamLength: 0, packets,
  }, shape);
  return { frameBytes, shape };
}
