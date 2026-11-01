// Per-attempt records of the phone's probe reads, for the debug report, and
// the summary the report tool prints. A record is the stage a read reached,
// the frame's identity, and the errors measured against the known payload
// (src/optimize/linkerrors.js). Measurement only; no DOM, pure.

import { schemeName } from '../core/scheme.js';
import { codewordSuccess } from './linkerrors.js';
import { PROBE_HOLD_MS } from './probes.js';

export const PREDICT_PARITIES = [0, 8, 16, 24, 32, 48, 64];
const REGIONS = 25;

/** The most serialized bytes of records one debug post carries; the server cap is 256 KB and keepalive bodies share 64 KB. */
export const MAX_ATTEMPT_BYTES = 48 * 1024;

const round = (v, places) => (Number.isFinite(v) ? Math.round(v * 10 ** places) / 10 ** places : null);

function schemeLabel(scheme) {
  if (!scheme) return null;
  return typeof scheme === 'string' ? scheme : schemeName(scheme);
}

/**
 * One compact record of a camera attempt.
 * @param {{ atMs: number, grabMs: number, decodeMs: number, read: object, frame: object | null, debug: object, errors: object | null }} p
 * @returns {object}
 */
export function attemptRecord({ atMs, grabMs, decodeMs, read, frame, debug, errors, packetMask }) {
  const h = frame?.header ?? debug?.header ?? read?.frameHeader ?? null;
  return {
    t: atMs,
    grabMs: round(grabMs, 0),
    decodeMs: round(decodeMs, 1),
    stage: debug?.stage ?? null,
    probeId: h?.probeId ?? null,
    frameType: h?.frameType ?? null,
    blockSize: h?.blockSize ?? null,
    scheme: schemeLabel(h?.scheme ?? read?.schemeName),
    fps: h?.probeFps ?? null,
    static: Boolean(h?.probeStatic),
    txId: h?.txId ?? null,
    index: h?.index ?? null,
    ok: Boolean(frame),
    ...(packetMask ? { packetMask } : {}),
    corrected: frame?.corrected ?? null,
    margin: round(read?.margin, 3),
    cols: read?.cols ?? null,
    rows: read?.rows ?? null,
    err: errors && {
      cells: errors.cells,
      cellErrors: errors.cellErrors,
      shifts: errors.shifts,
      region: errors.region.errors,
      cw: errors.codewords.map((c) => c.errors),
      cwFlagged: errors.codewords.map((c) => c.flagged),
      cwFlaggedErr: errors.codewords.map((c) => c.flaggedErrors),
    },
  };
}

/**
 * A bounded log. Keeps the newest records, at most `max` and at most
 * `maxBytes` serialized, and counts the dropped ones.
 * @param {{ max?: number, maxBytes?: number }} [options]
 */
export function createAttemptLog({ max = 120, maxBytes = MAX_ATTEMPT_BYTES } = {}) {
  let records = [];
  let sizes = [];
  let bytes = 0;
  let dropped = 0;
  return {
    add(record) {
      const size = JSON.stringify(record).length + 1;
      records.push(record);
      sizes.push(size);
      bytes += size;
      while (records.length > max || bytes > maxBytes) {
        records.shift();
        bytes -= sizes.shift();
        dropped++;
      }
    },
    drain() {
      const out = { attempts: records, dropped };
      records = [];
      sizes = [];
      bytes = 0;
      dropped = 0;
      return out;
    },
  };
}

// The codewords of an err record, in the shape codewordSuccess takes.
const codewordsOf = (err) => err.cw.map((errors, i) => ({ errors, flagged: err.cwFlagged[i], flaggedErrors: err.cwFlaggedErr[i] }));

