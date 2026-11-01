// Camera path: reads a frame from a camera image. Finds the finder markers,
// maps grid coordinates to image pixels, checks the grid size against the
// timing strips, calibrates levels and thresholds from the calibration ramp,
// samples every data cell and parses the frame. Grid coordinates are block
// units with cell (col, row) centered at (col + 0.5, row + 0.5).

import { toGray, toGrayHalf, binarize, findFinderCandidates, orientFinders } from './finder.js';
import { homographyFromPoints, affineFromPoints, applyHomography } from './homography.js';
import { computeLayout, computeLayoutV4, HEADER_CELLS_V4, MIN_COLS, MIN_ROWS, BOTTOM_TIMING_START } from './layout.js';
import { bytesFromBlocks, decideLevel } from '../core/symbols.js';
import { parseFrame, peekHeader, headerBytesFromBlocks, blocksToFrameBytes, VERSION, HEADER_CELLS, HEADER_SCHEME } from '../core/frame.js';
import { schemeName } from '../core/scheme.js';
import { peekHeaderV4, blocksToFrameBytesV4, parseFrameV4, HEADER_CODEWORD_V4 } from '../core/framev4.js';

const RAMP_LENGTH = 16;
const STEP_OPTIONS = [16, 8, 4, 2]; // largest first; 16 steps also covers 256 levels
const MIN_STEP_GAP = 6; // luminance units
const GAP_TO_SPREAD = 2;
// Pixel noise forms tiny 1:1:3:1:1 patterns that pass the finder's ratio test.
// A real marker this small could not be sampled anyway, so drop them before orienting.
const MIN_PITCH = 3; // image pixels per block
// From this many pixels (more than 1080p) the markers are first looked for at
// half size, which costs a quarter of the time; the grid is still fitted and
// read at full size. 95 percent of a 4K decode was the full size search.
const HALF_SIZE_PIXELS = 3_000_000;
const SIZE_SEARCH_FRACTION = 0.1; // grid size search reach, as a share of the estimate
// Grid correction from the timing strips (see measureStripOffsets).
const EDGE_REACH = 0.6; // how far from the predicted edge to look, in blocks
const EDGE_STEP = 0.05; // search step, in blocks
const EDGE_SAMPLES_OFFSET = Math.ceil(EDGE_REACH / EDGE_STEP) + 1; // sample index j + offset, j from -13
const EDGE_SAMPLES = 2 * EDGE_SAMPLES_OFFSET + 1;
const MIN_EDGE_STRENGTH = 20; // luminance step that counts as a real edge
const MAX_CORRECTION = 0.45; // blocks
const MIN_EDGES = 8;
const TIMING_SLACK = 2; // strip cells that may misread before the grid size is rejected
const NEAR_MATCH = 0.3; // an uncorrected strip at least this right is worth correcting; a quarter block of drift leaves the true size near 50 percent
const MIDDLE_CELLS = 16; // strip cells in the quick test before an exact size check
const CORRECTED_REACH = 3; // the corrected search only tries sizes this close to the estimate
// The other strip pairs of a version 4 frame are tried only this close to the
// estimate, after the top and left strips failed at every size: the exact
// search tries about a thousand sizes per marker candidate, and each costs
// another strip test on a read that may fail anyway. A tilted frame's
// estimate can be off by 3 columns, so this is the corrected reach.
const FALLBACK_REACH = CORRECTED_REACH;
// A strip outside the accepted pair is measured for the blend only when it
// already reads this nearly right; random data cells change about half the time.
const EXTRA_MATCH = 0.8;
// Radial lens strengths tried, about the image center, with r normalized to
// half the diagonal: image point o and undistorted point u = o * (1 + k r^2).
const LENS_STEPS = [0, -0.01, 0.01, -0.02, 0.02, -0.03, 0.03, -0.04, 0.04, -0.06, 0.06];

const luminance = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b;

// ---- locate: markers, grid size, homography ----

function gridToImage(markers, cols, rows) {
  const { tl, tr, bl, br } = markers;
  const src = [[3.5, 3.5], [cols - 3.5, 3.5], [3.5, rows - 3.5], [cols - 2.5, rows - 2.5]];
  return br
    ? homographyFromPoints(src, [tl, tr, bl, br])
    : affineFromPoints(src.slice(0, 3), [tl, tr, bl]);
}

// The grid geometry: a radial lens model, the homography from the lens-free
// marker positions, and a smooth correction along each axis measured on the
// timing strips. A camera lens bends the grid (columns drift sideways and the
// top and bottom rows bow), so four markers alone mispredict a long strip.
// fx(gx, gy) and fy(gx, gy) are the corrections; from the top and left strips
// alone fx depends on gx only and fy on gy only. A version 4 frame's bottom
// and right strips let fx vary with the row and fy with the column.
const ZERO = () => 0;
const NO_LENS = null;
const plainGeometry = (H) => ({ H, lens: NO_LENS, fx: ZERO, fy: ZERO });

// lens = { k, cx, cy, half }. Forward: image point to its lens-free position.
function unbend(lens, [x, y]) {
  if (!lens) return [x, y];
  const dx = (x - lens.cx) / lens.half, dy = (y - lens.cy) / lens.half;
  const s = 1 + lens.k * (dx * dx + dy * dy);
  return [lens.cx + dx * s * lens.half, lens.cy + dy * s * lens.half];
}

// Inverse: lens-free position to the image point, by fixed point iteration.
function bend(lens, [ux, uy]) {
  if (!lens) return [ux, uy];
  let x = ux, y = uy;
  for (let i = 0; i < 4; i++) {
    const dx = (x - lens.cx) / lens.half, dy = (y - lens.cy) / lens.half;
    const s = 1 + lens.k * (dx * dx + dy * dy);
    x = lens.cx + (ux - lens.cx) / s;
    y = lens.cy + (uy - lens.cy) / s;
  }
  return [x, y];
}

const lensFor = (img, k) => (k === 0 ? NO_LENS
  : { k, cx: img.width / 2, cy: img.height / 2, half: Math.hypot(img.width / 2, img.height / 2) });

function mapGrid(G, gx, gy) {
  return bend(G.lens, applyHomography(G.H, gx + G.fx(gx, gy), gy + G.fy(gx, gy)));
}

// The pixel a continuous image point falls in, as sampleCell reads it, so the
// edges are measured in the same frame the cells are sampled in.
function grayAt(img, x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  if (!(xi >= 0 && yi >= 0 && xi < img.width && yi < img.height)) return null;
  const o = (yi * img.width + xi) * 4;
  return luminance([img.data[o], img.data[o + 1], img.data[o + 2]]);
}

