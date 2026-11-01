import { VmError } from '../core/errors.js';
import { random32 } from '../optimize/prbs.js';

export const MIN_COLS = 33;
export const MIN_ROWS = 20;
export const CALIBRATION_LENGTH = 19;

export function computeLayout(cols, rows) {
  if (cols < MIN_COLS || rows < MIN_ROWS) {
    throw new VmError('GRID_TOO_SMALL', `Grid ${cols}x${rows} is below the minimum ${MIN_COLS}x${MIN_ROWS}`);
  }
  const finders = {
    tl: { col: 0, row: 0, size: 7 },
    tr: { col: cols - 7, row: 0, size: 7 },
    bl: { col: 0, row: rows - 7, size: 7 },
    br: { col: cols - 5, row: rows - 5, size: 5 },
  };
  const timingTop = { row: 6, colStart: 8, colEnd: cols - 9 };
  const timingLeft = { col: 6, rowStart: 8, rowEnd: rows - 9 };
  const calibration = { row: rows - 1, colStart: 8 };
  const parity = { col: cols - 1, rowStart: 8, rowEnd: rows - 7 };

  const reserved = new Uint8Array(cols * rows);
  const fill = (c0, c1, r0, r1) => {
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) reserved[r * cols + c] = 1;
  };
  // Each finder plus its one block quiet ring on the sides facing the grid interior.
  fill(0, 7, 0, 7);
  fill(cols - 8, cols - 1, 0, 7);
  fill(0, 7, rows - 8, rows - 1);
  fill(cols - 6, cols - 1, rows - 6, rows - 1);
  fill(timingTop.colStart, timingTop.colEnd, timingTop.row, timingTop.row);
  fill(timingLeft.col, timingLeft.col, timingLeft.rowStart, timingLeft.rowEnd);
  fill(calibration.colStart, calibration.colStart + CALIBRATION_LENGTH - 1, calibration.row, calibration.row);
  fill(parity.col, parity.col, parity.rowStart, parity.rowEnd);

  const cells = [];
  for (let i = 0; i < reserved.length; i++) if (!reserved[i]) cells.push(i);
  const dataCells = Int32Array.from(cells);
  return { cols, rows, finders, timingTop, timingLeft, calibration, parity, reserved, dataCells, dataBlockCount: dataCells.length };
}

// Version 4 adds a bottom timing strip beside the calibration strip, small
// alignment patterns inside the picture, and pilot cells of known color.
export const ALIGN_SPACING = 32;
export const ALIGN_ORIGIN = 18;
export const ALIGN_SIZE = 5;
export const PILOT_CELLS = 48;
export const HEADER_CELLS_V4 = 128;
export const BOTTOM_TIMING_START = 27; // just after the 19 calibration cells

/**
 * The version 3 layout with its data cells narrowed to version 4's. The first
 * 128 and last 128 candidates never become pilots, so the header copies and
 * the tail keep their places. Depends only on the grid size.
 */
export function computeLayoutV4(cols, rows) {
  const v3 = computeLayout(cols, rows);
  const timingRight = { ...v3.parity };
  const timingBottom = { row: rows - 1, colStart: BOTTOM_TIMING_START, colEnd: cols - 7 };
  const align = [];
  for (let x = ALIGN_ORIGIN; x <= cols - 12; x += ALIGN_SPACING) {
    for (let y = ALIGN_ORIGIN; y <= rows - 12; y += ALIGN_SPACING) align.push({ col: x, row: y });
  }

  const taken = new Uint8Array(cols * rows);
  for (let c = timingBottom.colStart; c <= timingBottom.colEnd; c++) taken[timingBottom.row * cols + c] = 1;
  const half = (ALIGN_SIZE - 1) / 2;
  for (const a of align) {
    for (let r = a.row - half; r <= a.row + half; r++) {
      for (let c = a.col - half; c <= a.col + half; c++) taken[r * cols + c] = 1;
    }
  }

  const candidates = [];
  const candidateV3 = [];
  for (let i = 0; i < v3.dataCells.length; i++) {
    if (!taken[v3.dataCells[i]]) {
      candidates.push(v3.dataCells[i]);
      candidateV3.push(i);
    }
  }

  // Pilots come from the middle, so the header copies and the tail stay put.
  const pool = candidates.slice(HEADER_CELLS_V4, candidates.length - HEADER_CELLS_V4);
  const next = random32((Math.imul(cols, 0x10000) + rows) >>> 0);
  for (let i = pool.length - 1; i >= 1; i--) {
    const j = next() % (i + 1);
    const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
  }
  const pilots = Int32Array.from(pool.slice(0, PILOT_CELLS)).sort();
  const isPilot = new Uint8Array(cols * rows);
  for (const p of pilots) isPilot[p] = 1;

  const data = [];
  const v3Index = [];
  for (let i = 0; i < candidates.length; i++) {
    if (!isPilot[candidates[i]]) {
      data.push(candidates[i]);
      v3Index.push(candidateV3[i]);
    }
  }
  const dataCells = Int32Array.from(data);

  const reserved = new Uint8Array(cols * rows).fill(1);
  for (const c of dataCells) reserved[c] = 0;
  return {
    ...v3, timingRight, timingBottom, align, pilots, reserved, dataCells,
    dataBlockCount: dataCells.length, v3Index: Int32Array.from(v3Index),
  };
}

export function fitGrid(widthPx, heightPx, blockSize) {
  return { cols: Math.floor(widthPx / blockSize), rows: Math.floor(heightPx / blockSize) };
}

export function maxBlockSize(widthPx, heightPx) {
  return Math.min(Math.floor(widthPx / MIN_COLS), Math.floor(heightPx / MIN_ROWS));
}

export function cellCenter(layout, cellIndex, blockSize) {
  const col = cellIndex % layout.cols;
  const row = Math.floor(cellIndex / layout.cols);
  return { x: col * blockSize + blockSize / 2, y: row * blockSize + blockSize / 2 };
}
