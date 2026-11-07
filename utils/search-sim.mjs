// Usage: SEED_SET=0 node utils/search-sim.mjs [runs] [noise[xfactor] ...]
// Prints how the search does on the noisy simulator: for each link, starting
// point and time limit, how close the winner gets, the share of tests that are
// new settings, the settings tried and skipped, the tests repeated and how often
// the true best was read in screening but got no full test. A noise of 0.12x2
// doubles screening noise, the plausible range until a real measurement.
import { createSearch, candidateKey, BASE_SPACE } from '../src/optimize/search.js';
import {
  createLinkSim, bestTrueRate, seededRandom, runSearch, screenCeiling, trueRate, shiftedRate, twoPeakRate, nearHigherPeak, withDeadArea,
} from '../src/testutil/linksim.js';

const RUNS = Number(process.argv[2] ?? 200);
const NOISES = (process.argv.length > 3 ? process.argv.slice(3) : ['0.12', '0.25', '0.12x2']).map((arg) => {
  const [noise, factor = '1'] = arg.split('x');
  return { arg, noise: Number(noise), screenNoiseFactor: Number(factor) };
});
const OFFSET = Number(process.env.SEED_SET ?? 0) * 100000;
const DEFAULTS = { blockSize: 23, parity: 32, fps: 10, white: 255 };
const POOR = { blockSize: 35, parity: 0, fps: 30, white: 255 };
const LINKS = [['standard', trueRate], ['shifted', shiftedRate], ['two-peak', twoPeakRate]];
const STARTS = [['defaults', [DEFAULTS], (rate) => rate], ['poor', [POOR], (rate) => rate], ['dead', [DEFAULTS], (rate) => withDeadArea(rate, DEFAULTS)]];
const pct = (x) => `${(x * 100).toFixed(1)}%`.padStart(7);
const column = (v, width) => String(v).padStart(width);
/** The key of the best setting at full white, where screening looks. */
function bestSetting(rate, best) {
  for (const blockSize of BASE_SPACE.blockSize) {
    for (const parity of BASE_SPACE.parity) {
      for (const fps of BASE_SPACE.fps) {
        const c = { blockSize, parity, fps, white: 255 };
        if (rate(c) === best) return candidateKey(c);
      }
    }
  }
  return null;
}
const average = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

console.log(`${RUNS} runs each. noise is for a 6 s test. Closeness is the winner's true rate against the best.`);
console.log('link     start    min   noise  in  5%  in 10%  in 15%    mean  tests newtst screen   full repeat  waste   prov. skip  untst lostbst  peak2');
for (const { arg, noise, screenNoiseFactor } of NOISES) {
  for (const [linkName, linkRate] of LINKS) {
    for (const [startName, seeds, adapt] of STARTS) {
      const rate = adapt(linkRate);
      const best = bestTrueRate(rate);
      const atBest = bestSetting(rate, best);
      for (const minutes of [1, 3, 5, 30]) {
        const shares = [];
        const tests = [];
        const screened = [];
        const full = [];
        const repeats = [];
        const newShare = [];
        let wasteMs = 0;
        let usedMs = 0;
        let provisional = 0;
        let higher = 0;
        let lostBest = 0;
        const skipped = [];
        const untested = [];
        for (let i = 0; i < RUNS; i++) {
          const search = createSearch({
            cap: 80, seeds, fixed: { scheme: 'cube' }, random: seededRandom(OFFSET + i * 2 + 1), ceilingOf: screenCeiling, longRun: minutes >= 30,
          });
          const sim = createLinkSim({ random: seededRandom(OFFSET + i * 2 + 2), noise, rate, screenNoiseFactor });
          const run = runSearch(search, sim, minutes * 60000);
          const r = search.result();
          const pick = r.winner ?? r.leader;
          shares.push(pick ? rate(pick) / best : 0);
          if (pick && linkName === 'two-peak' && nearHigherPeak(pick)) higher++;
          if (r.provisional) provisional++;
          tests.push(run.tests);
          screened.push(r.coverage.screened);
          skipped.push(r.coverage.skippedByCeiling ?? 0);
          untested.push(r.coverage.untestedPlausible ?? 0);
          const row = r.ranked.find((x) => candidateKey(x.candidate) === atBest);
          if (row && row.rough !== null && row.readings === 0) lostBest++;
          full.push(r.coverage.full);
          repeats.push(run.repeats);
          newShare.push(run.tried / Math.max(1, run.tests));
          wasteMs += run.wasteMs;
          usedMs += run.usedMs;
        }
        const within = (t) => shares.filter((s) => s >= 1 - t).length / RUNS;
        console.log([
          linkName.padEnd(8), startName.padEnd(8), column(minutes, 3), column(arg, 7),
          pct(within(0.05)), pct(within(0.1)), pct(within(0.15)), pct(average(shares)),
          column(average(tests).toFixed(1), 6), pct(average(newShare)).slice(1), column(average(screened).toFixed(1), 6), column(average(full).toFixed(1), 6),
          column(average(repeats).toFixed(1), 6), pct(wasteMs / usedMs).slice(1), pct(provisional / RUNS),
          column(average(skipped).toFixed(0), 4), column(average(untested).toFixed(0), 5), pct(lostBest / RUNS),
          linkName === 'two-peak' ? pct(higher / RUNS) : '      -',
        ].join(' '));
      }
    }
  }
}