/**
 * Finds where the edges between consecutive strip cells really are. For the
 * edge after each cell, searches up to EDGE_REACH blocks either side of the
 * predicted position for the steepest luminance step of the expected sign
 * (the strip starts dark unless startsDark is false). Glow moves dark to
 * light edges one way and light to dark edges the other, so single edges are
 * biased; fitOffsets smooths across both kinds.
 * @param {Array<[number, number]>} cells strip cells in order
 * @param {'x'|'y'} axis the direction the strip runs
 * @param {boolean} [startsDark] whether the first cell is the dark one
 * @returns {Array<{ index: number, offset: number, strength: number }>} index is the
 *   edge's grid coordinate along the axis, offset is in blocks
 */
export function measureStripOffsets(img, H, cells, axis, patch, startsDark = true) {
  const out = [];
  for (let i = 0; i + 1 < cells.length; i++) {
    const [col, row] = cells[i];
    const edge = axis === 'x' ? col + 1 : row + 1;
    const across = axis === 'x' ? row + 0.5 : col + 0.5;
    const darkToLight = (i % 2 === 0) === startsDark;
    const G = H && H.H ? { ...H, fx: ZERO, fy: ZERO } : plainGeometry(H); // a matrix or a geometry
    const at = (along) => (axis === 'x' ? mapGrid(G, along, across) : mapGrid(G, across, along));
    // A sharp edge gives the same step over a short run of positions; the
    // edge is the middle of that run.
    // Step k compares the samples one step either side of it, so each sample
    // serves two steps: each is taken once, at edge + j * EDGE_STEP. The steps
    // run from -12 to +11: EDGE_REACH / EDGE_STEP is just under 12 in floating point.
    const g = new Array(EDGE_SAMPLES).fill(undefined);
    const sample = (j) => {
      const i = j + EDGE_SAMPLES_OFFSET;
      if (g[i] === undefined) {
        const p = at(edge + j * EDGE_STEP);
        g[i] = grayAt(img, p[0], p[1]);
      }
      return g[i];
    };
    let best = 0, first = 0, last = 0;
    for (let k = -EDGE_REACH / EDGE_STEP; k <= EDGE_REACH / EDGE_STEP; k++) {
      const d = k * EDGE_STEP;
      const j = Math.round(k);
      const ga = sample(j - 1), gb = sample(j + 1);
      if (ga === null || gb === null) continue;
      const step = darkToLight ? gb - ga : ga - gb;
      if (step > best + 0.5) { best = step; first = d; last = d; } else if (step >= best - 0.5 && last === d - EDGE_STEP) last = d;
    }
    out.push({ index: edge, offset: (first + last) / 2, strength: best });
  }
  return out;
}

/**
 * A least squares cubic through the strong edges' offsets, as a function of
 * the grid coordinate. Clamped to MAX_CORRECTION, flat outside the measured
 * range, and zero when too few edges are strong.
 */
export function fitOffsets(points) {
  const pts = points.filter((p) => p.strength >= MIN_EDGE_STRENGTH);
  if (pts.length < MIN_EDGES) return ZERO;
  const lo = Math.min(...pts.map((p) => p.index)), hi = Math.max(...pts.map((p) => p.index));
  if (hi === lo) return ZERO;
  const norm = (v) => Math.min(1, Math.max(-1, ((v - lo) / (hi - lo)) * 2 - 1));
  // Normal equations for c0 + c1 t + c2 t^2 + c3 t^3.
  const A = Array.from({ length: 4 }, () => new Array(5).fill(0));
  for (const p of pts) {
    const t = norm(p.index);
    const pw = [1, t, t * t, t * t * t];
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) A[r][c] += pw[r] * pw[c];
      A[r][4] += pw[r] * p.offset;
    }
  }
  for (let c = 0; c < 4; c++) {
    let piv = c;
    for (let r = c + 1; r < 4; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    if (Math.abs(A[piv][c]) < 1e-12) return ZERO;
    [A[c], A[piv]] = [A[piv], A[c]];
    for (let r = 0; r < 4; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 5; k++) A[r][k] -= f * A[c][k];
    }
  }
  const coef = A.map((row, i) => row[4] / row[i]);
  const f = (v) => {
    const t = norm(v);
    const y = coef[0] + coef[1] * t + coef[2] * t * t + coef[3] * t * t * t;
    return Math.min(MAX_CORRECTION, Math.max(-MAX_CORRECTION, y));
  };
  // How far the edges sit from the curve, on average. A wrong grid size makes
  // the edges jump instead of following a smooth curve.
  f.residual = pts.reduce((sum, p) => sum + Math.abs(p.offset - f(p.index)), 0) / pts.length;
  return f;
}

// Average RGB of a square patch around the mapped center of cell (col, row),
// or null when the mapped point is not finite or falls outside the image.
function sampleCell(img, G, col, row, patch) {
  const [x, y] = mapGrid(G, col + 0.5, row + 0.5);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return null;
  const x0 = Math.max(0, Math.round(x - patch / 2)), x1 = Math.min(img.width, x0 + patch);
  const y0 = Math.max(0, Math.round(y - patch / 2)), y1 = Math.min(img.height, y0 + patch);
  let r = 0, g = 0, b = 0, n = 0;
  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++) {
      const o = (py * img.width + px) * 4;
      r += img.data[o]; g += img.data[o + 1]; b += img.data[o + 2]; n++;
    }
  }
  return n ? [r / n, g / n, b / n] : null;
}

// ---- timing check ----

// Counts light and dark changes along a strip, thresholding at the midpoint
// between the strip's darkest and lightest samples. Returns -1 when a cell
// cannot be sampled.
function countTransitions(img, G, cells, patch) {
  return stripReads(img, G, cells, patch).count;
}

// The transition count, and the longest run of consecutive transitions: a
// strip that is only drifted reads right over long stretches, while data
// cells change about half the time with short runs. count is -1 when a cell
// cannot be sampled.
function stripReads(img, G, cells, patch) {
  const lum = [];
  for (const [col, row] of cells) {
    const s = sampleCell(img, G, col, row, patch);
    if (!s) return { count: -1, run: 0 };
    lum.push(luminance(s));
  }
  const mid = (Math.min(...lum) + Math.max(...lum)) / 2;
  let count = 0, run = 0, longest = 0;
  for (let i = 1; i < lum.length; i++) {
    if ((lum[i] > mid) !== (lum[i - 1] > mid)) { count++; run++; longest = Math.max(longest, run); } else run = 0;
  }
  return { count, run: longest };
}