function median(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

// Gaps between consecutive grab times within each showing (txId), in ms.
function grabGaps(list) {
  const byShowing = new Map();
  for (const r of list) {
    if (!Number.isFinite(r.grabMs)) continue;
    if (!byShowing.has(r.txId)) byShowing.set(r.txId, []);
    byShowing.get(r.txId).push(r.grabMs);
  }
  const gaps = [];
  for (const times of byShowing.values()) {
    times.sort((a, b) => a - b);
    for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
  }
  return gaps;
}

/**
 * One row per (blockSize, scheme, fps, static).
 * Predicted success averages only attempts that had a full codeword.
 * `predicted` is the mean share of codewords that pass at a parity;
 * `predictedFrame` is the share of attempts whose every codeword passes,
 * which is what the measured per frame `okShare` compares with.
 * Region error rates divide by an even share (cells / 25) of the cells read.
 * @param {object[]} records
 * @returns {object[]}
 */
export function summarizeAttempts(records) {
  const groups = new Map();
  for (const r of records) {
    const key = JSON.stringify([r.blockSize, r.scheme, r.fps, r.static]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const rows = [];
  for (const list of groups.values()) {
    const first = list[0];
    const stageShares = {};
    const okSet = new Set();
    const showSet = new Set();
    let cells = 0, cellErrors = 0, shifts = 0;
    const regionErrors = new Array(REGIONS).fill(0);
    const sums = Object.fromEntries(PREDICT_PARITIES.map((p) => [p, { plain: 0, erasures: 0 }]));
    const frameSums = Object.fromEntries(PREDICT_PARITIES.map((p) => [p, { plain: 0, erasures: 0 }]));
    let okAttempts = 0;
    let maskAttempts = 0, goodShare = 0, wholeAttempts = 0;
    let withCodewords = 0;
    for (const r of list) {
      stageShares[r.stage] = (stageShares[r.stage] ?? 0) + 1 / list.length;
      showSet.add(r.txId);
      if (r.ok) { okSet.add(`${r.txId}:${r.index}`); okAttempts++; }
      if (r.packetMask) {
        maskAttempts++;
        goodShare += (r.packetMask.match(/1/g) ?? []).length / r.packetMask.length;
        if (!r.packetMask.includes('0')) wholeAttempts++;
      }
      if (!r.err) continue;
      cells += r.err.cells;
      cellErrors += r.err.cellErrors;
      shifts += r.err.shifts;
      r.err.region.forEach((e, i) => { regionErrors[i] += e; });
      if (r.err.cw.length === 0) continue;
      withCodewords++;
      const cws = codewordsOf(r.err);
      for (const p of PREDICT_PARITIES) {
        const plain = codewordSuccess(cws, p, false);
        const erasures = codewordSuccess(cws, p, true);
        sums[p].plain += plain;
        sums[p].erasures += erasures;
        if (plain === 1) frameSums[p].plain++;
        if (erasures === 1) frameSums[p].erasures++;
      }
    }
    const predicted = {};
    const predictedFrame = {};
    for (const p of PREDICT_PARITIES) {
      predicted[p] = withCodewords
        ? { plain: sums[p].plain / withCodewords, erasures: sums[p].erasures / withCodewords }
        : { plain: null, erasures: null };
      predictedFrame[p] = withCodewords
        ? { plain: frameSums[p].plain / withCodewords, erasures: frameSums[p].erasures / withCodewords }
        : { plain: null, erasures: null };
    }
    const showings = showSet.size;
    rows.push({
      blockSize: first.blockSize, scheme: first.scheme, fps: first.fps, static: first.static,
      attempts: list.length,
      stageShares,
      okFrames: okSet.size,
      okShare: okAttempts / list.length,
      showings,
      newFramesPerSecond: okSet.size / (showings * PROBE_HOLD_MS / 1000),
      attemptsPerSecond: list.length / (showings * PROBE_HOLD_MS / 1000),
      decodeMsMedian: median(list.map((r) => r.decodeMs)),
      grabGapMedian: median(grabGaps(list)),
      cellErrorRate: cells ? cellErrors / cells : null,
      regionErrorRate: regionErrors.map((e) => (cells ? e / (cells / REGIONS) : null)),
      shiftShare: cellErrors ? shifts / cellErrors : null,
      predicted,
      predictedFrame,
      // Version 4 only: the good packets an attempt yields, per whole frame it
      // would have read; null without whole frames. An estimate without ids.
      partialGain: wholeAttempts > 0 ? (goodShare / maskAttempts) / (wholeAttempts / maskAttempts) : null,
    });
  }
  return rows.sort((a, b) => (b.blockSize ?? 0) - (a.blockSize ?? 0) || String(a.scheme).localeCompare(String(b.scheme)) || (a.fps ?? 0) - (b.fps ?? 0));
}
