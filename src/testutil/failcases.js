// The images whose failed reads bound the reader's cost.
// utils/failed-read-time.mjs times them and test/failcost.test.js pins the
// reader's work counters on them. Each case is { name, kind, build }:
// - kind 'plain': a failing read that is not angled. It may cost at most 1.3x
//   what it cost before the perspective pass.
// - kind 'angled': an angled view that still fails. It may cost up to 2.5x.
// - kind 'reading': a read that succeeds, timed to show it keeps its timing.
import { computeLayoutV4 } from '../picture/layout.js';
import { renderFrame } from '../picture/render.js';
import { frameToBlocksV4 } from '../core/framev4.js';
import { buildProbeFrameV4 } from '../optimize/probes.js';
import { warpToQuad, tiltQuad, lensDistort, blur, brightnessContrast, noise } from './distort.js';
import { angledShot } from './angled.js';

const W = 1920, H = 1080;
const scheme = { kind: 'rgb', levels: [2, 2, 2] };

function seeded(seed) {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}

// A version 4 probe frame on screen. With shuffle, its data blocks are put in
// a random order: the markers, timing strips and ramp stay, so the grid fits,
// and neither header copy reads.
function probeScreen(cols, rows, blockPx, shuffle = false) {
  const layoutV4 = computeLayoutV4(cols, rows);
  const probe = { id: 1, blockSize: blockPx, scheme, parity: 32, fps: 4 };
  const { frameBytes } = buildProbeFrameV4({ probe, txId: 9, index: 0, layoutV4, probeCount: 5 });
  const blocks = frameToBlocksV4(frameBytes, scheme, layoutV4);
  if (shuffle) {
    const rnd = seeded(12345);
    for (let i = blocks.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [blocks[i], blocks[j]] = [blocks[j], blocks[i]];
    }
  }
  return renderFrame({ frameBytes, index: 0, scheme, blockSize: blockPx, layout: layoutV4, blocks, version: 4 });
}

// The camera view of utils/failed-read-time.mjs: a 3 degree tilt filling 88
// percent of 1080p. scale > 1 enlarges the view about a point left of and above
// the center, so the frame's right and bottom sides run out of view.
function camera(screen, { k1 = 0, blurPx = 1, scale = 1 } = {}) {
  let q = tiltQuad(screen.width, screen.height, W, H, 3, 0.88);
  if (scale !== 1) q = q.map(([x, y]) => [x * scale - 100, y * scale - (scale - 1) * 300]);
  let img = warpToQuad(screen, q, W, H);
  if (k1) img = lensDistort(img, k1);
  return noise(brightnessContrast(blur(img, blurPx), 0.2, 0.9), 3, 5);
}

// A dark 1080p image with no markers: gray 30 with noise.
function noMarkers() {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) data.set([30, 30, 30, 255], i * 4);
  return noise({ data, width: W, height: H }, 6, 1);
}

// Dark gray (30) with noise of sigma 48, then blurred 2 px: speckle the size of a marker
// module, which gives the finder over a hundred large marker candidates and no frame.
function blurredNoise() {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) data.set([30, 30, 30, 255], i * 4);
  return blur(noise({ data, width: W, height: H }, 48, 3), 2);
}

const angled = (a) => () => angledShot({ cols: 137, rows: 77, ...a }).img;

export const FAIL_CASES = [
  // Grids too fine to fit.
  { name: '295x166 4px lens', kind: 'plain', build: () => camera(probeScreen(295, 166, 4), { k1: 0.02, blurPx: 2 }) },
  { name: '246x138 5px lens', kind: 'plain', build: () => camera(probeScreen(246, 138, 5), { k1: 0.02, blurPx: 3 }) },
  { name: 'no markers', kind: 'plain', build: noMarkers },
  { name: 'blurred noise', kind: 'plain', build: blurredNoise },
  // The grid fits on all four strips and no header reads.
  { name: 'header unreadable 137x77', kind: 'plain', build: () => camera(probeScreen(137, 77, 9, true)) },
  { name: 'header unreadable 202x113', kind: 'plain', build: () => camera(probeScreen(202, 113, 6, true)) },
  // Frames running out of view (the right and bottom sides cut), as while aiming.
  { name: 'out of view 202x113 x1.4', kind: 'plain', build: () => camera(probeScreen(202, 113, 6), { scale: 1.4 }) },
  { name: 'out of view 202x113 x1.6', kind: 'plain', build: () => camera(probeScreen(202, 113, 6), { scale: 1.6 }) },
  { name: 'out of view 202x113 x1.8', kind: 'plain', build: () => camera(probeScreen(202, 113, 6), { scale: 1.8 }) },
  { name: 'out of view 137x77 x1.3', kind: 'plain', build: () => camera(probeScreen(137, 77, 9), { scale: 1.3 }) },
  // Angled views that still fail (test/angled.test.js todo cases and beyond).
  { name: 'angled y35 d0.9 dim', kind: 'angled', build: angled({ yawDeg: 35, distance: 0.9, dim: 0.35, blurPx: 2 }) },
  { name: 'angled y45 d0.9 dim', kind: 'angled', build: angled({ yawDeg: 45, distance: 0.9, dim: 0.35, blurPx: 2 }) },
  { name: 'angled y45 d1.6 dim', kind: 'angled', build: angled({ yawDeg: 45, distance: 1.6, dim: 0.35, blurPx: 2 }) },
  { name: 'angled y25 p10 d0.9 dim', kind: 'angled', build: angled({ yawDeg: 25, pitchDeg: 10, distance: 0.9, dim: 0.35, blurPx: 2 }) },
  // Reads that succeed.
  { name: '202x113 6px', kind: 'reading', build: () => camera(probeScreen(202, 113, 6)) },
  { name: '137x77 9px', kind: 'reading', build: () => camera(probeScreen(137, 77, 9)) },
];