// A quick test a strip must pass to read with no misreads: in an exactly
// alternating strip every light cell is brighter than every dark cell, so in
// any stretch of it too, whatever the threshold. The middle stretch is where a
// wrong grid size drifts furthest from the cells (the markers pin both ends).
// False means countTransitions would find a misread or an unsampled cell, so a
// size that fails here is one the full check rejects.
function middleAlternates(img, G, cells, patch, stats) {
  const n = Math.min(cells.length, MIDDLE_CELLS);
  const start = (cells.length - n) >> 1;
  const lum = [];
  for (let i = start; i < start + n; i++) {
    const s = sampleCell(img, G, cells[i][0], cells[i][1], patch);
    if (!s) return false;
    lum.push(luminance(s));
  }
  stats.cells += n;
  let minEven = Infinity, maxEven = -Infinity, minOdd = Infinity, maxOdd = -Infinity;
  for (let i = 0; i < n; i++) {
    if (i % 2 === 0) { minEven = Math.min(minEven, lum[i]); maxEven = Math.max(maxEven, lum[i]); }
    else { minOdd = Math.min(minOdd, lum[i]); maxOdd = Math.max(maxOdd, lum[i]); }
  }
  return minEven > maxOdd || minOdd > maxEven;
}

// The timing strip cells for a cols by rows grid, from geometry alone, so the
// size search does not build a full layout per try. Must agree with
// computeLayout: top strip row 6, cols 8 .. cols - 9; left strip col 6, rows 8 .. rows - 9.
function stripCells(cols, rows) {
  const top = [], left = [];
  for (let c = 8; c <= cols - 9; c++) top.push([c, 6]);
  for (let r = 8; r <= rows - 9; r++) left.push([6, r]);
  return { top, left };
}

// All four strips as { cells, axis }. Must agree with computeLayoutV4: the
// bottom strip is row rows - 1, cols BOTTOM_TIMING_START .. cols - 7, starting
// dark; the right strip is col cols - 1, rows 8 .. rows - 7, starting with the
// frame parity. A version 3 frame has data cells under the bottom strip and a
// solid right column, so neither alternates there. A bottom strip shorter
// than the quick test is left out: too few cells to tell a size by.
const STRIP_ORDER = ['top', 'left', 'bottom', 'right'];
const TOP_LEFT = [['top', 'left']];
const FALLBACK_PAIRS = [['bottom', 'left'], ['top', 'right'], ['bottom', 'right']];

function strips(cols, rows) {
  const { top, left } = stripCells(cols, rows);
  const bottom = [], right = [];
  for (let c = BOTTOM_TIMING_START; c <= cols - 7; c++) bottom.push([c, rows - 1]);
  for (let r = 8; r <= rows - 7; r++) right.push([cols - 1, r]);
  return {
    cols, rows,
    top: { cells: top, axis: 'x' },
    left: { cells: left, axis: 'y' },
    bottom: bottom.length >= MIDDLE_CELLS ? { cells: bottom, axis: 'x' } : null,
    right: { cells: right, axis: 'y' },
  };
}

// Strip cells that misread, from a transition count (each misread cell costs two).
const misreads = (count, cells) => (count < 0 ? Infinity : (cells.length - 1 - count) / 2);

// Whether a strip's first cell is its dark one: its even cells are darker
// than its odd cells on average. Only the right strip needs this; its phase
// follows the frame index.
function startsDarkOn(img, G, cells, patch) {
  let even = 0, odd = 0;
  cells.forEach(([col, row], i) => {
    const s = sampleCell(img, G, col, row, patch);
    if (!s) return;
    if (i % 2 === 0) even += luminance(s); else odd += luminance(s);
  });
  // Mean per cell: an odd length strip has one more even cell.
  return even / Math.ceil(cells.length / 2) < odd / Math.floor(cells.length / 2);
}

// The offset fit of one strip, measured on the base geometry.
function stripFit(img, base, strip, patch, startsDark = true) {
  return fitOffsets(measureStripOffsets(img, base, strip.cells, strip.axis, patch, startsDark));
}

const clamp01 = (t) => Math.min(1, Math.max(0, t));

// The x correction from the top and bottom fits (either may be missing):
// linear in gy between the top strip (gy 6.5) and the bottom strip
// (gy rows - 0.5), flat outside. One fit alone is used as it is.
function offsetsX(top, bottom, rows) {
  if (top && bottom) {
    const span = rows - 7;
    return (gx, gy) => {
      const t = clamp01((gy - 6.5) / span);
      return top(gx) * (1 - t) + bottom(gx) * t;
    };
  }
  return top ?? bottom ?? ZERO;
}

// The y correction from the left and right fits, linear in gx between the
// left strip (gx 6.5) and the right strip (gx cols - 0.5).
function offsetsY(left, right, cols) {
  if (left && right) {
    const span = cols - 7;
    return (gx, gy) => {
      const t = clamp01((gx - 6.5) / span);
      return left(gy) * (1 - t) + right(gy) * t;
    };
  }
  const f = left ?? right;
  return f ? (gx, gy) => f(gy) : ZERO;
}

// The base geometry corrected by the fits of the pair and the extras. A fit
// that found too few edges (ZERO) takes no part, so an axis with no real fit
// is not corrected, as before.
function composeGeometry(base, S, fits, pair, extras) {
  const pick = (name) => ((pair.includes(name) || extras.includes(name)) && fits[name] && fits[name] !== ZERO ? fits[name] : null);
  return { ...base, fx: offsetsX(pick('top'), pick('bottom'), S.rows), fy: offsetsY(pick('left'), pick('right'), S.cols) };
}

// The strips other than the pair that read nearly right on the pair's
// corrected geometry, with a real fit on the base. Returns their names.
function readableExtras(img, base, pairG, S, pair, fits, patch, stats) {
  const extras = [];
  for (const name of STRIP_ORDER) {
    const strip = S[name];
    if (!strip || pair.includes(name)) continue;
    if (stats) stats.cells += strip.cells.length;
    if (countTransitions(img, pairG, strip.cells, patch) < EXTRA_MATCH * (strip.cells.length - 1)) continue;
    const startsDark = name === 'right' ? startsDarkOn(img, pairG, strip.cells, patch) : true;
    fits[name] = stripFit(img, base, strip, patch, startsDark);
    if (fits[name] !== ZERO) extras.push(name);
  }
  return extras;
}

