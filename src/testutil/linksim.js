// Test and tool helper: a noisy stand-in for the screen, camera and phone, so a
// search for the best settings can be judged over many runs with no hardware.
// The rate model is anchored on repeated file runs on the test setup (block 23,
// 200 KB file); what those runs did not measure is a stated assumption, and the
// absolute numbers matter only as a fixture.
import { random32 } from '../optimize/prbs.js';
import { BASE_SPACE, EARLY_MS, SWITCH_MS, TEST_MS, START_READS_PER_SECOND, candidateKey } from '../optimize/search.js';
import { fitGrid, computeLayoutV4 } from '../picture/layout.js';
import { frameShapeV4 } from '../core/framev4.js';

const FILE_BYTES = 200000;

// The test setup's screen and scheme, which set what a frame can carry.
const SCREEN = { width: 3840, height: 2160 };
const SCHEME = { kind: 'rgb', levels: [2, 2, 2] };
const frameBytesCache = new Map();

/** The data bytes in one frame at a block size and parity. */
function frameBytes(blockSize, parity) {
  const key = blockSize * 1000 + parity;
  let bytes = frameBytesCache.get(key);
  if (bytes === undefined) {
    const { cols, rows } = fitGrid(SCREEN.width, SCREEN.height, blockSize);
    const shape = frameShapeV4(computeLayoutV4(cols, rows), SCHEME, parity);
    bytes = shape.packets * shape.packetBytes;
    frameBytesCache.set(key, bytes);
  }
  return bytes;
}

/** The most a setting could carry on the test setup's screen, in bytes per second. */
export function screenCeiling({ blockSize, parity, fps }, readsPerSecond = START_READS_PER_SECOND) {
  return frameBytes(blockSize, parity) * Math.min(fps, readsPerSecond);
}

// Mean seconds for the file at block 23, parity 32. 6 and 7.5 fps were not
// measured: they are taken as the 10 fps rate scaled by frames shown.
const FPS_RATE = [
  [6, (FILE_BYTES / 6.24) * 0.6],
  [7.5, (FILE_BYTES / 6.24) * 0.75],
  [10, FILE_BYTES / 6.24],
  [12, FILE_BYTES / 6.47],
  [15, FILE_BYTES / 6.77],
  [20, FILE_BYTES / 7.74],
  [30, FILE_BYTES / 15.07],
];
// Against parity 32. Parity 16 at 15 fps measured about the same as 32 (6.72 s
// and 6.77 s, each within the noise); 0 and 8 are weak; above 32 only the data
// share falls. White is assumed, with 191 losing visible contrast.
const PARITY_SHARE = [[0, 0.4], [8, 0.7], [16, 0.99], [24, 0.995], [32, 1], [40, 0.965], [48, 0.93]];
const WHITE_SHARE = [[191, 0.85], [223, 0.97], [255, 1]];

// Share of frames read at a block size: a cliff, assumed to rise slowly with the
// frame rate, placed so that block 23 is the best and block 19 mostly fails.
const CLIFF_BLOCK = 20.3;
const CLIFF_WIDTH = 0.8;
const CLIFF_PER_FPS = 0.1;
const NOMINAL_BLOCK = 23;

// A rate this low gives no good pieces in the early check.
const DEAD_RATE = 1000;
// The measured rate of phone reads on the test setup.
const READS_PER_SECOND = START_READS_PER_SECOND;
const EARLY_READS = 5;

