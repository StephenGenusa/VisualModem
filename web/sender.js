import { encodePayload, peekManifest } from '../src/core/payload.js';
import { frameShapeV4 } from '../src/core/framev4.js';
import { encodeTransmission, encodeTransmissionV4, planV4 } from '../src/core/transmission.js';
import { buildFrame, frameGrossBytes } from '../src/core/frame.js';
import { SCHEME_CHOICES } from '../src/core/scheme.js';
import { settingsScheme } from '../src/core/transmission.js';
import { computeLayout, computeLayoutV4, fitGrid } from '../src/picture/layout.js';
import { renderFrame } from '../src/picture/render.js';
import { computeReadout } from './readout.js';
import { loadSettings, saveSettings } from './settings.js';
import { openStage, showLoop, isStageOpen, stageRefused, onStageClosed, hasElementFullscreen } from './stage.js';
import { setupTune } from './tune.js';
import { setupRunner } from './runner.js';
import { setupProbe } from './probe.js';
import { THEMES, loadTheme, saveTheme, shownTheme } from './theme.js';
import { setStatus } from './status.js';

const QR_SCRIPT = new URL('./vendor/qrcode.js', import.meta.url).href;
const INPUT_DEBOUNCE_MS = 150;

const $ = (id) => document.getElementById(id);

// The encoded payload stream, or null when there is nothing to send.
let stream = null;
let streamError = '';
let payloadGeneration = 0;
let screenSettings;
let fileSettings;

function screenPixels() {
  const dpr = window.devicePixelRatio || 1;
  return { widthPx: Math.round(screen.width * dpr), heightPx: Math.round(screen.height * dpr) };
}

function viewportPixels() {
  const dpr = window.devicePixelRatio || 1;
  const vv = window.visualViewport;
  const w = vv ? vv.width : window.innerWidth;
  const h = vv ? vv.height : window.innerHeight;
  return { cssWidth: w, cssHeight: h, widthPx: Math.round(w * dpr), heightPx: Math.round(h * dpr) };
}

// The pixel size a transmission will use, so the cap and readout match what Start sends.
function displayPixels() {
  return hasElementFullscreen() ? screenPixels() : viewportPixels();
}

function formatNumber(n) {
  return n.toLocaleString('en-US');
}

function framesText(count) {
  return `${formatNumber(count)} ${count === 1 ? 'frame' : 'frames'}`;
}

const MAX_PIECES = 1024;

// The version 4 plan for this readout, or null when fountain coding is off or
// the file is too large for it (it then goes out as version 3).
function fountainPlan(r, settings, streamLength) {
  if (!settings.fountain || r.tooSmall) return null;
  const layoutV4 = computeLayoutV4(r.cols, r.rows);
  const plan = planV4(streamLength, layoutV4, settings);
  return plan && { ...plan, layoutV4, bytesPerPacket: plan.packetBytes };
}

// The piece size and the size limit (KB) fountain coding has at these settings,
// or a problem text when the screen holds no whole packet. Never throws.
function fountainLimit(r, settings) {
  if (!settings.fountain || r.tooSmall) return null;
  const shape = frameShapeV4(computeLayoutV4(r.cols, r.rows), settingsScheme(settings), settings.parity);
  if (shape.packets < 1 || !(shape.packetBytes > 0)) return { problem: 'too small for fountain coding' };
  return { packetBytes: shape.packetBytes, limitKB: Math.floor(MAX_PIECES * shape.packetBytes / 1000) };
}

// Returns the message for a readout that cannot be sent, or null when it can.
function readoutProblem(r) {
  if (r.tooSmall) return `Block size is over the cap of ${r.cap} px for this size`;
  if (r.tooLarge) return 'Too large for these settings';
  return null;
}

function drawImage(ctx, img, x, y) {
  ctx.putImageData(new ImageData(img.data, img.width, img.height), x, y);
}

// ---- Tabs ----