// The pair's fits, and the geometry from them alone.
function pairGeometry(img, base, S, pair, patch) {
  const fits = {};
  for (const name of pair) {
    const startsDark = name === 'right' ? startsDarkOn(img, base, S[name].cells, patch) : true;
    fits[name] = stripFit(img, base, S[name], patch, startsDark);
  }
  return { fits, G: composeGeometry(base, S, fits, pair, []) };
}

const edgeName = (pair, extras) => [...pair, ...extras].join('+');
const pairBad = (img, G, S, names, patch) => names.reduce((sum, n) => sum + misreads(countTransitions(img, G, S[n].cells, patch), S[n].cells), 0);
const allWithin = (img, G, S, names, patch, limit) => names.every((n) => misreads(countTransitions(img, G, S[n].cells, patch), S[n].cells) <= limit);

// First pass: the strips match exactly with the plain geometry, as they do
// on a flat or mildly bent image. pairs are tried in order, each with the
// quick middle test first. The correction is kept only if the strips still
// match exactly with it. Returns the geometry (with its edges), or null.
function exactGeometry(img, H, cols, rows, patch, stats, pairs) {
  const S = strips(cols, rows);
  const plain = plainGeometry(H);
  const mid = {}, counted = {}, full = {};
  const middle = (n) => (mid[n] ??= middleAlternates(img, plain, S[n].cells, patch, stats));
  const exactOn = (n) => (full[n] ??= misreads(countTransitions(img, plain, S[n].cells, patch), S[n].cells) === 0);
  let pair = null;
  for (const [h, v] of pairs) {
    if (!S[h] || !S[v]) continue;
    if (!middle(h) || !middle(v)) continue;
    for (const n of [h, v]) if (!counted[n]) { counted[n] = true; stats.cells += S[n].cells.length; }
    if (exactOn(h) && exactOn(v)) { pair = [h, v]; break; }
  }
  if (!pair) return null;
  const { fits, G: pairG } = pairGeometry(img, plain, S, pair, patch);
  const extras = stats.fourEdge ? readableExtras(img, plain, pairG, S, pair, fits, patch, stats) : [];
  // The strips cannot tell which reads the data better, so the plain
  // geometry stays as the fallback the decoder tries if the corrected read fails.
  if (extras.length) {
    const G = composeGeometry(plain, S, fits, pair, extras);
    if (allWithin(img, G, S, [...pair, ...extras], patch, 0)) return Object.assign(G, { fallback: plain, edges: edgeName(pair, extras) });
  }
  const edges = edgeName(pair, []);
  const exact = allWithin(img, pairG, S, pair, patch, 0);
  return exact ? Object.assign(pairG, { fallback: plain, edges }) : Object.assign(plain, { edges });
}

// The plain geometry at each lens strength: markers moved to their lens-free
// positions and the homography refitted. Strengths whose points give a
// singular system are left out.
function lensGeometries(img, markers, cols, rows) {
  const out = [];
  for (const k of LENS_STEPS) {
    const lens = lensFor(img, k);
    const free = { tl: unbend(lens, markers.tl), tr: unbend(lens, markers.tr), bl: unbend(lens, markers.bl), br: markers.br && unbend(lens, markers.br) };
    let H;
    try {
      H = gridToImage(free, cols, rows);
    } catch {
      continue;
    }
    out.push({ H, lens, fx: ZERO, fy: ZERO });
  }
  return out;
}

// In the other pairs, a strip must read right over a stretch as long as the
// exact pass's quick test before the corrected pass uses it: a drifted strip
// still reads right over long stretches, while the version 3 data cells under
// the bottom strip, or a covered strip's noise, pass the near match by chance.
const longRun = (r, cells) => r.run >= Math.min(MIDDLE_CELLS, cells.length) - 1;

// Second pass: the strips match within TIMING_SLACK cells once corrected.
// For each pair in turn, tries each lens strength, keeps the one whose strips
// misread least, then adds the smooth correction. Returns { G, score, finish }
// (lower score is better), or null; finish() blends in the other strips that
// read, for the size that wins. lenses holds the size's lens geometries and
// the strip reads on them, kept between the top and left search and the
// other pairs' search.
function correctedMatch(img, S, lenses, patch, pairs) {
  const near = (L, n) => {
    const r = (L.reads[n] ??= stripReads(img, L.G, S[n].cells, patch));
    if (r.count < NEAR_MATCH * (S[n].cells.length - 1)) return null;
    if (pairs !== TOP_LEFT && !longRun(r, S[n].cells)) return null;
    return r.count;
  };
  for (const pair of pairs) {
    const [h, v] = pair;
    if (!S[h] || !S[v]) continue;
    let base = null, baseBad = Infinity;
    for (const L of lenses) {
      const t = near(L, h);
      if (t === null) continue; // the other strip cannot save this lens
      const l = near(L, v);
      if (l === null) continue;
      const bad = misreads(t, S[h].cells) + misreads(l, S[v].cells);
      if (bad < baseBad) { base = L.G; baseBad = bad; }
    }
    if (!base) continue;
    const { fits, G: pairG } = pairGeometry(img, base, S, pair, patch);
    const bad = pairBad(img, pairG, S, pair, patch);
    if (bad > TIMING_SLACK) continue;
    const residual = pair.reduce((sum, n) => sum + (fits[n].residual ?? 0), 0);
    const finish = (fourEdge) => {
      const extras = fourEdge ? readableExtras(img, base, pairG, S, pair, fits, patch, null) : [];
      if (extras.length) {
        const G = composeGeometry(base, S, fits, pair, extras);
        if (pairBad(img, G, S, pair, patch) <= TIMING_SLACK && allWithin(img, G, S, extras, patch, TIMING_SLACK)) {
          return Object.assign(G, { edges: edgeName(pair, extras) });
        }
      }
      return Object.assign(pairG, { edges: edgeName(pair, []) });
    };
    return { G: pairG, score: bad + 10 * residual, finish };
  }
  return null;
}

// The other pairs whose bottom or right strip shows at the estimated size
// with some lens strength. The corrected search on a pair samples whole
// strips at every nearby size and lens, so a pair whose strip does not show
// is skipped.
function showingPairs(img, markers, cols, rows, patch) {
  const S = strips(cols, rows);
  const lenses = lensGeometries(img, markers, cols, rows);
  const shows = (n) => S[n] && lenses.some((G) => longRun(stripReads(img, G, S[n].cells, patch), S[n].cells));
  const showing = { top: true, left: true, bottom: shows('bottom'), right: shows('right') };
  return FALLBACK_PAIRS.filter(([h, v]) => showing[h] && showing[v]);
}

