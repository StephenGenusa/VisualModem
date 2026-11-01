// Finds the four corner markers of a frame in a camera image and works out
// which is which. Points are [x, y] in continuous image coordinates, where
// pixel i covers the span from i to i + 1.

const TILE = 32;
const FLAT_CONTRAST = 24;
const FLAT_REACH = 2; // how many tiles away a flat tile looks for a threshold to borrow
const RATIO_TOLERANCE = 0.5;
const MIN_CONFIRMATIONS = 2;
const MAX_SPREAD = 0.65; // bloom (or its opposite) on a light run, as a share of a block; a phone photo of a TV measured 0.45
const OUTER_MIN = 0.5; // an outer dark run at least half its expected length
// The camera reader cannot read finer than 3 image pixels per block (MIN_PITCH
// in reader.js). Rejecting finer patterns here keeps the speckle that noise
// makes in flat dark areas from flooding the candidate list.
export const MIN_UNIT = 3;
const MAX_ANGLE_ERROR = (25 * Math.PI) / 180;
const BR_SEARCH_PITCHES = 5; // one width of the small marker
// Perspective moves the small marker well away from the parallelogram
// prediction, so the reader checks every size 5 candidate this far out.
const BR_CANDIDATE_PITCHES = 12;
const BR_PITCH_TOLERANCE = 0.4; // a candidate's pitch within 40 percent of the triple's
const PITCH_TOLERANCE = 0.3; // each marker's pitch within 30 percent of the triple's mean
const COS_TIE = 0.02; // angle errors this close in |cos| count as a tie
const MAX_TRIPLE_OPTIONS = 6; // triples handed to the reader, best first

// ---- gray ----

// Rounded luminance. Adding 0.5 and truncating gives the same value as
// Math.round for every color (checked for all of them in a test) and is about
// four times faster, which counts on a 4K camera frame.
export function toGray(img) {
  const { data, width, height } = img;
  const gray = new Uint8Array(width * height);
  for (let i = 0, o = 0; i < gray.length; i++, o += 4) {
    gray[i] = (0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2] + 0.5) | 0;
  }
  return gray;
}

// Luminance at half size: each output pixel is the rounded mean of a 2 x 2
// block, and an odd last row or column is dropped. Output pixel j covers input
// pixels 2j and 2j + 1, so a point x here is 2x in the full image.
export function toGrayHalf(img) {
  const { data, width: w } = img;
  const width = w >> 1, height = img.height >> 1;
  const gray = new Uint8Array(width * height);
  const lum = (o) => 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
  for (let y = 0; y < height; y++) {
    const top = 2 * y * w * 4, bottom = top + w * 4;
    for (let x = 0; x < width; x++) {
      const o = 8 * x;
      gray[y * width + x] = ((lum(top + o) + lum(top + o + 4) + lum(bottom + o) + lum(bottom + o + 4)) / 4 + 0.5) | 0;
    }
  }
  return { gray, width, height };
}

// ---- binarize ----

