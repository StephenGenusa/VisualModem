// Frame timing on display refreshes. The stage changes frames on
// requestAnimationFrame refreshes, every refreshesPerFrame of them, so each
// frame stays up for a whole number of refreshes. No DOM; pure.
import { random32 } from '../optimize/prbs.js';

const COMMON_HZ = [50, 60, 100, 120, 144];

/**
 * The refresh rate from requestAnimationFrame timestamps: the median interval,
 * so a stalled refresh does not move it, snapped to a common rate when within
 * 3 percent of one, else rounded.
 * @param {number[]} timestampsMs at least two, in order
 * @returns {number} Hz
 */
export function estimateRefreshHz(timestampsMs) {
  const gaps = [];
  for (let i = 1; i < timestampsMs.length; i++) gaps.push(timestampsMs[i] - timestampsMs[i - 1]);
  gaps.sort((a, b) => a - b);
  const mid = gaps.length >> 1;
  const median = gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
  const hz = 1000 / median;
  for (const common of COMMON_HZ) if (Math.abs(hz - common) <= common * 0.03) return common;
  return Math.round(hz);
}

/** Refreshes each frame stays up for: an integer of at least 1. */
export function refreshesPerFrame(refreshHz, fps) {
  return Math.max(1, Math.round(refreshHz / fps));
}

/** The frame rate actually shown when frames change every refreshesPerFrame refreshes. */
export function actualFps(refreshHz, fps) {
  return refreshHz / refreshesPerFrame(refreshHz, fps);
}

/**
 * The rate the stage will really show for a slider value on a screen, and
 * whether it differs from the slider's by more than 0.01.
 * @returns {{ fps: number, differs: boolean }}
 */
export function shownRate(fps, refreshHz) {
  const shown = actualFps(refreshHz, fps);
  return { fps: shown, differs: Math.abs(shown - fps) > 0.01 };
}

/**
 * Distinct cells, by index in a cols x rows grid, for the stage's pixel
 * self-check: count of them (or every cell when the grid is smaller), the
 * same for a seed.
 */
export function checkCells(cols, rows, count, seed) {
  const total = cols * rows;
  if (total <= count) return Array.from({ length: total }, (_, i) => i);
  const next = random32(seed);
  const cells = new Set();
  while (cells.size < count) cells.add(next() % total);
  return [...cells];
}