function lookup(table, x) {
  if (x <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    if (x <= table[i][0]) {
      const [x0, y0] = table[i - 1];
      const [x1, y1] = table[i];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return table[table.length - 1][1];
}

function readShare(blockSize, fps) {
  const edge = CLIFF_BLOCK + CLIFF_PER_FPS * Math.max(0, fps - 10);
  return 1 / (1 + Math.exp((edge - blockSize) / CLIFF_WIDTH));
}

/** The rate a candidate would average with no noise, in bytes per second. No setting beats what its frames carry. */
export function trueRate(candidate) {
  const { blockSize, parity, fps, white } = candidate;
  const blockShare = ((NOMINAL_BLOCK / blockSize) ** 2 * readShare(blockSize, fps)) / readShare(NOMINAL_BLOCK, fps);
  const rate = lookup(FPS_RATE, fps) * blockShare * lookup(PARITY_SHARE, parity) * lookup(WHITE_SHARE, white);
  return Math.min(rate, screenCeiling(candidate));
}

const stepsAlong = (axis, a, b) => {
  const at = (v) => {
    const i = axis.indexOf(v);
    return i >= 0 ? i : (v - axis[0]) / (axis[1] - axis[0]);
  };
  return Math.abs(at(a) - at(b));
};

/** A rate falling from a peak by a share of a log per step along each setting, up to what frames carry. */
export function peakRate(peak, { base = 30000, block = 0.06, parity = 0.03, fps = 0.06, white = 0.05 } = {}) {
  return (c) => Math.min(screenCeiling(c), base * Math.exp(
    -block * stepsAlong(BASE_SPACE.blockSize, c.blockSize, peak.blockSize)
    - parity * stepsAlong(BASE_SPACE.parity, c.parity, peak.parity)
    - fps * stepsAlong(BASE_SPACE.fps, c.fps, peak.fps)
    - white * stepsAlong(BASE_SPACE.white, c.white, peak.white)));
}

/** A link whose best is away from the defaults, on a gentle slope. */
export const shiftedRate = peakRate({ blockSize: 27, parity: 24, fps: 12, white: 255 });

const NEAR_PEAK = peakRate({ blockSize: 23, parity: 32, fps: 10, white: 255 }, { block: 0.1, parity: 0.1, fps: 0.1 });
const FAR_PEAK = peakRate({ blockSize: 27, parity: 8, fps: 15, white: 255 }, { base: 39000, block: 0.2, parity: 0.2, fps: 0.2 });
/** A link with two separate peaks: the defaults' and, three settings away, one 30% higher that frames can carry. */
export const twoPeakRate = (c) => Math.max(NEAR_PEAK(c), FAR_PEAK(c));
/** The candidates near the higher of two peaks. */
export const nearHigherPeak = (c) => twoPeakRate(c) > 39000 * 0.75 && FAR_PEAK(c) > NEAR_PEAK(c);

/** A link on which one setting, and everything with smaller blocks and higher rates, reads nothing. */
export const withDeadArea = (rate, { blockSize, fps }) => (c) => ((c.blockSize <= blockSize && c.fps >= fps) ? 0 : rate(c));

/** The highest rate anywhere in the unrestricted space. */
export function bestTrueRate(rate = trueRate) {
  let best = 0;
  for (const blockSize of BASE_SPACE.blockSize) {
    for (const parity of BASE_SPACE.parity) {
      for (const fps of BASE_SPACE.fps) {
        for (const white of BASE_SPACE.white) {
          best = Math.max(best, rate({ blockSize, parity, fps, white }));
        }
      }
    }
  }
  return best;
}

/** A seeded source of values in [0, 1). */
export function seededRandom(seed) {
  const next = random32(seed);
  return () => next() / 0x100000000;
}

/**
 * @param {{ random: () => number, noise?: number, rate?: Function, screenNoiseFactor?: number }} options
 *   noise is the standard deviation on a log scale of a 6 s test's reading; run
 *   to run the test setup varied by about 12%. A shorter test sees fewer pieces,
 *   so its noise scales with the square root of 6 over its seconds. rate replaces
 *   the true rate, to try other links. screenNoiseFactor widens the noise of tests
 *   shorter than 6 s, as the plausible range until a real measurement.
 */
export function createLinkSim({ random, noise = 0.12, rate = trueRate, screenNoiseFactor = 1 }) {
  const gaussian = () => {
    const u = 1 - random(); // in (0, 1], so the log is finite
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
  };
  return {
    rate,
    /** A reading of one test, with the time it really took: a dead test ends at the early check. */
    measure(candidate, testMs = TEST_MS) {
      const scaled = noise * Math.sqrt(TEST_MS / testMs) * (testMs < TEST_MS ? screenNoiseFactor : 1);
      const bytesPerSecond = rate(candidate) * Math.exp(scaled * gaussian());
      if (bytesPerSecond < DEAD_RATE) {
        return { bytesPerSecond: 0, reads: EARLY_READS, zeroAtEarlyCheck: true, testMs: Math.min(EARLY_MS, testMs) };
      }
      return { bytesPerSecond, reads: Math.round((READS_PER_SECOND * testMs) / 1000), zeroAtEarlyCheck: false, testMs };
    },
  };
}

/**
 * Runs a search on a simulator to its end with no sleeping, charging each test
 * its real time. wasteMs is the time on candidates under half the true best.
 */
export function runSearch(search, sim, limitMs, { rate = sim.rate } = {}) {
  const best = bestTrueRate(rate);
  let usedMs = 0;
  let wasteMs = 0;
  let tests = 0;
  let repeats = 0;
  const tried = new Set();
  while (true) {
    const step = search.next(limitMs - usedMs);
    if (!step) break;
    const reading = sim.measure(step.candidate, step.testMs);
    search.record(step.candidate, reading);
    const costMs = reading.testMs + SWITCH_MS;
    usedMs += costMs;
    tests++;
    const key = candidateKey(step.candidate);
    if (tried.has(key)) repeats++;
    tried.add(key);
    if (rate(step.candidate) < 0.5 * best) wasteMs += costMs;
  }
  return { usedMs, wasteMs, tests, tried: tried.size, repeats };
}