export function binarize(gray, width, height) {
  let sum = 0;
  for (let i = 0; i < gray.length; i++) sum += gray[i];
  const globalMean = sum / gray.length;

  const tx = Math.ceil(width / TILE), ty = Math.ceil(height / TILE);
  const raw = new Float64Array(tx * ty);
  for (let j = 0; j < ty; j++) {
    for (let i = 0; i < tx; i++) {
      let min = 255, max = 0;
      for (let y = j * TILE; y < Math.min((j + 1) * TILE, height); y++) {
        for (let x = i * TILE; x < Math.min((i + 1) * TILE, width); x++) {
          const v = gray[y * width + x];
          if (v < min) min = v;
          if (v > max) max = v;
        }
      }
      raw[j * tx + i] = max - min < FLAT_CONTRAST ? NaN : (min + max) / 2;
    }
  }

  // A flat tile, such as a screen bezel or an empty dark area, has no edge of
  // its own to split. It borrows the threshold of nearby tiles that do, so a
  // marker ring beside a dark bezel is judged against the marker, not against
  // the whole image. The image mean is the fallback when nothing is near.
  const filled = new Float64Array(tx * ty);
  for (let j = 0; j < ty; j++) {
    for (let i = 0; i < tx; i++) {
      const own = raw[j * tx + i];
      if (!Number.isNaN(own)) { filled[j * tx + i] = own; continue; }
      let s = 0, n = 0;
      for (let reach = 1; reach <= FLAT_REACH && n === 0; reach++) {
        for (let b = Math.max(j - reach, 0); b <= Math.min(j + reach, ty - 1); b++) {
          for (let a = Math.max(i - reach, 0); a <= Math.min(i + reach, tx - 1); a++) {
            const v = raw[b * tx + a];
            if (!Number.isNaN(v)) { s += v; n++; }
          }
        }
      }
      filled[j * tx + i] = n ? s / n : globalMean;
    }
  }

  // Average each tile with its neighbors so thresholds do not jump at tile edges.
  const smooth = new Float64Array(tx * ty);
  for (let j = 0; j < ty; j++) {
    for (let i = 0; i < tx; i++) {
      let s = 0, n = 0;
      for (let b = Math.max(j - 1, 0); b <= Math.min(j + 1, ty - 1); b++) {
        for (let a = Math.max(i - 1, 0); a <= Math.min(i + 1, tx - 1); a++) { s += filled[b * tx + a]; n++; }
      }
      smooth[j * tx + i] = s / n;
    }
  }

  const bin = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = Math.floor(y / TILE) * tx;
    for (let x = 0; x < width; x++) {
      bin[y * width + x] = gray[y * width + x] <= smooth[row + Math.floor(x / TILE)] ? 1 : 0;
    }
  }
  return bin;
}

// ---- run ratio check ----

// runs is [dark, light, dark, light, dark].
//
// A camera looking at a bright screen in a dim room shows bloom: light runs
// grow and dark runs shrink by the same amount at every light to dark edge.
// A light ring plus the dark center next to it keeps its true length, so the
// unit comes from those two sums, and the bloom is measured rather than
// assumed to be zero. Measured on a phone photo of a TV: runs 13, 22, 12, 4
// where 9, 9, 27, 9, 9 were drawn.
//
// The outer runs are checked last and loosely: an outer ring can merge with a
// dark background around the frame, and bloom shrinks it from one side.
// Returns the unit (block size in pixels) or 0 when the shape does not match.
function checkRatio(runs, size) {
  const centerUnits = size === 7 ? 3 : 1;
  const left = runs[1] + runs[2];
  const right = runs[2] + runs[3];
  const unit = (left + right) / (2 * (centerUnits + 1));
  if (unit < MIN_UNIT) return 0;
  const tol = RATIO_TOLERANCE * unit;
  if (Math.abs(left - right) > tol) return 0; // the dark center sits midway
  if (Math.abs(runs[1] - runs[3]) > tol) return 0; // both light rings alike
  const spread = (runs[1] + runs[3]) / 2 - unit; // bloom: how much light runs grew
  if (Math.abs(spread) > MAX_SPREAD * unit) return 0;
  const outerMin = Math.max(1, (unit - Math.max(spread, 0)) * OUTER_MIN);
  if (runs[0] < outerMin || runs[4] < outerMin) return 0;
  return unit;
}

// Walks from a dark pixel in direction (dx, dy) and returns the lengths of the
// dark run it starts in (including the start pixel), the light run after it and
// the outer dark run after that. Returns null when the image edge cuts the
// pattern before the outer dark run starts.
function walk(bin, width, height, x, y, dx, dy) {
  const counts = [0, 0, 0];
  let state = 0;
  while (x >= 0 && x < width && y >= 0 && y < height) {
    const dark = bin[y * width + x] === 1;
    if (state === 1 && dark) state = 2;
    else if (state !== 1 && !dark) {
      if (state === 2) break;
      state = 1;
    }
    counts[state]++;
    x += dx; y += dy;
  }
  return state === 2 ? counts : null;
}