// Tries the estimated grid size, then nearby sizes, nearest first. Returns
// { layout, H } or null. The search reaches past the 8 neighbors because a
// tilt shrinks the finder pitch across the tilt more than along it, so the
// estimate from the mean pitch can be off by several blocks.
function searchGridSize(img, markers, cols, rows, patch, pass, stats) {
  const reach = (n) => Math.max(1, Math.round(SIZE_SEARCH_FRACTION * n));
  const tries = [];
  for (let dc = -reach(cols); dc <= reach(cols); dc++) {
    for (let dr = -reach(rows); dr <= reach(rows); dr++) tries.push([dc, dr]);
  }
  tries.sort((a, b) => Math.abs(a[0]) + Math.abs(a[1]) - Math.abs(b[0]) - Math.abs(b[1]));
  const homography = (c, r) => {
    try {
      return gridToImage(markers, c, r);
    } catch {
      return null; // the points give a singular system
    }
  };
  const near = (dc, dr, reach) => Math.abs(dc) <= reach && Math.abs(dr) <= reach;
  if (pass === 'exact') {
    // The top and left strips at every size first; only when no size matches
    // on them do the other pairs get a try, nearer the estimate.
    for (const [pairs, reach] of stats.fourEdge ? [[TOP_LEFT, Infinity], [FALLBACK_PAIRS, FALLBACK_REACH]] : [[TOP_LEFT, Infinity]]) {
      for (const [dc, dr] of tries) {
        if (!near(dc, dr, reach)) continue;
        const c = cols + dc, r = rows + dr;
        if (c < MIN_COLS || r < MIN_ROWS) continue;
        const H = homography(c, r);
        const G = H && exactGeometry(img, H, c, r, patch, stats, pairs);
        if (G) return { layout: computeLayout(c, r), G };
      }
    }
    return null;
  }
  // No size matches exactly: the lens bends the grid. Try corrected sizes near
  // the estimate and keep the best, so a wrong size that squeaks through the
  // slack does not win just by being tried first. The top and left strips go
  // first at every size; the other pairs are tried only when no size matched
  // on them, so a bent version 3 read costs what it did.
  const sizes = new Map();
  const sizeFor = (c, r) => {
    const key = c * 65536 + r;
    if (!sizes.has(key)) sizes.set(key, { S: strips(c, r), lenses: lensGeometries(img, markers, c, r).map((G) => ({ G, reads: {} })) });
    return sizes.get(key);
  };
  for (const [stage, reach] of stats.fourEdge ? [[TOP_LEFT, CORRECTED_REACH], [FALLBACK_PAIRS, FALLBACK_REACH]] : [[TOP_LEFT, CORRECTED_REACH]]) {
    const pairs = stage === TOP_LEFT ? TOP_LEFT : showingPairs(img, markers, cols, rows, patch);
    if (!pairs.length) break;
    let best = null;
    for (const [dc, dr] of tries) {
      if (!near(dc, dr, reach)) continue;
      const c = cols + dc, r = rows + dr;
      if (c < MIN_COLS || r < MIN_ROWS) continue;
      const { S, lenses } = sizeFor(c, r);
      const m = correctedMatch(img, S, lenses, patch, pairs);
      if (m && (!best || m.score < best.score)) best = { ...m, c, r };
    }
    if (best) return { layout: computeLayout(best.c, best.r), G: best.finish(stats.fourEdge) };
  }
  return null;
}

// Picks the small marker and the grid size together. Under perspective the
// real small marker can sit far from the parallelogram prediction while data
// cells form false size 5 patterns nearer to it, so each candidate, nearest
// first, gets a size search; the timing strips decide. The affine map from
// the three large markers comes last. Every candidate gets the exact pass
// before any gets the corrected one: a false marker can pass the corrected
// search's slack at a wrong size, as on a tilted gray frame, while the real
// marker matches exactly. Returns { layout, H, br } or null.
function fitGrid(img, markers, cols, rows, patch, stats) {
  const { tl, tr, bl } = markers;
  const candidates = [...(markers.brCandidates ?? (markers.br ? [markers.br] : [])), null];
  for (const pass of ['exact', 'corrected']) {
    for (const br of candidates) {
      const fit = searchGridSize(img, { tl, tr, bl, br }, cols, rows, patch, pass, stats);
      if (fit) return { ...fit, br };
    }
  }
  return null;
}

// ---- calibration ----

// Groups the 16 ramp samples (sorted by luminance) into the largest step count
// whose groups are well separated, then derives per channel thresholds.
function calibrate(ramp) {
  const order = ramp.map((s) => ({ s, lum: luminance(s) })).sort((a, b) => a.lum - b.lum);
  let steps = 2;
  for (const L of STEP_OPTIONS) {
    const size = RAMP_LENGTH / L;
    let maxSpread = 0, minGap = Infinity, prevMean = null;
    for (let k = 0; k < L; k++) {
      const group = order.slice(k * size, (k + 1) * size).map((e) => e.lum);
      const mean = group.reduce((a, v) => a + v, 0) / size;
      maxSpread = Math.max(maxSpread, group[size - 1] - group[0]);
      if (prevMean !== null) minGap = Math.min(minGap, mean - prevMean);
      prevMean = mean;
    }
    if (minGap > GAP_TO_SPREAD * maxSpread && minGap > MIN_STEP_GAP) { steps = L; break; }
  }

  const size = RAMP_LENGTH / steps;
  const means = { r: [], g: [], b: [] }, lumMeans = [];
  for (let k = 0; k < steps; k++) {
    const group = order.slice(k * size, (k + 1) * size);
    ['r', 'g', 'b'].forEach((ch, c) => means[ch].push(group.reduce((a, e) => a + e.s[c], 0) / size));
    lumMeans.push(group.reduce((a, e) => a + e.lum, 0) / size);
  }
  const mids = (m) => m.slice(1).map((v, k) => (m[k] + v) / 2);
  const thresholds = { r: mids(means.r), g: mids(means.g), b: mids(means.b) };
  return { levels: steps, means, thresholds, blackWhiteMid: (lumMeans[0] + lumMeans[steps - 1]) / 2 };
}

// Version 3 calibration. The ramp shows, in each channel of L levels, level
// floor(i * L / 16) at cell i (see src/picture/render.js), so the cells are
// grouped by position, not by sorted brightness.

// Header thresholds: per channel midpoints between ramp cells 0 (black) and 15 (white).
function headerThresholds(ramp) {
  const mid = (c) => [(ramp[0][c] + ramp[RAMP_LENGTH - 1][c]) / 2];
  return { r: mid(0), g: mid(1), b: mid(2) };
}

