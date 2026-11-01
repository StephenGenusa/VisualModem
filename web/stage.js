// The full screen stage: a canvas that shows a transmission's frames in a loop.
// Start uses it for a payload, and auto tune for one trial after another
// without leaving full screen. Escape, a click or a tap, or leaving full
// screen closes it. iOS Safari has no element full screen, so there the
// canvas fills the page instead.
//
// Frames change on display refreshes: showLoop renders each frame once at 1
// pixel per block, scales it up with smoothing off, and changes frames every
// refreshesPerFrame requestAnimationFrame refreshes. A pixel self-check falls
// back to full-size renders when the browser smooths the scale anyway.
import { renderFrame } from '../src/picture/render.js';
import { estimateRefreshHz, refreshesPerFrame, actualFps, checkCells } from '../src/picture/cadence.js';

const MEASURE_REFRESHES = 30; // refreshes timed after openStage for the refresh rate
const CHECK_CELLS = 64;
const CHECK_SEED = 0x5eed;
const CACHE_BYTES = 64 * 1024 * 1024; // 1 px frames kept for the loop up to this much

let stage = null;
let loopRaf = null; // the frame loop's pending requestAnimationFrame
let measureRaf = null;
let refreshHz = null; // measured once per stage session
let noteText = ''; // the caller's note
let fpsNote = ''; // the running loop's actual frame rate, when it has more than one frame
let fallbackMode = false;
let open = false;
let refused = false; // the last openStage failed because the browser refused full screen
const closedCallbacks = [];
let frameRect = null; // where the last frame was drawn, so a note goes in the margin
let noteCtx = null;
// The pixel self-check verdict per layout (block size, grid and stage size),
// for this stage session: true when the 1 px scaled frame draws exactly.
let scaledVerdicts = new Map();

export function hasElementFullscreen() {
  return typeof HTMLCanvasElement.prototype.requestFullscreen === 'function';
}

function getStage() {
  if (!stage) {
    stage = document.createElement('canvas');
    stage.className = 'stage';
    stage.hidden = true;
    document.body.appendChild(stage);
    stage.addEventListener('click', closeStage);
    stage.addEventListener('touchend', (e) => {
      e.preventDefault();
      closeStage();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && open) closeStage();
    });
    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement && !fallbackMode && open) closeStage();
    });
  }
  return stage;
}

/**
 * Shows the stage at the display size and goes full screen.
 * @param {{ widthPx: number, heightPx: number, cssWidth?: number, cssHeight?: number }} pixels
 * @returns {Promise<CanvasRenderingContext2D | null>} null when the browser refused full screen
 */
export async function openStage(pixels) {
  const canvas = getStage();
  fallbackMode = !hasElementFullscreen();
  if (fallbackMode) window.scrollTo(0, 0);
  canvas.width = pixels.widthPx;
  canvas.height = pixels.heightPx;
  canvas.classList.toggle('fallback', fallbackMode);
  canvas.style.width = fallbackMode ? `${pixels.cssWidth}px` : '';
  canvas.style.height = fallbackMode ? `${pixels.cssHeight}px` : '';
  if (fallbackMode) document.documentElement.classList.add('transmitting');
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  canvas.hidden = false;
  open = true;
  refused = false;
  if (refreshHz === null && measureRaf === null) measureRefresh();

  if (!fallbackMode) {
    try {
      await canvas.requestFullscreen({ navigationUI: 'hide' });
    } catch {
      refused = true;
      closeStage();
      return null;
    }
    if (document.fullscreenElement !== canvas) return null; // left full screen while it was opening
  }
  return ctx;
}

// Times the first refreshes after openStage, for stageRefreshHz.
function measureRefresh() {
  const stamps = [];
  const step = (t) => {
    stamps.push(t);
    if (stamps.length < MEASURE_REFRESHES) {
      measureRaf = requestAnimationFrame(step);
      return;
    }
    measureRaf = null;
    refreshHz = estimateRefreshHz(stamps);
  };
  measureRaf = requestAnimationFrame(step);
}

