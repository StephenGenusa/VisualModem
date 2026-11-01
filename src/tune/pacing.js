// Pacing of the receiver's camera attempts. The next attempt starts when the
// worker replies, but not before the camera can have produced a new frame
// (one frame of a 30 fps camera). A little random jitter keeps the sampling
// moments from locking onto the sender's frame changes.

export const MIN_GAP_MS = 34;
export const JITTER_MS = 15;

/**
 * @param {{ sinceGrabMs: number, random?: () => number }} args
 * @returns {number} ms to wait before the next grab
 */
export function nextAttemptDelay({ sinceGrabMs, random = Math.random }) {
  return Math.max(0, MIN_GAP_MS - sinceGrabMs) + JITTER_MS * random();
}