// Means of one value over the ramp cells of each level, for a channel of n levels.
function levelMeans(values, n) {
  const steps = Math.min(n, 16);
  const sums = new Array(steps).fill(0), counts = new Array(steps).fill(0);
  values.forEach((v, i) => {
    const k = Math.floor((i * steps) / RAMP_LENGTH);
    sums[k] += v; counts[k]++;
  });
  return sums.map((v, k) => v / counts[k]);
}

const midsOf = (m) => m.slice(1).map((v, k) => (m[k] + v) / 2);

// Thresholds and level means for a scheme from the ramp. A channel of 256
// levels gets no thresholds: its value is the level.
function schemeCalibration(ramp, scheme) {
  if (scheme.kind === 'gray') {
    const y = levelMeans(ramp.map(luminance), scheme.levels);
    return { thresholds: { y: midsOf(y) }, means: { y } };
  }
  const means = {}, thresholds = {};
  ['r', 'g', 'b'].forEach((ch, c) => {
    const n = scheme.levels[c];
    means[ch] = levelMeans(ramp.map((s) => s[c]), n);
    thresholds[ch] = n === 256 ? [] : midsOf(means[ch]);
  });
  return { thresholds, means };
}

// Channel separation. A phone camera mixes its color channels: it boosts
// saturation, so a pure color reads brighter in its own channel than white
// does and its other channels fall below black. The strip's pure red, green
// and blue cells measure the mix: camera = black + M x screen / 255, with M's
// columns those cells less black. The inverse turns a sample back into screen
// values, so each channel's levels are decided on their own. Returns the
// unmixing function, or null when the cells do not give a usable matrix.
const MIN_MIX_DET = 0.05; // M is about 0.8 on the diagonal; near zero means the cells were not seen

export function colorUnmixer(black, pure) {
  if (!black || pure.some((p) => !p)) return null;
  const m = [0, 1, 2].map((row) => [0, 1, 2].map((col) => (pure[col][row] - black[row]) / 255));
  const det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
    - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
    + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  if (!(det > MIN_MIX_DET)) return null;
  const inv = [
    [m[1][1] * m[2][2] - m[1][2] * m[2][1], m[0][2] * m[2][1] - m[0][1] * m[2][2], m[0][1] * m[1][2] - m[0][2] * m[1][1]],
    [m[1][2] * m[2][0] - m[1][0] * m[2][2], m[0][0] * m[2][2] - m[0][2] * m[2][0], m[0][2] * m[1][0] - m[0][0] * m[1][2]],
    [m[1][0] * m[2][1] - m[1][1] * m[2][0], m[0][1] * m[2][0] - m[0][0] * m[2][1], m[0][0] * m[1][1] - m[0][1] * m[1][0]],
  ].map((row) => row.map((v) => v / det));
  const clamp = (v) => Math.min(255, Math.max(0, v));
  const unmix = (s) => {
    const d = [s[0] - black[0], s[1] - black[1], s[2] - black[2]];
    return inv.map((row) => clamp(row[0] * d[0] + row[1] * d[1] + row[2] * d[2]));
  };
  unmix.matrix = m.map((row) => row.map((v) => Math.round(v * 100) / 100));
  return unmix;
}

// Unmixes the payload cells (after the header) of blocks and raw in place.
function unmixPayload(blocks, raw, unmix, fromCell = HEADER_CELLS, toCell = raw.length / 3) {
  for (let i = fromCell * 3; i < toCell * 3; i += 3) {
    const u = unmix([raw[i], raw[i + 1], raw[i + 2]]);
    for (let c = 0; c < 3; c++) { raw[i + c] = u[c]; blocks[i + c] = Math.round(u[c]); }
  }
}

// Reads a version 3 header from the first data cells. Returns the header or null.
function readHeaderV3(blocks, ramp) {
  const hT = headerThresholds(ramp);
  const header = peekHeader(headerBytesFromBlocks(blocks, hT));
  return header && header.version === VERSION ? { header, headerThresholds: hT } : null;
}

// The version 4 layout of a grid, built once per size: the reader runs for
// every camera frame.
const LAYOUT_CACHE_MAX = 4;
const layoutsV4 = new Map();
/** How many version 4 layouts are cached, for tests. */
export const layoutCacheSize = () => layoutsV4.size;
export function layoutV4For(cols, rows) {
  const key = cols * 65536 + rows;
  let layout = layoutsV4.get(key);
  if (!layout) {
    layout = computeLayoutV4(cols, rows);
    // Each layout is large and a size change is rare, so a few entries are plenty.
    if (layoutsV4.size >= LAYOUT_CACHE_MAX) layoutsV4.delete(layoutsV4.keys().next().value);
    layoutsV4.set(key, layout);
  }
  return layout;
}

// Reads a version 4 header from the sampled version 3 data cells: copy A from
// the first cells, else copy B from the last 128 version 4 data cells. Returns
// { header, headerThresholds, layoutV4 } or null.
function readHeaderV4(blocks, ramp, cols, rows) {
  const hT = headerThresholds(ramp);
  const a = peekHeaderV4(headerBytesFromBlocks(blocks, hT).subarray(0, HEADER_CODEWORD_V4));
  const layoutV4 = layoutV4For(cols, rows);
  let header = a;
  if (!header) {
    const tail = new Uint8Array(HEADER_CELLS_V4 * 3);
    const from = layoutV4.dataBlockCount - HEADER_CELLS_V4;
    for (let i = 0; i < HEADER_CELLS_V4; i++) {
      const v3 = layoutV4.v3Index[from + i] * 3;
      for (let c = 0; c < 3; c++) tail[i * 3 + c] = blocks[v3 + c];
    }
    header = peekHeaderV4(bytesFromBlocks(tail, HEADER_SCHEME, hT).subarray(0, HEADER_CODEWORD_V4));
  }
  return header ? { header, headerThresholds: hT, layoutV4 } : null;
}

// ---- sampling ----

// Off image cells read as black.
function sampleData(img, G, layout, patch) {
  const blocks = new Uint8Array(layout.dataBlockCount * 3);
  const raw = new Float64Array(layout.dataBlockCount * 3); // unrounded, for the margin
  for (let i = 0; i < layout.dataBlockCount; i++) {
    const cell = layout.dataCells[i];
    const s = sampleCell(img, G, cell % layout.cols, Math.floor(cell / layout.cols), patch) ?? [0, 0, 0];
    for (let c = 0; c < 3; c++) { raw[i * 3 + c] = s[c]; blocks[i * 3 + c] = Math.round(s[c]); }
  }
  return { blocks, raw };
}