/**
 * The stage's display refresh rate in Hz, measured over the first 30
 * refreshes after openStage and kept for the stage session; null until then.
 */
export const stageRefreshHz = () => refreshHz;

function renderAt(tx, layout, settings, index, blockSize) {
  const { levels, scheme, white } = settings;
  if (tx.frameAt) {
    // Version 4: the right strip's phase follows the frame's own index, so i never wraps.
    return renderFrame({ frameBytes: tx.frameAt(index), index, scheme: tx.scheme ?? scheme, blockSize, layout, white, version: 4 });
  }
  return renderFrame({ frameBytes: tx.frames[index], index, scheme: tx.scheme ?? scheme, levels, blockSize, layout, white });
}

function drawFrame(ctx, tx, layout, settings, index) {
  const img = renderAt(tx, layout, settings, index, settings.blockSize);
  const x = Math.floor((stage.width - img.width) / 2);
  const y = Math.floor((stage.height - img.height) / 2);
  ctx.putImageData(new ImageData(img.data, img.width, img.height), x, y);
  frameRect = { x, y, width: img.width, height: img.height };
  noteCtx = ctx;
}

/**
 * Writes one line of text in the black margin below the frame, or clears it
 * with ''. Nothing is drawn when the margin is too thin, so the frame itself
 * is never covered.
 */
export function setStageNote(text) {
  noteText = text;
  drawNote();
}

function drawNote() {
  const text = [noteText, fpsNote].filter(Boolean).join(', ');
  if (!noteCtx || !frameRect || !stage) return;
  const top = frameRect.y + frameRect.height + 2;
  const height = stage.height - top;
  if (height < 16) return;
  const size = Math.min(48, Math.floor(height * 0.6));
  noteCtx.fillStyle = '#000';
  noteCtx.fillRect(0, top, stage.width, height);
  if (!text) return;
  noteCtx.fillStyle = '#999';
  noteCtx.font = `${size}px sans-serif`;
  noteCtx.textBaseline = 'middle';
  noteCtx.fillText(text, 8, top + height / 2, stage.width - 16);
}

function stopLoop() {
  if (loopRaf !== null) cancelAnimationFrame(loopRaf);
  loopRaf = null;
  fpsNote = '';
}

// True when every checked cell of the drawn frame shows its color exactly at
// its centre and both edge pixels, on the middle row of the cell.
function scaledFrameIsExact(ctx, small, x, y, blockSize) {
  const { width: cols, height: rows, data } = small;
  try {
    for (const cell of checkCells(cols, rows, CHECK_CELLS, CHECK_SEED)) {
      const col = cell % cols;
      const row = Math.floor(cell / cols);
      const got = ctx.getImageData(x + col * blockSize, y + row * blockSize + (blockSize >> 1), blockSize, 1).data;
      for (const px of [0, blockSize >> 1, blockSize - 1]) {
        for (let c = 0; c < 3; c++) if (got[px * 4 + c] !== data[cell * 4 + c]) return false;
      }
    }
  } catch {
    return false;
  }
  return true;
}

/**
 * Starts the frame loop, or replaces the one running, without leaving full
 * screen. Frames change every refreshesPerFrame display refreshes, once the
 * stage's refresh rate is measured; until then the first frame stays up.
 * @param {CanvasRenderingContext2D} ctx from openStage
 */
