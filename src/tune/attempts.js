// Sorts one camera attempt against the test the laptop says is on screen.
// The phone learns of a new test up to a second late, so an attempt counts
// for a test only when what it saw matches that test's transmission or grid.

const COLUMN_TOLERANCE = 0.08; // neighbouring descent steps differ by about 13 percent in columns

/**
 * The grid's column count as the markers suggest it, before any grid is read:
 * the distance between the top markers in blocks, plus the 7 they span.
 * Returns null without both top corners and a pitch.
 */
export function estimateColumns(read) {
  const { tl, tr } = read.corners ?? {};
  if (!tl || !tr || !(read.pitch > 0)) return null;
  return Math.round(Math.hypot(tr[0] - tl[0], tr[1] - tl[1]) / read.pitch) + 7;
}

/**
 * @param {{ stage: string, header?: { txId: number } }} debug the worker's diagnosis
 * @param {object} read the reader's result (markersFound, cols, rows, corners, pitch)
 * @param {{ txId: number, cols: number, rows: number } | null} test
 * @returns {'ok'|'frame'|'markers'|'none'}
 */
export function classifyAttempt(debug, read, test) {
  if (!read || !read.markersFound) return 'none';
  if (!test) return 'markers';
  if (debug.stage === 'ok') return debug.header && debug.header.txId === test.txId ? 'ok' : 'markers';
  if (read.cols && read.rows) return read.cols === test.cols && read.rows === test.rows ? 'frame' : 'markers';
  const estimate = estimateColumns(read);
  if (estimate === null) return 'markers';
  return Math.abs(estimate - test.cols) <= COLUMN_TOLERANCE * test.cols ? 'frame' : 'markers';
}