function readParity(img, G, layout, patch, blackWhiteMid) {
  const { parity } = layout;
  let sum = 0, n = 0;
  for (let r = parity.rowStart; r <= parity.rowEnd; r++) {
    const s = sampleCell(img, G, parity.col, r, patch);
    if (s) { sum += luminance(s); n++; }
  }
  return n && sum / n > blackWhiteMid ? 1 : 0;
}

// ---- stats ----

// Mean over all channel samples of how deep each sits inside its decided
// level's band: 1 at or past the level's group mean, 0 at a threshold.
function computeMargin(raw, calib, gray = false) {
  const chans = ['r', 'g', 'b'];
  const values = gray ? Array.from({ length: raw.length / 3 }, (_, i) => luminance([raw[i * 3], raw[i * 3 + 1], raw[i * 3 + 2]])) : raw;
  let total = 0;
  for (let i = 0; i < values.length; i++) {
    const ch = gray ? 'y' : chans[i % 3];
    const t = calib.thresholds[ch], m = calib.means[ch];
    if (t.length === 0) { total += 1; continue; }
    const last = t.length - 1;
    const v = values[i];
    const k = decideLevel(v, t);
    // Distance to each bounding threshold, over half the gap between that
    // threshold's own two group means. The extreme levels have one bound only.
    let sample = Infinity;
    if (k > 0) sample = Math.min(sample, (v - t[k - 1]) / ((m[k] - m[k - 1]) / 2));
    if (k <= last) sample = Math.min(sample, (t[k] - v) / ((m[k + 1] - m[k]) / 2));
    total += Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0;
  }
  return values.length ? total / values.length : 0;
}

// Estimates the grid size from one oriented triple and fits it. Returns
// { layout, H, corners, pitch, patch } or null.
function fitOption(img, option, stats) {
  const { width, height } = img;
  const { tl, tr, bl, pitch } = option;
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  // Nothing finer than MIN_PITCH pixels per block is readable, so cap the estimate.
  const maxSize = Math.floor(Math.max(width, height) / MIN_PITCH) + 7; // either axis may hold the columns
  const cols = Math.min(Math.round(dist(tl, tr) / pitch) + 7, maxSize);
  const rows = Math.min(Math.round(dist(tl, bl) / pitch) + 7, maxSize);
  const patch = Math.max(1, Math.floor(pitch / 3));
  const fit = fitGrid(img, option, cols, rows, patch, stats);
  if (!fit) return null;
  // br is the small marker the timing strips confirmed, or null for the affine map.
  return { layout: fit.layout, G: fit.G, edges: fit.G.edges, corners: { tl, tr, bl, br: fit.br }, pitch, patch };
}

// ---- exports ----

// Finds the markers and fits the grid. Returns { found } or { failure }.
function findMarkers(gray, width, height, scale) {
  const candidates = findFinderCandidates(binarize(gray, width, height), width, height)
    .map((c) => ({ ...c, x: c.x * scale, y: c.y * scale, pitch: c.pitch * scale }))
    .filter((c) => c.pitch >= MIN_PITCH);
  return orientFinders(candidates);
}

// The markers, searched at half size first on a large image. When no triple is
// found there (markers too fine, for example), the full size search runs, so a
// large image reads at least everything it read before.
function searchMarkers(img) {
  const { width, height } = img;
  if (width * height >= HALF_SIZE_PIXELS) {
    const half = toGrayHalf(img);
    const markers = findMarkers(half.gray, half.width, half.height, 2);
    if (markers) return { markers, finderScale: 2 };
  }
  return { markers: findMarkers(toGray(img), width, height, 1), finderScale: 1 };
}

function locate(img) {
  const { markers, finderScale } = searchMarkers(img);
  if (!markers) return { failure: { markersFound: false, reason: 'no markers', finderScale } };
  return { ...fitMarkers(img, markers, finderScale, true), markers, finderScale };
}

// Fits the grid to the found markers. With fourEdge false only the top and
// left strips are used, exactly as for version 2 and 3 frames before version 4.
function fitMarkers(img, markers, finderScale, fourEdge) {
  // Each oriented triple, best first, is checked against the timing strips;
  // the first that fits wins. A failed read reports the best triple's corners.
  let found = null;
  const stats = { cells: 0, fourEdge };
  for (const option of markers.options ?? [markers]) {
    found = fitOption(img, option, stats);
    if (found) break;
  }
  if (!found) {
    const { tl, tr, bl, br, pitch } = markers;
    return { failure: { markersFound: true, corners: { tl, tr, bl, br }, pitch, reason: 'timing mismatch', finderScale, exactCells: stats.cells } };
  }
  return { found: { ...found, finderScale, exactCells: stats.cells } };
}

