// Scores probes by light-only throughput: bytes per frame x the distinct new
// frames the phone reads per second (never more than the frames shown per
// second), with the read rate's Wilson lower bound used to rank. No DOM.
// See the spec, "Version 3: the optimizer".

import { PROBE_FPS, PROBE_HOLD_MS } from './probes.js';

const COLUMN_TOLERANCE = 0.08; // a headerless attempt matches a probe within this share of its columns
const MIN_ATTEMPTS = 6;
const MIN_READ_RATE = 0.5;
const FPS_STEP = 0.5;
const FPS_MIN = 0.5;
const FPS_MAX = 10;
// Attempts on one probe closer together than this are one showing of it; their
// gaps give the phone's attempt rate on that probe. Failed decodes take longer,
// so each probe needs its own.
const SHOWING_GAP_MS = 1500;
const MIN_GAPS = 3;
const WILSON_Z = 1.2816; // 80 percent, one-sided

// The Wilson lower bound on a read rate of ok in n attempts.
function wilsonLow(ok, n) {
  if (n <= 0) return 0;
  const p = ok / n, z2 = WILSON_Z * WILSON_Z;
  const centre = p + z2 / (2 * n);
  const margin = WILSON_Z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.max(0, (centre - margin) / (1 + z2 / n));
}

/**
 * @param {Array<{ id: number, fps: number }>} probes
 * @param {{ bytesPerFrame: (probe: object) => number }} options
 */
