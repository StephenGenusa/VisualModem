// The throughput check: sends a multi-frame file at each frame rate in turn
// and times how long the phone takes to collect it. A rate times out when no
// new frame has been collected for 3 loops of the file (at least 10 s); time
// the run spends paused does not count. No DOM; web/runner.js drives it.

export const FPS_STEPS = [2, 3, 5, 8];
export const THROUGHPUT_FRAMES = 12;
const MIN_IDLE_MS = 10000;
const IDLE_LOOPS = 3;

/**
 * @param {{ streamBytes: number, fpsSteps?: number[], frameCount?: number }} options
 */
export function createThroughputRun({ streamBytes, fpsSteps = FPS_STEPS, frameCount = THROUGHPUT_FRAMES }) {
  const results = [];
  let index = 0;
  let startedAt = null;
  let lastTick = null;
  let idleMs = 0;
  let lastHave = 0;
  let finished = false; // the current rate has a result and the next tick moves on

  const limitMs = (fps) => Math.max(MIN_IDLE_MS, (IDLE_LOOPS * frameCount * 1000) / fps);

  function record(result) {
    results.push(result);
    finished = true;
  }

  return {
    current: () => (index < fpsSteps.length ? { fps: fpsSteps[index] } : null),

    start(nowMs) {
      startedAt = nowMs;
      lastTick = nowMs;
      idleMs = 0;
      lastHave = 0;
      finished = false;
    },

    progress(have, nowMs) {
      if (have > lastHave) {
        lastHave = have;
        idleMs = 0;
        lastTick = nowMs;
      }
    },

    complete(nowMs) {
      if (finished || startedAt === null) return;
      const seconds = (nowMs - startedAt) / 1000;
      record({ fps: fpsSteps[index], seconds, bytesPerSecond: streamBytes / seconds, timedOut: false });
    },

    tick(nowMs, paused) {
      if (index >= fpsSteps.length) return 'done';
      if (!finished && startedAt !== null) {
        if (!paused) idleMs += nowMs - lastTick;
        lastTick = nowMs;
        if (idleMs >= limitMs(fpsSteps[index])) {
          record({ fps: fpsSteps[index], seconds: null, bytesPerSecond: null, timedOut: true });
        }
      }
      if (!finished) return 'running';
      index++;
      startedAt = null;
      finished = false;
      return index < fpsSteps.length ? 'next' : 'done';
    },

    results: () => results,
  };
}

/** Names the camera size the phone actually delivered. */
export function deliveredResolution({ width, height }) {
  const long = Math.max(width, height);
  if (long >= 3000) return '4k';
  if (long >= 1700 && long <= 2100 && Math.min(width, height) >= 1000 && Math.min(width, height) <= 1200) return '1080p';
  return 'other';
}