// Samples the ramp, the parity strip and every data cell with geometry G.
function readWith(img, found, G) {
  const { layout, corners, pitch, patch } = found;

  const ramp = [];
  for (let i = 0; i < RAMP_LENGTH; i++) {
    ramp.push(sampleCell(img, G, layout.calibration.colStart + i, layout.calibration.row, patch) ?? [0, 0, 0]);
  }
  let { blocks, raw } = sampleData(img, G, layout, patch);
  // A version 3 header names the scheme; without one the version 2 path
  // groups the ramp by brightness and reads the whole frame in the cube.
  const v3 = readHeaderV3(blocks, ramp);
  const v4 = v3 ? null : readHeaderV4(blocks, ramp, layout.cols, layout.rows);
  const head = v3 ?? v4;
  let calib, frameFields = {};
  if (v4) {
    // Keep only the version 4 data cells; the pilots and the cells beside them drop out.
    const { v3Index } = v4.layoutV4;
    const blocks4 = new Uint8Array(v3Index.length * 3);
    const raw4 = new Float64Array(v3Index.length * 3);
    for (let i = 0; i < v3Index.length; i++) {
      for (let c = 0; c < 3; c++) { blocks4[i * 3 + c] = blocks[v3Index[i] * 3 + c]; raw4[i * 3 + c] = raw[v3Index[i] * 3 + c]; }
    }
    blocks = blocks4;
    raw = raw4;
  }
  if (head) {
    const { scheme, frameType, probeId, probeCount, levels } = head.header;
    // Color schemes are decided on unmixed values; gray decides on brightness,
    // which the mix barely moves, and the header reads before any of this.
    let calRamp = ramp;
    let colorMatrix = null;
    if (scheme.kind === 'rgb') {
      const pure = [16, 17, 18].map((i) => sampleCell(img, G, layout.calibration.colStart + i, layout.calibration.row, patch));
      const unmix = colorUnmixer(ramp[0], pure);
      if (unmix) {
        calRamp = ramp.map(unmix);
        // Neither version 4 header copy is unmixed: they read before the matrix is known.
        if (v4) unmixPayload(blocks, raw, unmix, HEADER_CELLS_V4, v4.layoutV4.dataBlockCount - HEADER_CELLS_V4);
        else unmixPayload(blocks, raw, unmix);
        colorMatrix = unmix.matrix;
      }
    }
    const sc = schemeCalibration(calRamp, scheme);
    calib = { ...sc, blackWhiteMid: (luminance(ramp[0]) + luminance(ramp[RAMP_LENGTH - 1])) / 2 };
    frameFields = {
      version: v4 ? 4 : VERSION, scheme, schemeName: schemeName(scheme), frameType, probeId, probeCount,
      levels, headerThresholds: head.headerThresholds, frameHeader: head.header, colorMatrix,
      ...(v4 ? { layoutVersion: 4 } : {}),
    };
  } else {
    calib = calibrate(ramp);
    frameFields = { version: 2, levels: calib.levels };
  }
  // A blended correction is linear in the other coordinate, so its largest
  // value is on one of the grid's two edges across it.
  const largest = (f, n, across, alongX) => {
    let m = 0;
    for (let v = 0; v <= n; v++) {
      for (const w of [0, across]) m = Math.max(m, Math.abs(alongX ? f(v, w) : f(w, v)));
    }
    return Math.round(m * 100) / 100;
  };

  // The grid's own outer corners in the image, for the aiming guide. The
  // marker centres are not a rectangle in grid space, so they would misread
  // the angle. Without the small marker the map is affine and knows no
  // perspective, so the bottom right corner is left out.
  const at = (gx, gy) => mapGrid(G, gx, gy);
  const gridCorners = {
    tl: at(0, 0), tr: at(layout.cols, 0), bl: at(0, layout.rows), br: corners.br ? at(layout.cols, layout.rows) : null,
  };

  return {
    markersFound: true,
    corners,
    gridCorners,
    cols: layout.cols,
    rows: layout.rows,
    ...frameFields,
    pitch,
    parity: readParity(img, G, layout, patch, calib.blackWhiteMid),
    blocks,
    thresholds: calib.thresholds,
    margin: computeMargin(raw, calib, frameFields.scheme?.kind === 'gray'),
    ramp: ramp.map((s) => s.map(Math.round)), // calibration samples, for diagnostics
    means: calib.means,
    correction: { maxX: largest(G.fx, layout.cols, layout.rows, true), maxY: largest(G.fy, layout.rows, layout.cols, false), lens: G.lens ? G.lens.k : 0 }, // for diagnostics
    edges: found.edges, // the timing strips that accepted the grid, and any blended in
    finderScale: found.finderScale, // 2 when the markers were found at half size
    exactCells: found.exactCells, // strip cells the exact size search sampled, for diagnostics
  };
}

// The bottom and right strips exist only on version 4 frames. A frame that
// reads as another version but was accepted or blended with them is fitted
// again on the top and left strips alone, so versions 2 and 3 read exactly
// as they always did: a version 3 frame's data cells can alternate there.
const usesFourEdges = (found) => found.edges !== edgeName(TOP_LEFT[0], []);

function topLeftAgain(img, located) {
  const again = fitMarkers(img, located.markers, located.finderScale, false);
  const cells = located.found.exactCells + (again.found ?? again.failure).exactCells;
  if (again.failure) again.failure.exactCells = cells; else again.found.exactCells = cells;
  return again;
}

export function readCameraFrame(img) {
  const located = locate(img);
  if (located.failure) return located.failure;
  const read = readWith(img, located.found, located.found.G);
  if (read.version === 4 || !usesFourEdges(located.found)) return read;
  const { found, failure } = topLeftAgain(img, located);
  return failure ?? readWith(img, found, found.G);
}

/** The frame bytes of a read: the header and payload split for version 3. */
export function readBytes(read) {
  if (read.version === 4) return blocksToFrameBytesV4(read.blocks, read.scheme, read.headerThresholds, read.thresholds, layoutV4For(read.cols, read.rows));
  if (read.version === VERSION) return blocksToFrameBytes(read.blocks, read.scheme, read.headerThresholds, read.thresholds);
  return bytesFromBlocks(read.blocks, read.levels, read.thresholds);
}

function parse(read) {
  try {
    return read.version === 4 ? parseFrameV4(readBytes(read)) : parseFrame(readBytes(read));
  } catch {
    return null;
  }
}

export function decodeCameraFrame(img) {
  let located;
  try {
    located = locate(img);
  } catch (err) {
    return { read: { markersFound: false, reason: err.message }, frame: null };
  }
  if (located.failure) return { read: located.failure, frame: null };
  const out = decodeFound(img, located.found);
  if (out.read.version === 4 || !usesFourEdges(located.found)) return out;
  let again;
  try {
    again = topLeftAgain(img, located);
  } catch (err) {
    return { read: { markersFound: false, reason: err.message }, frame: null };
  }
  return again.failure ? { read: again.failure, frame: null } : decodeFound(img, again.found);
}

// Reads and parses a located frame, with the second read on the plain
// geometry when the first gives too little.
function decodeFound(img, found) {
  // sample(col, row) reads a cell's mean color on the geometry that was used,
  // for the characterization frame. It is not posted by the worker.
  const sampler = (G) => (col, row) => sampleCell(img, G, col, row, found.patch);
  const read = readWith(img, found, found.G);
  const frame = parse(read);
  const goodPackets = (f) => f?.packets ? f.packets.filter(Boolean).length : 0;
  // A version 4 frame parses from one good header copy even when packets fail.
  // A torn frame with most packets good is kept: a second read on the other
  // geometry would nearly double the decode time and gain little. Only a frame
  // that is missing or has under half its packets good asks for the second read.
  const total = frame?.packets ? frame.packets.length : 0;
  const complete = frame && (frame.packets ? goodPackets(frame) * 2 >= total : true);
  if (complete || !found.G.fallback) return { read: Object.assign(read, { rereads: 0 }), frame, sample: sampler(found.G) };
  const plainRead = readWith(img, found, found.G.fallback);
  const plainFrame = parse(plainRead);
  return plainFrame && (!frame || goodPackets(plainFrame) > goodPackets(frame))
    ? { read: Object.assign(plainRead, { rereads: 1 }), frame: plainFrame, sample: sampler(found.G.fallback) }
    : { read: Object.assign(read, { rereads: 1 }), frame, sample: sampler(found.G) };
}