function showTab() {
  const name = location.hash === '#receive' ? 'receive' : 'send';
  for (const section of document.querySelectorAll('section.tab')) section.hidden = section.id !== name;
  // The phone run view: the camera and its status panel fill the screen, the tabs and theme chips go below.
  document.body.classList.toggle('rx-active', name === 'receive');
  for (const link of document.querySelectorAll('.tabs a')) {
    if (link.dataset.tab === name) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

// ---- Payload ----

async function buildRecord() {
  const text = $('message').value;
  if (text.length > 0) {
    return { type: 'message', name: '', mime: 'text/plain', data: new TextEncoder().encode(text) };
  }
  const file = $('file').files[0];
  if (file) {
    return {
      type: 'file',
      name: file.name,
      mime: file.type || 'application/octet-stream',
      data: new Uint8Array(await file.arrayBuffer()),
    };
  }
  return null;
}

async function refreshPayload() {
  const generation = ++payloadGeneration;
  $('start').disabled = true;
  $('save').disabled = true;
  let next = null;
  let error = '';
  try {
    const record = await buildRecord();
    if (record) next = await encodePayload(record, $('password').value || undefined);
  } catch (err) {
    error = err.code === 'EMPTY_PAYLOAD' ? '' : (err.message || String(err));
  }
  if (generation !== payloadGeneration) return; // a newer change replaced this one
  stream = next;
  streamError = error;
  refreshPreview();
  refreshFileReadout();
}

// ---- Screen settings, readout and preview ----

function readScreenControls() {
  return {
    blockSize: Number($('block-size').value),
    levels: Number($('levels').value),
    scheme: $('scheme').value,
    parity: Number($('parity').value),
    fps: Number($('fps').value),
    white: Number($('white').value),
    fountain: $('fountain').checked,
  };
}

function writeScreenLabels() {
  $('block-size-value').textContent = $('block-size').value;
  $('parity-value').textContent = $('parity').value;
  $('fps-value').textContent = $('fps').value;
  $('white-value').textContent = $('white').value;
  // A camera cannot tell 256 levels apart; the note says so while it is selected.
  $('levels-note').hidden = $('levels').value !== '256' || $('scheme').value !== 'cube';
  // The levels select applies to the color cube only.
  $('levels').disabled = $('scheme').value !== 'cube';
}

function clearPreview() {
  const canvas = $('preview');
  canvas.width = 1;
  canvas.height = 1;
}

function refreshPreview() {
  const readoutEl = $('readout');
  $('start').disabled = true;
  if (!stream) {
    setStatus(readoutEl, streamError ? 'fail' : null, streamError || 'Nothing to send');
    clearPreview();
    return;
  }
  const r = computeReadout({ ...displayPixels(), ...screenSettings }, stream.length);
  const fountain = fountainPlan(r, screenSettings, stream.length);
  const problem = fountain ? null : readoutProblem(r);
  if (problem) {
    setStatus(readoutEl, 'fail', problem);
    clearPreview();
    return;
  }
  if (fountain) {
    setStatus(readoutEl, 'ok', `${formatNumber(fountain.packets)} ${fountain.packets === 1 ? 'packet' : 'packets'} of ${formatNumber(fountain.bytesPerPacket)} bytes a frame, `
      + `${formatNumber(fountain.sourceFrames)} source ${fountain.sourceFrames === 1 ? 'frame' : 'frames'}, fountain coded, `
      + `limit ${formatNumber(Math.floor(MAX_PIECES * fountain.packetBytes / 1000))} KB`);
  } else {
    const lim = fountainLimit(r, screenSettings);
    const large = !lim ? ''
      : lim.problem ? ` (${lim.problem}: version 3)`
        : ` (over the fountain limit of ${formatNumber(lim.limitKB)} KB: version 3)`;
    setStatus(readoutEl, 'ok', `${formatNumber(r.bytesPerFrame)} bytes per frame, ${framesText(r.frameCount)}, `
      + `${Math.round(r.loopSeconds * 10) / 10} s per loop${large}`);
  }
  // Build only frame 0; the full transmission is encoded when Start or Save frames is clicked.
  const layout = computeLayout(r.cols, r.rows);
  const { levels, blockSize, parity, white } = screenSettings;
  const scheme = settingsScheme(screenSettings);
  const frameBytes = buildFrame({
    payload: stream.subarray(0, r.bytesPerFrame),
    index: 0,
    count: r.frameCount,
    txId: peekManifest(stream).txId,
    blockSize,
    scheme,
    parity,
  }, frameGrossBytes(layout.dataBlockCount, scheme));
  const img = renderFrame({ frameBytes, index: 0, scheme, blockSize, layout, white });
  const canvas = $('preview');
  canvas.width = img.width;
  canvas.height = img.height;
  drawImage(canvas.getContext('2d'), img, 0, 0);
  $('start').disabled = false;
}

// Sets screen sliders from code (auto tune's result) as if the user moved them.
function applyScreenSettings(patch) {
  if (patch.blockSize !== undefined) $('block-size').value = String(patch.blockSize);
  if (patch.white !== undefined) $('white').value = String(patch.white);
  if (patch.levels !== undefined) $('levels').value = String(patch.levels);
  if (patch.scheme !== undefined) $('scheme').value = patch.scheme;
  onScreenControlChange();
}

function onScreenControlChange() {
  screenSettings = readScreenControls();
  writeScreenLabels();
  saveSettings('screen', screenSettings);
  schedulePreview();
  scheduleSenderDebug('settings');
}

// Coalesce slider input events into at most one preview refresh per animation frame.
let previewPending = false;
function schedulePreview() {
  if (previewPending) return;
  previewPending = true;
  requestAnimationFrame(() => {
    previewPending = false;
    refreshPreview();
  });
}

function setupScreenControls() {
  const { cap } = computeReadout({ ...displayPixels(), ...screenSettings }, 0);
  const sliderMax = Math.max(4, cap);
  $('block-size').max = String(sliderMax);
  $('block-size-cap').textContent = String(cap);
  $('block-size').value = String(Math.min(Math.max(screenSettings.blockSize, 4), sliderMax));
  $('levels').value = String(screenSettings.levels);
  $('scheme').replaceChildren(...SCHEME_CHOICES.map(({ id, label }) => new Option(label, id)));
  $('scheme').value = screenSettings.scheme;
  $('parity').value = String(screenSettings.parity);
  $('fps').value = String(screenSettings.fps);
  $('white').value = String(screenSettings.white);
  $('fountain').checked = screenSettings.fountain;
  screenSettings = readScreenControls();
  writeScreenLabels();
  for (const id of ['block-size', 'scheme', 'levels', 'parity', 'fps', 'white', 'fountain']) {
    $(id).addEventListener('input', onScreenControlChange);
  }
}

// ---- Full screen transmission ----

let starting = false;

async function startTransmission() {
  if (!stream || starting || isStageOpen()) return;
  starting = true;
  $('start').blur(); // so Space or Enter during the loop cannot click Start again
  try {
    await runTransmission();
  } finally {
    starting = false;
  }
}

async function runTransmission() {
  const pixels = displayPixels();
  const settings = { ...screenSettings };
  const r = computeReadout({ ...pixels, ...settings }, stream.length);
  const fountain = fountainPlan(r, settings, stream.length);
  const problem = fountain ? null : readoutProblem(r);
  if (problem) {
    setStatus($('readout'), 'fail', problem);
    return;
  }
  const layout = fountain ? fountain.layoutV4 : computeLayout(r.cols, r.rows);
  const tx = fountain ? encodeTransmissionV4(stream, layout, settings) : encodeTransmission(stream, layout, settings);
  const ctx = await openStage(pixels);
  if (!ctx) {
    if (stageRefused()) setStatus($('readout'), 'fail', 'The browser refused full screen');
    return;
  }
  showLoop(ctx, { tx, layout, settings });
  sendSenderDebug('start', { settings, cols: layout.cols, rows: layout.rows, frames: tx.count ?? tx.sourceFrames, txId: tx.txId,
    version: fountain ? 4 : 3, K: tx.K, packetsPerFrame: tx.packetsPerFrame, ...pixels });
}

// ---- Save frames as PNG ----

function readFileControls() {
  return {
    width: Math.floor(Number($('file-width').value)),
    height: Math.floor(Number($('file-height').value)),
    blockSize: Number($('file-block-size').value),
    levels: Number($('file-levels').value),
    parity: Number($('file-parity').value),
  };
}

function writeFileLabels() {
  $('file-block-size-value').textContent = $('file-block-size').value;
  $('file-parity-value').textContent = $('file-parity').value;
}

function fileReadout() {
  const { width, height, ...settings } = fileSettings;
  if (!(width > 0 && height > 0)) return null;
  return computeReadout({ widthPx: width, heightPx: height, ...settings, fps: 1 }, stream.length);
}

function refreshFileReadout() {
  const el = $('file-readout');
  $('save').disabled = true;
  if (!stream) {
    el.textContent = streamError || 'Nothing to send';
    return;
  }
  const r = fileReadout();
  if (!r) {
    el.textContent = 'Enter a width and height';
    return;
  }
  const problem = readoutProblem(r);
  if (problem) {
    el.textContent = problem;
    return;
  }
  el.textContent = `${formatNumber(r.bytesPerFrame)} bytes per frame, ${framesText(r.frameCount)}`;
  $('save').disabled = false;
}

function onFileControlChange() {
  fileSettings = readFileControls();
  writeFileLabels();
  saveSettings('file', fileSettings);
  refreshFileReadout();
}

function setupFileControls() {
  $('file-width').value = String(fileSettings.width);
  $('file-height').value = String(fileSettings.height);
  $('file-block-size').value = String(fileSettings.blockSize);
  $('file-levels').value = String(fileSettings.levels);
  $('file-parity').value = String(fileSettings.parity);
  writeFileLabels();
  for (const id of ['file-width', 'file-height', 'file-block-size', 'file-levels', 'file-parity']) {
    $(id).addEventListener('input', onFileControlChange);
  }
}

function canvasToPng(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('PNG export failed'))), 'image/png');
  });
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function saveFrames() {
  if (!stream) return;
  const r = fileReadout();
  if (!r || readoutProblem(r)) return;
  const { width, height, ...settings } = fileSettings;
  const { cols, rows } = fitGrid(width, height, settings.blockSize);
  const layout = computeLayout(cols, rows);
  const tx = encodeTransmission(stream, layout, settings);
  const canvas = document.createElement('canvas');
  canvas.width = cols * settings.blockSize;
  canvas.height = rows * settings.blockSize;
  const ctx = canvas.getContext('2d');
  const button = $('save');
  button.disabled = true;
  try {
    for (let index = 0; index < tx.count; index++) {
      button.textContent = `Saving frame ${index + 1} of ${tx.count}`;
      const { levels, blockSize } = settings;
      drawImage(ctx, renderFrame({ frameBytes: tx.frames[index], index, levels, blockSize, layout }), 0, 0);
      const blob = await canvasToPng(canvas);
      downloadBlob(blob, `frame-${String(index + 1).padStart(3, '0')}.png`);
    }
  } catch (err) {
    $('file-readout').textContent = err.message || String(err);
  } finally {
    button.textContent = 'Save frames';
    button.disabled = false;
  }
}

