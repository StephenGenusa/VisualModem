import { LEVEL_OPTIONS } from '../src/core/symbols.js';
import { SCHEME_CHOICES } from '../src/core/scheme.js';
import { MIN_COLS, MIN_ROWS } from '../src/picture/layout.js';

export const SCREEN_DEFAULTS = { blockSize: 16, levels: 4, scheme: 'cube', parity: 32, fps: 2, white: 255, fountain: true };
export const PHONE_BLOCK_SIZE = 24;
export const FILE_DEFAULTS = { width: 1920, height: 1080, blockSize: 1, levels: 256, parity: 0 };

const PREFIX = 'visual-modem:';

function isPhone() {
  return typeof navigator !== 'undefined' && typeof screen !== 'undefined'
    && navigator.maxTouchPoints > 0
    && Math.min(screen.width, screen.height) < 900;
}

function defaultsFor(key) {
  if (key === 'file') return { ...FILE_DEFAULTS };
  return isPhone() ? { ...SCREEN_DEFAULTS, blockSize: PHONE_BLOCK_SIZE } : { ...SCREEN_DEFAULTS };
}

// Slider and input ranges. The screen block size slider's top is the cap for
// the display, which the sender applies when it sets up the slider.
const SCREEN_BLOCK_MIN = 4;
const SCREEN_BLOCK_MAX = 512;
const FILE_BLOCK_MIN = 1;
const FILE_BLOCK_MAX = 4; // the file reader tries block sizes 1 to 4 only
const PARITY_MAX = 128;
const FPS_MIN = 0.5;
const FPS_MAX = 10;
const FPS_STEP = 0.5;
const FILE_SIDE_MAX = 8192;
export const WHITE_MIN = 64; // below this the levels crowd together on a camera
export const WHITE_MAX = 255;

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Validates stored settings for 'screen' or 'file'. Each known key is clamped
 * to its control's range; a value that is not a number, or levels that are
 * not an option, falls back to the default. Unknown keys are dropped.
 */
export function sanitizeSettings(key, raw) {
  const defaults = defaultsFor(key);
  const saved = raw && typeof raw === 'object' ? raw : {};
  const out = { ...defaults };
  const take = (name, fix) => {
    if (isNumber(saved[name])) out[name] = fix(saved[name]);
  };
  const [blockMin, blockMax] = key === 'file' ? [FILE_BLOCK_MIN, FILE_BLOCK_MAX] : [SCREEN_BLOCK_MIN, SCREEN_BLOCK_MAX];
  take('blockSize', (v) => clamp(Math.round(v), blockMin, blockMax));
  if (LEVEL_OPTIONS.includes(saved.levels)) out.levels = saved.levels;
  take('parity', (v) => clamp(2 * Math.floor(v / 2), 0, PARITY_MAX));
  if (key === 'file') {
    take('width', (v) => clamp(Math.floor(v), MIN_COLS * out.blockSize, FILE_SIDE_MAX));
    take('height', (v) => clamp(Math.floor(v), MIN_ROWS * out.blockSize, FILE_SIDE_MAX));
  } else {
    take('fps', (v) => clamp(Math.floor(v / FPS_STEP) * FPS_STEP, FPS_MIN, FPS_MAX));
    take('white', (v) => clamp(Math.round(v), WHITE_MIN, WHITE_MAX));
    if (SCHEME_CHOICES.some((c) => c.id === saved.scheme)) out.scheme = saved.scheme;
    if (typeof saved.fountain === 'boolean') out.fountain = saved.fountain;
  }
  return out;
}

export function loadSettings(key) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return sanitizeSettings(key, raw ? JSON.parse(raw) : null);
  } catch {
    return defaultsFor(key);
  }
}

export function saveSettings(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Storage blocked or full: settings simply do not persist.
  }
}