// Checks the pattern through dark pixel (x, y) along direction (dx, dy).
// Returns the unit, how many center run pixels lie behind (x, y), and the
// center run length; or null when the ratio does not match.
function crossCheck(bin, width, height, x, y, dx, dy, size) {
  const fwd = walk(bin, width, height, x, y, dx, dy);
  if (!fwd) return null;
  const back = walk(bin, width, height, x, y, -dx, -dy);
  if (!back) return null;
  const center = fwd[0] + back[0] - 1;
  const unit = checkRatio([back[2], back[1], center, fwd[1], fwd[2]], size);
  return unit ? { unit, behind: back[0] - 1, length: center } : null;
}

// ---- candidate scan ----

function rowRuns(bin, width, y) {
  const starts = [], lengths = [], dark = [];
  let x = 0;
  while (x < width) {
    const v = bin[y * width + x];
    const s = x;
    while (x < width && bin[y * width + x] === v) x++;
    starts.push(s); lengths.push(x - s); dark.push(v === 1);
  }
  return { starts, lengths, dark };
}

// Tests runs i - 4 .. i of row y horizontally, then vertically and diagonally
// through the center. A run of pixels a .. a + n - 1 has its center at a + n / 2.
function confirm(bin, width, height, runs, i, y, size) {
  const unitH = checkRatio(runs.lengths.slice(i - 4, i + 1), size);
  if (!unitH) return null;
  const cx = runs.starts[i - 2] + runs.lengths[i - 2] / 2;
  const col = Math.floor(cx);
  const v = crossCheck(bin, width, height, col, y, 0, 1, size);
  if (!v) return null;
  const cy = y - v.behind + v.length / 2;
  if (!crossCheck(bin, width, height, col, Math.floor(cy), 1, 1, size)) return null;
  return { x: cx, y: cy, pitch: (unitH + v.unit) / 2, size };
}

export function findFinderCandidates(bin, width, height) {
  const merged = [];
  for (let y = 0; y < height; y++) {
    const runs = rowRuns(bin, width, y);
    for (let i = 4; i < runs.dark.length; i++) {
      if (!runs.dark[i]) continue;
      for (const size of [7, 5]) {
        const hit = confirm(bin, width, height, runs, i, y, size);
        if (hit) addHit(merged, hit);
      }
    }
  }
  return merged
    .filter((c) => c.count >= MIN_CONFIRMATIONS)
    .map(({ x, y, pitch, size }) => ({ x, y, pitch, size }));
}

// ---- merge ----

function addHit(merged, hit) {
  for (const c of merged) {
    if (c.size === hit.size && Math.hypot(c.x - hit.x, c.y - hit.y) <= Math.max(c.pitch, hit.pitch)) {
      const n = c.count + 1;
      c.x += (hit.x - c.x) / n;
      c.y += (hit.y - c.y) / n;
      c.pitch += (hit.pitch - c.pitch) / n;
      c.count = n;
      return;
    }
  }
  merged.push({ ...hit, count: 1 });
}

// ---- orient ----

// Where the small marker should be if the frame were a parallelogram.
function predictBr(tl, tr, bl, pitch) {
  // The small marker's center sits one block further out along both edges than
  // the parallelogram corner tr + bl - tl, since it is 5 blocks wide, not 7.
  const ex = tr.x - tl.x, ey = tr.y - tl.y, fx = bl.x - tl.x, fy = bl.y - tl.y;
  const le = Math.hypot(ex, ey), lf = Math.hypot(fx, fy);
  return {
    x: tr.x + fx + (pitch * ex) / le + (pitch * fx) / lf,
    y: tr.y + fy + (pitch * ey) / le + (pitch * fy) / lf,
  };
}

// Finds the size 5 candidate nearest to where the small marker should be, or null.
function findBr(candidates, tl, tr, bl, pitch) {
  const p = predictBr(tl, tr, bl, pitch);
  let br = null, brDist = BR_SEARCH_PITCHES * pitch;
  for (const c of candidates) {
    if (c.size !== 5) continue;
    const d = Math.hypot(c.x - p.x, c.y - p.y);
    if (d <= brDist) { br = c; brDist = d; }
  }
  return br;
}