// ---- Debug log ----

// When the project server runs with --capture, the sender posts its settings
// when they change and when a transmission starts or stops, so the debug log
// can line them up with what the phone saw.
let senderDebugOn = false;
let senderDebugTimer = null;

async function setupSenderDebug() {
  try {
    const res = await fetch('/capture', { cache: 'no-store' });
    senderDebugOn = res.ok && (await res.json()).enabled === true;
  } catch {
    senderDebugOn = false; // no project server, or capture is off
  }
  if (senderDebugOn) sendSenderDebug('page', { settings: screenSettings, ...displayPixels() });
}

function sendSenderDebug(event, detail) {
  if (!senderDebugOn) return;
  const body = JSON.stringify({ source: 'sender', event, ...detail });
  fetch('/debug', { method: 'POST', body, headers: { 'Content-Type': 'application/json' } }).catch(() => {});
}

// Slider drags fire many input events; post once things settle.
function scheduleSenderDebug(event) {
  if (!senderDebugOn) return;
  clearTimeout(senderDebugTimer);
  senderDebugTimer = setTimeout(() => sendSenderDebug(event, { settings: screenSettings, ...displayPixels() }), 400);
}

// ---- QR code ----

// A phone cannot reach this computer as localhost, so a code built from a
// loopback address is useless. The page cannot learn the computer's network
// address by itself, so it asks the user to open it by that address.
function isLoopbackHost(hostname) {
  return hostname === 'localhost' || hostname === '[::1]' || hostname.startsWith('127.');
}

