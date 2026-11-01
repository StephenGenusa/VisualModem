import { blocksFromBytes, levelValue } from '../core/symbols.js';
import { schemeFromLevels, resolveScheme, schemeColors } from '../core/scheme.js';
import { frameToBlocks } from '../core/frame.js';
import { frameToBlocksV4 } from '../core/framev4.js';
import { CALIBRATION_LENGTH, ALIGN_SIZE } from './layout.js';

function fillCell(img, col, row, blockSize, r, g, b) {
  for (let y = row * blockSize; y < (row + 1) * blockSize; y++) {
    for (let x = col * blockSize; x < (col + 1) * blockSize; x++) {
      const o = (y * img.width + x) * 4;
      img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = 255;
    }
  }
}

function paintFinder(img, finder, blockSize) {
  for (let dy = 0; dy < finder.size; dy++) {
    for (let dx = 0; dx < finder.size; dx++) {
      const ring = Math.min(dx, dy, finder.size - 1 - dx, finder.size - 1 - dy);
      const v = ring === 1 ? 255 : 0; // black outer ring, one white ring, black center
      fillCell(img, finder.col + dx, finder.row + dy, blockSize, v, v, v);
    }
  }
}

// Ramp steps shown for a channel of n levels: 256 levels show 16 steps.
const rampSteps = (n) => Math.min(n, 16);

/**
 * The calibration strip: 16 ramp cells, then pure red, green and blue. Ramp
 * cell i shows, in each channel of L levels, level floor(i * L / 16); a gray
 * scheme shows the same level in all three channels. For the cube this is the
 * version 2 strip.
 * @param {object | number} schemeOrLevels a scheme, or a cube's levels
 */
export function calibrationColors(schemeOrLevels) {
  const scheme = typeof schemeOrLevels === 'number' ? schemeFromLevels(schemeOrLevels) : schemeOrLevels;
  const per = scheme.kind === 'gray' ? [scheme.levels, scheme.levels, scheme.levels] : scheme.levels;
  const colors = new Uint8Array(CALIBRATION_LENGTH * 3);
  for (let i = 0; i < 16; i++) {
    for (let c = 0; c < 3; c++) {
      const steps = rampSteps(per[c]);
      colors[i * 3 + c] = levelValue(steps, Math.floor((i * steps) / 16));
    }
  }
  colors.set([255, 0, 0, 0, 255, 0, 0, 0, 255], 16 * 3);
  return colors;
}

// white is the channel value drawn for full white, 1 to 255. A lower value
// dims the whole frame (markers, strips, ramp and data alike) so a bright
// screen does not overexpose a phone camera. Black stays 0. The receiver reads
// the level steps from the ramp, so it needs no setting.
//
// scheme is the frame's color scheme; levels alone means the cube. Version 3
// frames draw the header cells in HEADER_SCHEME (see src/core/frame.js);
// version: 2 draws the whole frame in the cube, as old frames were.
// blocks, when given, are the data cell colors to draw instead of frameBytes'
// (the characterization frame draws its own patches).
export function renderFrame({ frameBytes, index, scheme: given, levels, blockSize, layout, white = 255, version = 3, blocks: givenBlocks }) {
  const scheme = resolveScheme(given, levels);
  const width = layout.cols * blockSize;
  const height = layout.rows * blockSize;
  const img = { data: new Uint8ClampedArray(width * height * 4).fill(255), width, height };

  for (const f of Object.values(layout.finders)) paintFinder(img, f, blockSize);

  const { timingTop, timingLeft, calibration, parity } = layout;
  for (let c = timingTop.colStart; c <= timingTop.colEnd; c++) {
    const v = (c - timingTop.colStart) % 2 === 0 ? 0 : 255;
    fillCell(img, c, timingTop.row, blockSize, v, v, v);
  }
  for (let r = timingLeft.rowStart; r <= timingLeft.rowEnd; r++) {
    const v = (r - timingLeft.rowStart) % 2 === 0 ? 0 : 255;
    fillCell(img, timingLeft.col, r, blockSize, v, v, v);
  }

  const cal = calibrationColors(scheme);
  for (let i = 0; i < CALIBRATION_LENGTH; i++) {
    fillCell(img, calibration.colStart + i, calibration.row, blockSize, cal[i * 3], cal[i * 3 + 1], cal[i * 3 + 2]);
  }

  const pv = index % 2 === 0 ? 0 : 255;
  if (version === 4) {
    // Version 4: the right strip alternates down its rows, starting dark on an
    // even index (light on odd), and a second strip runs along the bottom.
    const { timingRight, timingBottom, align, pilots } = layout;
    for (let r = timingRight.rowStart; r <= timingRight.rowEnd; r++) {
      const v = (r - timingRight.rowStart) % 2 === 0 ? pv : 255 - pv;
      fillCell(img, timingRight.col, r, blockSize, v, v, v);
    }
    for (let c = timingBottom.colStart; c <= timingBottom.colEnd; c++) {
      const v = (c - timingBottom.colStart) % 2 === 0 ? 0 : 255;
      fillCell(img, c, timingBottom.row, blockSize, v, v, v);
    }
    const half = (ALIGN_SIZE - 1) / 2;
    for (const a of align) {
      for (let dy = -half; dy <= half; dy++) {
        for (let dx = -half; dx <= half; dx++) {
          const v = Math.max(Math.abs(dx), Math.abs(dy)) === 1 ? 255 : 0;
          fillCell(img, a.col + dx, a.row + dy, blockSize, v, v, v);
        }
      }
    }
    const colors = schemeColors(scheme);
    pilots.forEach((cell, p) => {
      const [r, g, b] = colors[p % colors.length];
      fillCell(img, cell % layout.cols, Math.floor(cell / layout.cols), blockSize, r, g, b);
    });
  } else {
    for (let r = parity.rowStart; r <= parity.rowEnd; r++) fillCell(img, parity.col, r, blockSize, pv, pv, pv);
  }

  const blocks = givenBlocks ?? (version === 2
    ? blocksFromBytes(frameBytes, levels, layout.dataBlockCount)
    : version === 4
      ? frameToBlocksV4(frameBytes, scheme, layout)
      : frameToBlocks(frameBytes, scheme, layout.dataBlockCount));
  for (let i = 0; i < layout.dataBlockCount; i++) {
    const cell = layout.dataCells[i];
    fillCell(img, cell % layout.cols, Math.floor(cell / layout.cols), blockSize, blocks[i * 3], blocks[i * 3 + 1], blocks[i * 3 + 2]);
  }
  if (white < 255) dim(img, white);
  return img;
}

function dim(img, white) {
  const map = new Uint8Array(256);
  for (let v = 0; v < 256; v++) map[v] = Math.round((v * white) / 255);
  const { data } = img;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = map[data[i]]; data[i + 1] = map[data[i + 1]]; data[i + 2] = map[data[i + 2]];
  }
}