// Every size 5 candidate within BR_CANDIDATE_PITCHES of the prediction whose
// pitch is close to the triple's, nearest first. Data cells form many false
// size 5 patterns, so the caller must check each one against the timing strips.
function listBrCandidates(candidates, tl, tr, bl, pitch) {
  const p = predictBr(tl, tr, bl, pitch);
  const reach = BR_CANDIDATE_PITCHES * pitch;
  return candidates
    .filter((c) => c.size === 5 && Math.abs(c.pitch - pitch) <= BR_PITCH_TOLERANCE * pitch)
    .map((c) => ({ c, d: Math.hypot(c.x - p.x, c.y - p.y) }))
    .filter((e) => e.d <= reach)
    .sort((a, b) => a.d - b.d)
    .map((e) => e.c);
}

// Each triple of size 7 candidates with consistent pitches, oriented at its
// most perpendicular vertex, kept when that corner is within 25 degrees of square.
function rightAngleTriples(big) {
  const maxCos = Math.sin(MAX_ANGLE_ERROR); // |cos| of an angle 25 degrees off a right angle
  const found = [];
  for (let i = 0; i < big.length; i++) {
    for (let j = i + 1; j < big.length; j++) {
      for (let k = j + 1; k < big.length; k++) {
        const triple = [big[i], big[j], big[k]];
        const pitch = (triple[0].pitch + triple[1].pitch + triple[2].pitch) / 3;
        if (triple.some((c) => Math.abs(c.pitch - pitch) > PITCH_TOLERANCE * pitch)) continue;
        let corner = null;
        for (let v = 0; v < 3; v++) {
          const a = triple[v], b = triple[(v + 1) % 3], c = triple[(v + 2) % 3];
          const ux = b.x - a.x, uy = b.y - a.y, wx = c.x - a.x, wy = c.y - a.y;
          const lu = Math.hypot(ux, uy), lw = Math.hypot(wx, wy);
          if (lu === 0 || lw === 0) continue;
          const cos = Math.abs(ux * wx + uy * wy) / (lu * lw);
          if (corner && cos >= corner.cos) continue;
          // With y down, (tr - tl) x (bl - tl) is positive.
          const [tr, bl] = ux * wy - uy * wx > 0 ? [b, c] : [c, b];
          corner = { cos, span: lu + lw, tl: a, tr, bl, pitch };
        }
        if (corner && corner.cos <= maxCos) found.push(corner);
      }
    }
  }
  return found;
}

export function orientFinders(candidates) {
  const big = candidates.filter((c) => c.size === 7);
  if (big.length < 3) return null;
  const triples = rightAngleTriples(big);
  if (triples.length === 0) return null;

  // Rank by angle error. Among near ties, prefer a triple whose small marker
  // is where it should be, then the widest span.
  const bestCos = triples.reduce((m, t) => Math.min(m, t.cos), Infinity); // no spread: a noisy image can give thousands
  let best = null;
  for (const t of triples) {
    if (t.cos > bestCos + COS_TIE) continue;
    t.br = findBr(candidates, t.tl, t.tr, t.bl, t.pitch);
    if (!best || (!!t.br > !!best.br) || (!!t.br === !!best.br && t.span > best.span)) best = t;
  }
  const pt = (c) => [c.x, c.y];
  // br is only the nearest guess; brCandidates lists every plausible small marker.
  const describe = (t) => {
    const br = t.br === undefined ? findBr(candidates, t.tl, t.tr, t.bl, t.pitch) : t.br;
    return {
      tl: pt(t.tl), tr: pt(t.tr), bl: pt(t.bl), br: br && pt(br),
      brCandidates: listBrCandidates(candidates, t.tl, t.tr, t.bl, t.pitch).map(pt),
      pitch: t.pitch,
    };
  };
  // A false large marker in the data can form a squarer triple than the real
  // one under perspective, so the other triples follow as options for the
  // reader to check against the timing strips: best first, then by angle error.
  const rest = triples.filter((t) => t !== best).sort((a, b) => a.cos - b.cos || b.span - a.span);
  const options = [best, ...rest].slice(0, MAX_TRIPLE_OPTIONS).map(describe);
  return { ...options[0], options };
}