export function showLoop(ctx, { tx, layout, settings }) {
  stopLoop();
  noteText = '';
  ctx.fillStyle = '#000'; // the new frame may be smaller than the last one
  ctx.fillRect(0, 0, stage.width, stage.height);
  const { cols, rows } = layout;
  const { blockSize } = settings;
  const x = Math.floor((stage.width - cols * blockSize) / 2);
  const y = Math.floor((stage.height - rows * blockSize) / 2);
  const small = document.createElement('canvas');
  small.width = cols;
  small.height = rows;
  const smallCtx = small.getContext('2d');
  // Version 4 repeats its source frames each period, so only those are cached,
  // keyed by i % period. Repair frames are new every time and are not kept.
  const v4 = Boolean(tx.frameAt);
  const cacheKey = (i) => {
    if (!v4) return i;
    const r = i % tx.period;
    return r < tx.sourceFrames ? r : null;
  };
  const cacheFrames = v4 ? tx.sourceFrames : tx.count;
  const cache = cacheFrames * cols * rows * 4 <= CACHE_BYTES ? [] : null;
  const smallFrame = (i) => {
    const key = cacheKey(i);
    if (cache && key !== null && cache[key]) return cache[key];
    const img = renderAt(tx, layout, settings, i, 1);
    const data = new ImageData(img.data, img.width, img.height);
    if (cache && key !== null) cache[key] = data;
    return data;
  };
  let full = false;
  const show = (i) => {
    if (full) {
      drawFrame(ctx, tx, layout, settings, i);
      return;
    }
    smallCtx.putImageData(smallFrame(i), 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(small, 0, 0, cols, rows, x, y, cols * blockSize, rows * blockSize);
    frameRect = { x, y, width: cols * blockSize, height: rows * blockSize };
    noteCtx = ctx;
  };

  let index = 0;
  show(0);
  // The check reads pixels back, which stalls the canvas, so it runs once per
  // layout per stage session and later loops on that layout reuse the verdict.
  const layoutKey = `${blockSize},${cols},${rows},${stage.width}x${stage.height}`;
  let exact = scaledVerdicts.get(layoutKey);
  if (exact === undefined) {
    exact = scaledFrameIsExact(ctx, smallFrame(0), x, y, blockSize);
    scaledVerdicts.set(layoutKey, exact);
    if (exact) console.log('cadence: 1 px scaled');
    else console.warn('cadence: the scaled frame did not match its cells, falling back to full-size renders');
  }
  if (!exact) {
    full = true;
    show(0);
  }

  if (!v4 && tx.count < 2) return; // one frame: nothing changes, so no loop (version 4 always changes)
  let perFrame = null;
  let refreshes = 0;
  const tick = () => {
    loopRaf = null;
    if (perFrame === null) {
      if (refreshHz === null) {
        loopRaf = requestAnimationFrame(tick);
        return;
      }
      // Counting starts with the next refresh, so the first frame also stays up for perFrame.
      perFrame = refreshesPerFrame(refreshHz, settings.fps);
      fpsNote = `${+actualFps(refreshHz, settings.fps).toFixed(2)} fps`;
      drawNote();
    } else if (++refreshes >= perFrame) {
      refreshes = 0;
      index = v4 ? index + 1 : (index + 1) % tx.count;
      show(index);
    }
    loopRaf = requestAnimationFrame(tick);
  };
  loopRaf = requestAnimationFrame(tick);
}

/** Stops any loop and shows one image, centered, without leaving full screen. */
export function showImage(ctx, img) {
  stopLoop();
  noteText = '';
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, stage.width, stage.height);
  const x = Math.floor((stage.width - img.width) / 2);
  const y = Math.floor((stage.height - img.height) / 2);
  ctx.putImageData(new ImageData(img.data, img.width, img.height), x, y);
  frameRect = { x, y, width: img.width, height: img.height };
  noteCtx = ctx;
}

export function closeStage() {
  stopLoop();
  if (measureRaf !== null) cancelAnimationFrame(measureRaf);
  measureRaf = null;
  refreshHz = null;
  scaledVerdicts = new Map();
  if (stage) stage.hidden = true;
  document.documentElement.classList.remove('transmitting');
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  if (!open) return;
  open = false;
  for (const callback of closedCallbacks) callback();
}

export const isStageOpen = () => open;

/** True when the last openStage returned null because the browser refused full screen. */
export const stageRefused = () => refused;

/** Calls callback each time the stage closes, by any route. */
export function onStageClosed(callback) {
  closedCallbacks.push(callback);
}