export function createScorer(probes, { bytesPerFrame, packetBytes = () => 0, packetCount = () => 0 }) {
  const tally = new Map(probes.map((p) => [p.id, { attempts: 0, ok: 0, lastMs: null, gaps: 0, gapMs: 0, frames: new Set(), packets: 0, whole: 0, live: new Map(), ended: new Set(), v4: false, n: 0, txIds: new Set(), fps: null, isStatic: false }]));
  const probeOf = new Map(probes.map((p) => [p.id, p]));
  let lastSeen = null; // the probe id of the latest attempt that read a header
  let pending = []; // headerless misses matching lastSeen, charged only if the next header names it too

  function count(t, atMs, ok) {
    if (t.lastMs !== null && atMs - t.lastMs > 0 && atMs - t.lastMs < SHOWING_GAP_MS) {
      t.gaps++;
      t.gapMs += atMs - t.lastMs;
    }
    t.lastMs = atMs;
    t.attempts++;
    if (ok) t.ok++;
  }

  // fallbackRate is used for a probe with too few attempts in one showing to time.
  function results(fallbackRate) {
    return probes.map((probe) => {
      const { attempts, ok, gaps, gapMs, frames, txIds, fps: seenFps, isStatic, packets, whole, v4, n: seenN } = tally.get(probe.id);
      const n = packetCount(probe) || seenN;
      const fps = seenFps ?? PROBE_FPS;
      const readRate = attempts > 0 ? ok / attempts : 0;
      const attemptRate = gaps >= MIN_GAPS ? (gaps * 1000) / gapMs : fallbackRate;
      const readsPerSecond = Math.min(attemptRate * readRate, fps);
      const okFrames = frames.size, showings = txIds.size;
      const newFramesPerSecond = showings > 0 ? Math.min(okFrames / ((showings * PROBE_HOLD_MS) / 1000), fps) : 0;
      let bytesPerSecond = attempts < MIN_ATTEMPTS ? null : bytesPerFrame(probe) * newFramesPerSecond;
      let extra = {};
      if (v4) {
        // Version 4: packets are the unit. A whole frame has every packet good.
        const wholeFrames = n > 0 ? whole : 0;
        const newPacketsPerSecond = showings > 0 && n > 0 ? Math.min(packets / ((showings * PROBE_HOLD_MS) / 1000), n * fps) : 0;
        const partialGain = wholeFrames > 0 ? packets / n / wholeFrames : null;
        bytesPerSecond = attempts < MIN_ATTEMPTS ? null : packetBytes(probe) * newPacketsPerSecond;
        extra = { packets, packetCount: n, newPacketsPerSecond, wholeFrames, partialGain };
      }
      return {
        ...extra,
        probe, attempts, ok, readRate, readRateLow: wilsonLow(ok, attempts), attemptRate, readsPerSecond,
        okFrames, showings, newFramesPerSecond, fps, isStatic, bytesPerSecond,
      };
    });
  }

  return {
    /**
     * One camera attempt. With a header it counts for that probe; without
     * one it is a miss for the probe seen last, but only when the grid the
     * markers suggest matches that probe's columns, and only once the next
     * header names the same probe (a miss at a probe change belongs to the
     * probe that was leaving, or to none, not to the one before it).
     */
    addAttempt({ atMs, header, ok, estCols, colsOf }) {
      if (header) {
        // The next header settles the held misses: charged if it is the same
        // probe, dropped otherwise. A header that is not one of these probes
        // (a data or characterization frame) is no miss for any probe.
        const held = pending;
        pending = [];
        const t = tally.get(header.probeId);
        if (held.length && header.probeId === lastSeen) for (const ms of held) count(tally.get(lastSeen), ms, false);
        if (!t) return;
        lastSeen = header.probeId;
        const v4 = header.version === 4;
        const ids = v4 ? (header.symbolIds ?? []) : [];
        // A version 4 attempt reads when at least one packet is good.
        count(t, atMs, v4 ? ids.length > 0 : ok);
        t.txIds.add(header.txId ?? 0);
        if (v4) {
          t.v4 = true;
          if (header.packetCount > 0) t.n = header.packetCount;
          const n = packetCount(probeOf.get(header.probeId)) || t.n;
          // Counts are kept incrementally. Only the showing in progress keeps
          // its packet ids (per frame, dropped when the frame completes); a
          // showing that has ended keeps nothing but its txId.
          const tx = header.txId ?? 0;
          if (!t.ended.has(tx)) {
            for (const other of t.live.keys()) if (other !== tx) { t.live.delete(other); t.ended.add(other); }
            if (!t.live.has(tx)) t.live.set(tx, new Map());
            const frames = t.live.get(tx);
            for (const id of ids) {
              const f = n > 0 ? Math.floor(id / n) : -1;
              let ks = frames.get(f);
              if (ks === true) continue; // the frame is complete: all its ids were counted
              if (!ks) { ks = new Set(); frames.set(f, ks); }
              if (ks.has(id)) continue;
              ks.add(id);
              t.packets++;
              if (n > 0 && ks.size >= n) { frames.set(f, true); t.whole++; }
            }
          }
        } else if (ok) t.frames.add(`${header.txId ?? 0}:${header.index ?? 0}`);
        if (t.fps === null) t.fps = header.probeFps > 0 ? header.probeFps : PROBE_FPS;
        if (header.probeStatic) t.isStatic = true;
        return;
      }
      if (lastSeen === null || !(estCols > 0)) return;
      const cols = colsOf(lastSeen);
      if (cols > 0 && Math.abs(estCols - cols) <= COLUMN_TOLERANCE * cols) pending.push(atMs);
    },

    results,

    /**
     * The best probe among those read at least half the time, never a static
     * one: bytes per frame x new frames a second, scaled down to the read
     * rate's lower bound. The frame rate is the reads per second, in the
     * slider's 0.5 steps, never above what the probe showed.
     */
    recommend(fallbackRate) {
      let best = null, bestScore = 0;
      for (const r of results(fallbackRate)) {
        if (r.bytesPerSecond === null || r.readRate < MIN_READ_RATE || r.isStatic) continue;
        const score = r.readRate > 0 ? (r.bytesPerSecond * r.readRateLow) / r.readRate : 0;
        if (!best || score > bestScore) { best = r; bestScore = score; }
      }
      if (!best) return null;
      const steps = Math.floor(best.readsPerSecond / FPS_STEP) * FPS_STEP;
      const fps = Math.min(FPS_MAX, best.fps, Math.max(FPS_MIN, steps));
      const bytesPerSecond = best.packets !== undefined
        ? packetBytes(best.probe) * Math.min(best.newPacketsPerSecond, best.packetCount * fps)
        : bytesPerFrame(best.probe) * fps;
      return { probe: best.probe, bytesPerSecond, fps, partialGain: best.partialGain ?? null };
    },
  };
}
