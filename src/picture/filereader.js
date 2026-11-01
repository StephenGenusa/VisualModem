import { computeLayout, computeLayoutV4, fitGrid, cellCenter } from './layout.js';
import { bytesFromBlocks, bitsPerChannel, schemeThresholds } from '../core/symbols.js';
import {
  peekHeader, parseFrame, headerBytesFromBlocks, blocksToFrameBytes, HEADER_PARITY, HEADER_BYTES_V2,
  HEADER_SCHEME, HEADER_CELLS, VERSION, VERSION_2,
} from '../core/frame.js';
import { peekHeaderV4, parseFrameV4, blocksToFrameBytesV4, HEADER_CODEWORD_V4, VERSION_4 } from '../core/framev4.js';

const BLOCK_SIZES = [1, 2, 3, 4];
const LEVEL_TRIALS = [256, 16, 8, 4, 2]; // version 2 frames
const HEADER_CODEWORD_BITS_V2 = (HEADER_BYTES_V2 + HEADER_PARITY) * 8;
const HEADER_T = schemeThresholds(HEADER_SCHEME);

// RGB of the center pixel of the first cellCount data cells.
export function sampleCells(img, layout, blockSize, cellCount) {
  const rgb = new Uint8Array(cellCount * 3);
  for (let i = 0; i < cellCount; i++) {
    const c = cellCenter(layout, layout.dataCells[i], blockSize);
    const p = (Math.floor(c.y) * img.width + Math.floor(c.x)) * 4;
    rgb[i * 3] = img.data[p];
    rgb[i * 3 + 1] = img.data[p + 1];
    rgb[i * 3 + 2] = img.data[p + 2];
  }
  return rgb;
}

function tryLayout(cols, rows) {
  try {
    return computeLayout(cols, rows);
  } catch (e) {
    if (e && e.code === 'GRID_TOO_SMALL') return null;
    throw e;
  }
}

function tryLayoutV4(cols, rows) {
  try {
    return computeLayoutV4(cols, rows);
  } catch (e) {
    if (e && e.code === 'GRID_TOO_SMALL') return null;
    throw e;
  }
}

// True when the first data cells hold a version 4 header for this block size.
function peeksV4(img, layout, blockSize) {
  if (layout.dataBlockCount < HEADER_CELLS) return false;
  const headBytes = headerBytesFromBlocks(sampleCells(img, layout, blockSize, HEADER_CELLS), HEADER_T);
  const head = peekHeaderV4(headBytes.subarray(0, HEADER_CODEWORD_V4));
  return !!head && head.version === VERSION_4 && head.blockSize === blockSize;
}

// A version 4 frame: the header sits in the first 128 data cells, as in version 3.
function readV4(img, layout, blockSize) {
  if (layout.dataBlockCount < HEADER_CELLS) return null;
  const headBytes = headerBytesFromBlocks(sampleCells(img, layout, blockSize, HEADER_CELLS), HEADER_T);
  const head = peekHeaderV4(headBytes.subarray(0, HEADER_CODEWORD_V4));
  if (!head || head.version !== VERSION_4 || head.blockSize !== blockSize) return null;
  const all = sampleCells(img, layout, blockSize, layout.dataBlockCount);
  const frame = parseFrameV4(blocksToFrameBytesV4(all, head.scheme, HEADER_T, schemeThresholds(head.scheme), layout));
  return frame && { blockSize, levels: head.levels, scheme: head.scheme, layout, frame };
}

// A version 3 frame: the header in HEADER_SCHEME names the scheme.
function readV3(img, layout, blockSize) {
  if (layout.dataBlockCount < HEADER_CELLS) return null;
  const head = peekHeader(headerBytesFromBlocks(sampleCells(img, layout, blockSize, HEADER_CELLS), HEADER_T));
  if (!head || head.version !== VERSION || head.blockSize !== blockSize) return null;
  const all = sampleCells(img, layout, blockSize, layout.dataBlockCount);
  const frame = parseFrame(blocksToFrameBytes(all, head.scheme, HEADER_T, schemeThresholds(head.scheme)));
  return frame && { blockSize, levels: head.levels, scheme: head.scheme, layout, frame };
}

/**
 * Reads a pixel exact frame image: version 4 first, then version 3, at block sizes 1 to 4,
 * then the version 2 level trials. Returns { blockSize, levels, scheme, layout, frame } or null.
 */
export function readImageFrame(img) {
  for (const blockSize of BLOCK_SIZES) {
    const { cols, rows } = fitGrid(img.width, img.height, blockSize);
    const layout = tryLayout(cols, rows);
    if (!layout) continue;
    // The first 128 data cells are the same in versions 3 and 4, so the header
    // can be peeked on the cheap version 3 layout. The version 4 layout is slow
    // to build at large sizes and is only built once a version 4 header is seen.
    const layout4 = peeksV4(img, layout, blockSize) ? tryLayoutV4(cols, rows) : null;
    const v4 = layout4 && readV4(img, layout4, blockSize);
    if (v4) return v4;
    const v3 = readV3(img, layout, blockSize);
    if (v3) return v3;
    for (const levels of LEVEL_TRIALS) {
      const headerCells = Math.ceil(HEADER_CODEWORD_BITS_V2 / (3 * bitsPerChannel(levels)));
      if (headerCells > layout.dataBlockCount) continue;
      const head = peekHeader(bytesFromBlocks(sampleCells(img, layout, blockSize, headerCells), levels));
      if (!head || head.version !== VERSION_2 || head.blockSize !== blockSize || head.levels !== levels) continue;
      const all = sampleCells(img, layout, blockSize, layout.dataBlockCount);
      const frame = parseFrame(bytesFromBlocks(all, levels));
      if (frame) return { blockSize, levels, scheme: frame.header.scheme, layout, frame };
    }
  }
  return null;
}