function setupQr() {
  if (isLoopbackHost(location.hostname)) {
    const port = location.port ? ':' + location.port : '';
    $('qr-url').textContent =
      'This page is open as ' + location.hostname + ', which a phone cannot reach. ' +
      'Open it by this computer\'s network address instead, for example https://192.168.12.1' +
      port + location.pathname + '#send on the Visual Modem hotspot. The code then appears here.';
    return;
  }
  const url = location.origin + location.pathname + '#receive';
  $('qr-url').textContent = url;
  const script = document.createElement('script');
  script.src = QR_SCRIPT;
  script.onload = () => {
    if (typeof window.qrcode !== 'function') return;
    const qr = window.qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    $('qr-code').innerHTML = qr.createImgTag(6, 12, 'QR code for the receiver page');
  };
  document.head.appendChild(script);
}

// ---- Wiring ----

function setupThemeChips() {
  const box = $('theme-chips');
  if (!box) return;
  let store = null;
  try { store = localStorage; } catch { /* storage blocked */ }
  const root = document.documentElement;
  let choice = loadTheme(store);
  const dark = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
  if (choice) root.dataset.theme = choice; else delete root.dataset.theme;
  const chips = THEMES.map((t) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.dataset.themeId = t.id;
    b.title = t.name;
    b.setAttribute('aria-label', `${t.name} theme`);
    t.swatch.forEach((c, i) => b.style.setProperty(`--c${i + 1}`, c));
    b.addEventListener('click', () => { choice = t.id; root.dataset.theme = t.id; saveTheme(store, t.id); mark(); });
    box.appendChild(b);
    return b;
  });
  function mark() {
    for (const b of chips) b.setAttribute('aria-pressed', String(b.dataset.themeId === shownTheme(choice, !!dark?.matches)));
  }
  mark();
  if (dark?.addEventListener) dark.addEventListener('change', mark);
}

function main() {
  setupThemeChips();
  showTab();
  window.addEventListener('hashchange', showTab);

  screenSettings = loadSettings('screen');
  fileSettings = loadSettings('file');
  setupScreenControls();
  setupFileControls();
  setupSenderDebug();
  setupTune({ getSettings: () => ({ ...screenSettings }), setSettings: applyScreenSettings, displayPixels }).then(setupRunner);
  setupProbe({ getSettings: () => ({ ...screenSettings }), displayPixels });

  let inputTimer = null;
  const debouncedRefresh = () => {
    clearTimeout(inputTimer);
    inputTimer = setTimeout(refreshPayload, INPUT_DEBOUNCE_MS);
  };
  $('message').addEventListener('input', debouncedRefresh);
  $('password').addEventListener('input', debouncedRefresh);
  $('file').addEventListener('change', () => {
    if ($('file').files[0]) $('message').value = '';
    refreshPayload();
  });

  $('start').addEventListener('click', startTransmission);
  $('save').addEventListener('click', saveFrames);
  onStageClosed(() => sendSenderDebug('stop', {}));

  setupQr();
  refreshPayload();
}

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', main);
