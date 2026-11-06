// Failed reads run several times a second while the phone is not aimed, so
// their cost must stay bounded. The bound in use is wall clock: a failing read
// that is not angled costs at most 1.3x what it cost before the perspective
// pass, and an angled one 2.5x, measured as the median of 5 with
// utils/failed-read-time.mjs. Clocks are flaky on CI, so this test pins the
// work instead: for each failing image of that timed set, the strip cells
// the exact size search sampled (read.exactCells) and the marker candidates
// the finder passes examined (read.finderCandidates).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FAIL_CASES } from '../src/testutil/failcases.js';
import { decodeCameraFrame, joinedPair } from '../src/picture/reader.js';
import { toGray, binarize, findFinderCandidates } from '../src/picture/finder.js';

// [exactCells, finderCandidates] at most, per image: the values measured with
// `node utils/failed-read-time.mjs --json` with the perspective and recovery
// passes in place, plus 15 percent, rounded up. Each line's comment gives the
// measured values and the exactCells of the reader before the perspective
// pass, which had no finderCandidates. The counters are deterministic for these images.
const BOUNDS = {
  '295x166 4px lens': [146612, 426], // measured 127488 cells, 370 candidates; before the perspective pass 70208 cells
  '246x138 5px lens': [90197, 240], // measured 78432 cells, 208 candidates; before the perspective pass 46224 cells
  'no markers': [0, 0], // measured 0 cells, 0 candidates; before the perspective pass 0 cells
  'blurred noise': [106996, 686], // measured 93040 cells, 596 candidates; before the perspective pass 93040 cells
  'header unreadable 137x77': [685, 78], // measured 595 cells, 67 candidates; before the perspective pass 595 cells
  'header unreadable 202x113': [1983, 183], // measured 1724 cells, 159 candidates; before the perspective pass 1724 cells
  'out of view 202x113 x1.4': [44584, 180], // measured 38768 cells, 156 candidates; before the perspective pass 38768 cells
  'out of view 202x113 x1.6': [26680, 111], // measured 23200 cells, 96 candidates; before the perspective pass 23200 cells
  'out of view 202x113 x1.8': [15824, 81], // measured 13760 cells, 70 candidates; before the perspective pass 13760 cells
  'out of view 137x77 x1.3': [4748, 72], // measured 4128 cells, 62 candidates; before the perspective pass 4128 cells
  // Angled views that still fail (bound 2.5x in wall clock):
  'angled y35 d0.9 dim': [70840, 228], // measured 61600 cells, 198 candidates; before the perspective pass 44080 cells
  'angled y45 d0.9 dim': [25116, 175], // measured 21840 cells, 152 candidates; before the perspective pass 13920 cells
  'angled y45 d1.6 dim': [30802, 205], // measured 26784 cells, 178 candidates; before the perspective pass 13696 cells
  'angled y25 p10 d0.9 dim': [32309, 207], // measured 28094 cells, 180 candidates; before the perspective pass 13454 cells
};

for (const { name, build } of FAIL_CASES.filter((c) => c.kind !== 'reading')) {
  test(`a failed read keeps its work bound: ${name}`, () => {
    const { read, frame } = decodeCameraFrame(build());
    assert.equal(frame, null, `${name} should still fail`);
    const [cells, candidates] = BOUNDS[name];
    assert.ok((read.exactCells ?? 0) <= cells, `exactCells ${read.exactCells} over ${cells}`);
    assert.ok(Number.isInteger(read.finderCandidates), `finderCandidates ${read.finderCandidates}`);
    assert.ok(read.finderCandidates <= candidates, `finderCandidates ${read.finderCandidates} over ${candidates}`);
  });
}

test('every failing image of the timed set has a bound', () => {
  assert.deepEqual(FAIL_CASES.filter((c) => c.kind !== 'reading').map((c) => c.name).sort(), Object.keys(BOUNDS).sort());
});

// The recovery pre-check (joinedPair in reader.js) on a frontal 137x77 frame:
// the top-right and bottom-left markers sit on a diagonal with no strip
// between them, and each is joined to the small marker by version 4's right
// or bottom strip. This is the pair a view whose far top-left marker washed
// out still shows. No synthetic angled shot reproduced that washout end to end.
test('the recovery pre-check accepts a large and small marker joined by a strip', () => {
  const img = FAIL_CASES.find((c) => c.name === '137x77 9px').build();
  const gray = toGray(img);
  const search = { gray, width: img.width, height: img.height, scale: 1 };
  const cands = findFinderCandidates(binarize(gray, img.width, img.height), img.width, img.height);
  const nearest = (size, x, y) => cands.filter((c) => c.size === size).sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y))[0];
  const tr = nearest(7, img.width, 0), bl = nearest(7, 0, img.height), br = nearest(5, img.width, img.height);
  assert.ok(tr.x > 1500 && tr.y < 300 && bl.x < 400 && bl.y > 800 && br.x > 1500 && br.y > 800, 'markers found');
  assert.equal(joinedPair(search, [tr, bl]), false, 'a diagonal has no strip');
  assert.equal(joinedPair(search, [tr, bl], [br]), true, 'right or bottom strip');
  assert.equal(joinedPair(search, [tr], [br]), true, 'right strip');
  assert.equal(joinedPair(search, [bl], [br]), true, 'bottom strip');
});
