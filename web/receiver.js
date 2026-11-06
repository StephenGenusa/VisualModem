import { peekManifest, decodePayload } from '../src/core/payload.js';
import { openCamera, createCameraStarter, grabFrame } from './camera.js';
import { classifyAttempt } from '../src/tune/attempts.js';
import { nextAttemptDelay, JITTER_MS } from '../src/tune/pacing.js';
import { setupSetupCheck } from './setupcheck.js';
import { createAttemptLog } from '../src/optimize/attemptlog.js';
import { cameraRequest, CAMERA_CHOICES } from '../src/tune/camerachoice.js';
import { createRunStatus, formatClock, cameraAspect, gridText } from './rxstatus.js';
import { setStatus } from './status.js';

const JPEG_WARNING = 'JPEG files usually fail; PNG is required';
const ENCRYPTED_PROMPT = 'This transmission is encrypted. Enter the password.';
const WORKER_FAILED = 'Decoder failed to start';
const DECODE_ERROR_MS = 4000; // how long a failed decode's message stays before the next try
const FPS_SPAN_MS = 3000; // the camera read rate in the panel is counted over this long

const $ = (id) => document.getElementById(id);

let worker = null;
let setupCheck = null; // the Setup check panel, fed by every camera attempt
const pendingReplies = []; // resolvers for posted messages; the worker replies in order
let workerDead = false;
let lastCollector = { txId: null, count: 0, have: 0, complete: false, crcPass: 0, crcFail: 0 };
let ignoreComplete = false; // drops a 'complete' from the old collection until the reset reply arrives

let cameraStream = null;
const cameraStarter = createCameraStarter({
  open: (isCurrent) => openCamera($('rx-video'), cameraResolution, isCurrent),
  onStarting() {
    showCameraError(null);
    cameraState = 'starting';
  },
  onStream(stream) {
    cameraStream = stream;
    cameraState = 'running';
    fitCameraBox();
    renderRun();
    scheduleAttempt();
  },
  onError(err) {
    showCameraError(`Camera unavailable: ${err.message || err}. Open files still works.`);
    cameraState = 'error';
  },
});
let attemptTimer = null;
let frameCallback = null; // pending requestVideoFrameCallback handle
let busy = false; // a camera frame is posted and its status has not come back
const attemptLog = createAttemptLog(); // per probe attempt records, drained into each debug post
let attemptMs = []; // how long each camera attempt took, grab to status, for the debug log
let cameraResolution = '1080p'; // what the camera was asked for: picked on the phone, or asked for by the test runner
let cameraSeqSeen = null; // the test runner's last camera request already followed
let cameraState = 'off'; // 'starting', 'running', 'off' or 'error', reported to the laptop
let grabCanvas = null;

let receivedStream = null; // the completed payload stream, kept until reset or the next one
let decodeGeneration = 0;
let resultUrl = null; // object URL for the received file, revoked when the result is replaced

let runStatus = createRunStatus(); // the run panel's model; a new one on each reset of the collector
let cameraError = null; // plain words for a camera that would not start, shown as the state word
let decodeError = null; // a completed stream that did not decode, shown as the state word for a while
let readTimes = []; // when recent camera attempts came back, for the panel's read rate
let runHasCollector = false; // the run status has seen a transmission in the collector

function formatNumber(n) {
  return n.toLocaleString('en-US');
}

function isReceiveTab() {
  return location.hash === '#receive';
}

// ---- Worker ----

function localStatus(lastError) {
  return { type: 'status', read: null, collector: lastCollector, lastError };
}

// Resolves with the worker's status reply to this message, or with a local error status
// when the worker is dead or the post fails.
function postToWorker(message, transfer = []) {
  if (workerDead) return Promise.resolve(localStatus(WORKER_FAILED));
  return new Promise((resolve) => {
    try {
      worker.postMessage(message, transfer);
    } catch (err) {
      resolve(localStatus(String(err.message ?? err)));
      return;
    }
    pendingReplies.push(resolve);
  });
}

function onWorkerError(event) {
  workerDead = true;
  if (event && typeof event.preventDefault === 'function') event.preventDefault();
  const status = localStatus(WORKER_FAILED);
  showStatus(status);
  while (pendingReplies.length > 0) pendingReplies.shift()(status);
}

function onWorkerMessage(event) {
  const msg = event.data;
  if (msg.type === 'status') {
    lastCollector = msg.collector;
    noteDebug(msg);
    // Tell the laptop at once when a transmission completes, so the test
    // runner's throughput timing is not delayed by the one second post interval.
    if (debugOn && msg.collector.complete && msg.collector.txId !== lastReportedComplete) {
      lastReportedComplete = msg.collector.txId;
      sendDebug();
    }
    // A UI error must never keep the reply from resolving, or the camera loop stalls.
    try {
      setupCheck?.onStatus(msg); // first, so the panel drawn next has its recommendation
      showStatus(msg);
    } catch (err) {
      console.error(err);
    } finally {
      const resolve = pendingReplies.shift();
      if (resolve) resolve(msg);
    }
  } else if (msg.type === 'complete' && !ignoreComplete) {
    onComplete(new Uint8Array(msg.stream));
  }
}

// ---- Stats and overlay ----

// Feeds one worker status into the run status, then redraws the panel.
function showStatus({ read, collector, lastError, debug, attempt }) {
  const atMs = performance.now();
  // An empty collector (no transmission yet) is not a run in progress. One
  // that empties after the run status saw it was reset in the worker, so the
  // run status starts over too; a reply from before a reset cannot leave it stale.
  const empty = collector.txId === null || collector.txId === undefined || !(collector.count > 0);
  if (empty && runHasCollector) resetRunStatus();
  if (debug) {
    runStatus.noteAttempt({ atMs, stage: debug.stage, ...(attempt ?? {}) });
    readTimes.push(atMs);
  }
  if (!empty) {
    runStatus.noteCollector({ atMs, ...collector });
    runHasCollector = true;
  }
  runStatus.noteError(cameraError || decodeError || lastError || null);
  const grid = gridText(read);
  $('rx-grid').textContent = grid ? `${grid} · ` : '';
  $('rx-margin').textContent = read && typeof read.margin === 'number'
    ? ` · Margin ${Math.round(read.margin * 100)}%`
    : '';
  const { have, count, crcPass, crcFail, unit } = collector;
  const progress = $('rx-progress');
  progress.max = Math.max(count, 1);
  progress.value = have;
  progress.classList.toggle('done', Boolean(collector.complete));
  progressCount(`${formatNumber(have)} / ${formatNumber(count)} ${unit ?? 'frames'}`);
  $('rx-counts').textContent = `CRC pass ${formatNumber(crcPass)}, fail ${formatNumber(crcFail)}`;
  renderRun();
  drawOverlay(read);
}

// The count is the text before the #rx-time span inside #rx-progress-text.
function progressCount(text) {
  const el = $('rx-progress-text');
  if (el.firstChild && el.firstChild.nodeType === 3) el.firstChild.nodeValue = text;
  else el.insertBefore(document.createTextNode(text), el.firstChild);
}

// Draws the run status model into the panel: the state word with its shape,
// the times, the share of recent reads that worked, the main miss and the aim hint.
function renderRun() {
  const nowMs = performance.now();
  const s = runStatus.state(nowMs);
  setStatus($('rx-read'), s.kind, s.word);
  $('rx-time').textContent = `${formatClock(s.elapsedMs ?? 0)} elapsed · ${formatClock(s.leftMs)} left`;
  $('rx-rate').textContent = s.reads.of
    ? `Reads ${s.reads.ok} of last ${s.reads.of} (${Math.round((s.reads.ok / s.reads.of) * 100)}%)`
    : 'No camera reads yet';
  $('rx-reason').textContent = s.miss ? `Main miss: ${s.miss}` : '';
  $('rx-hint').textContent = s.hint ?? '';
  readTimes = readTimes.filter((t) => nowMs - t <= FPS_SPAN_MS);
  const fps = readTimes.length / (FPS_SPAN_MS / 1000);
  $('rx-fps').textContent = `${fps.toFixed(fps >= 10 ? 0 : 1)} fps read`;
  const video = $('rx-video');
  $('rx-cam-dims').textContent = cameraStream && video.videoWidth
    ? `Camera ${video.videoWidth}x${video.videoHeight}`
    : 'Camera off';
}

// The collector starts over (Reset, or a stream that did not decode), so the run status does too.
function resetRunStatus() {
  runStatus = createRunStatus();
  runHasCollector = false;
  readTimes = [];
  setupCheck?.attachRunStatus(runStatus);
}

function clearStats() {
  resetRunStatus();
  $('rx-margin').textContent = '';
  $('rx-grid').textContent = '';
  $('rx-progress').max = 1;
  $('rx-progress').value = 0;
  $('rx-progress').classList.remove('done');
  progressCount('0 / 0 frames');
  $('rx-counts').textContent = 'CRC pass 0, fail 0';
  decodeError = null;
  runStatus.noteError(cameraError);
  renderRun();
  drawOverlay(null);
}

// The camera box takes the stream's shape, so the overlay stays aligned with the picture.
function fitCameraBox() {
  const video = $('rx-video');
  video.parentElement.style.setProperty('--cam-ar', String(cameraAspect(video.videoWidth, video.videoHeight)));
}

function showCameraError(text) {
  cameraError = text;
  runStatus.noteError(cameraError || decodeError);
  renderRun();
}

// The corners that were found, in draw order tl, tr, br, bl. The small br
// marker is often missing, so null corners are skipped.
export function overlayPoints(corners) {
  if (!corners) return [];
  const { tl, tr, br, bl } = corners;
  return [tl, tr, br, bl].filter(Boolean);
}

// Draws the found corners as circles joined by lines, scaled from video pixels to the shown size.
function drawOverlay(read) {
  const video = $('rx-video');
  const overlay = $('rx-overlay');
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(video.clientWidth * dpr);
  const h = Math.round(video.clientHeight * dpr);
  if (overlay.width !== w || overlay.height !== h) {
    overlay.width = w;
    overlay.height = h;
  }
  const ctx = overlay.getContext('2d');
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  if (!read || !read.corners || !video.videoWidth || !video.videoHeight) return;
  const sx = overlay.width / video.videoWidth;
  const sy = overlay.height / video.videoHeight;
  const points = overlayPoints(read.corners).map(([x, y]) => [x * sx, y * sy]);
  ctx.lineWidth = 3 * dpr;
  ctx.strokeStyle = '#00e060';
  ctx.fillStyle = '#00e060';
  ctx.beginPath();
  points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.closePath();
  ctx.stroke();
  for (const [x, y] of points) {
    ctx.beginPath();
    ctx.arc(x, y, 8 * dpr, 0, 2 * Math.PI);
    ctx.fill();
  }
}

// ---- Camera ----

function startCamera() {
  if (cameraStream) return;
  if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showCameraError('The camera needs an HTTPS page. Open files still works.');
    return;
  }
  cameraStarter.start();
}

function stopCamera() {
  cameraStarter.stop(); // cancels a camera that is still opening
  if (attemptTimer !== null) clearTimeout(attemptTimer);
  attemptTimer = null;
  if (frameCallback !== null) $('rx-video').cancelVideoFrameCallback(frameCallback);
  frameCallback = null;
  if (cameraStream) {
    for (const track of cameraStream.getTracks()) track.stop();
  }
  cameraStream = null;
  cameraState = 'off';
  const video = $('rx-video');
  video.pause();
  video.srcObject = null;
  drawOverlay(null);
  renderRun();
}

// The next attempt starts when the worker replies (or at once when the last
// one could not run), so the decoder is never idle. It waits for a new video
// frame where the browser reports them, else at least MIN_GAP_MS since the
// grab, plus jitter so the phone's sampling cannot lock onto the sender's
// frame changes. A reply or timer from before stopCamera has an old
// generation and does nothing, so only one chain of attempts ever runs.
function scheduleAttempt(grabbedAt = performance.now()) {
  const generation = cameraStarter.generation;
  const run = () => {
    attemptTimer = null;
    if (generation === cameraStarter.generation && cameraStream) attempt(generation);
  };
  const video = $('rx-video');
  if (typeof video.requestVideoFrameCallback === 'function') {
    frameCallback = video.requestVideoFrameCallback(() => {
      frameCallback = null;
      if (generation !== cameraStarter.generation) return;
      attemptTimer = setTimeout(run, JITTER_MS * Math.random());
    });
  } else {
    attemptTimer = setTimeout(run, nextAttemptDelay({ sinceGrabMs: performance.now() - grabbedAt }));
  }
}

function attempt(generation) {
  const video = $('rx-video');
  if (busy || workerDead || !cameraStream || video.readyState < 2 || !video.videoWidth) {
    scheduleAttempt();
    return;
  }
  if (!grabCanvas) grabCanvas = document.createElement('canvas');
  const started = performance.now();
  const img = grabFrame(video, grabCanvas);
  busy = true;
  const buffer = img.data.buffer;
  // measure: per attempt error records are kept only for the debug report.
  postToWorker({ type: 'camera', data: buffer, width: img.width, height: img.height, grabMs: started, measure: debugOn }, [buffer])
    .then(() => {
      busy = false;
      if (attemptMs.length < 200) attemptMs.push(performance.now() - started);
      if (generation === cameraStarter.generation && cameraStream) scheduleAttempt(started);
    });
}

function syncCamera() {
  if (isReceiveTab() && document.visibilityState === 'visible') startCamera();
  else stopCamera();
}

// ---- Result ----

function clearResult() {
  decodeGeneration++; // drops a decode that is still running
  receivedStream = null;
  if (resultUrl) URL.revokeObjectURL(resultUrl);
  resultUrl = null;
  $('rx-password-form').hidden = true;
  $('rx-password').value = '';
  $('rx-decode-message').textContent = '';
  $('rx-result').replaceChildren();
}

function onComplete(stream) {
  clearResult();
  receivedStream = stream;
  const manifest = peekManifest(stream);
  if (manifest && manifest.encrypted) showPasswordForm(ENCRYPTED_PROMPT);
  else decodeReceived();
}

// The completed stream did not decode, for example because chunks from two
// sender settings mixed. Shows the error for a while and starts collecting
// again, so a watching phone never stays stuck on a bad stream.
function restartCollection(text) {
  receivedStream = null;
  const message = $('rx-decode-message');
  message.textContent = text;
  // The collection starts over, and so does the run status; the error shows as its state word for a while.
  resetRunStatus();
  decodeError = text;
  runStatus.noteError(cameraError || decodeError);
  renderRun();
  setTimeout(() => {
    if (message.textContent === text) message.textContent = '';
    if (decodeError !== text) return;
    decodeError = null;
    runStatus.noteError(cameraError);
    renderRun();
  }, DECODE_ERROR_MS);
  ignoreComplete = true;
  // Replies come in order, so a 'complete' before this reply belongs to the old collection.
  postToWorker({ type: 'reset' }).then(() => { ignoreComplete = false; });
}

function showPasswordForm(text) {
  $('rx-password-form').hidden = false;
  $('rx-decode-message').textContent = text;
}

async function decodeReceived(password) {
  if (!receivedStream) return;
  const generation = ++decodeGeneration;
  let record;
  try {
    record = await decodePayload(receivedStream, password || undefined);
  } catch (err) {
    if (generation !== decodeGeneration) return;
    if (err.code === 'BAD_PASSWORD') showPasswordForm('Wrong password, try again');
    else if (err.code === 'NEEDS_PASSWORD') showPasswordForm(ENCRYPTED_PROMPT);
    else restartCollection(err.message || String(err));
    return;
  }
  if (generation !== decodeGeneration) return;
  $('rx-password-form').hidden = true;
  $('rx-decode-message').textContent = '';
  if (record.type === 'message') showMessage(record);
  else showFile(record);
}

function makeButton(text, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = text;
  button.addEventListener('click', onClick);
  return button;
}

function showMessage(record) {
  const text = new TextDecoder().decode(record.data);
  const heading = document.createElement('h2');
  heading.textContent = 'Message received';
  const pre = document.createElement('pre');
  pre.className = 'rx-text';
  pre.textContent = text;
  const note = document.createElement('p');
  note.className = 'rx-note';
  note.setAttribute('aria-live', 'polite');
  const copy = makeButton('Copy', async () => {
    try {
      await navigator.clipboard.writeText(text);
      note.textContent = 'Copied';
    } catch {
      note.textContent = 'Copy failed; select the text and copy it by hand';
    }
  });
  copy.className = 'primary';
  $('rx-result').replaceChildren(heading, pre, copy, note);
}

function showFile(record) {
  const name = record.name || 'received.bin';
  const mime = record.mime || 'application/octet-stream';
  const heading = document.createElement('h2');
  heading.textContent = 'File received';
  const info = document.createElement('p');
  info.className = 'rx-file';
  info.textContent = `${name}, ${formatNumber(record.data.length)} bytes`;
  const save = makeButton('Save', () => {
    // Revoking right after the click cancels the download in WebKit, so the URL
    // lives until this result is replaced or reset.
    if (!resultUrl) resultUrl = URL.createObjectURL(new Blob([record.data], { type: mime }));
    const a = document.createElement('a');
    a.href = resultUrl;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  });
  save.className = 'primary';
  const children = [heading, info, save];
  const file = new File([record.data], name, { type: mime });
  if (typeof navigator.canShare === 'function' && typeof navigator.share === 'function'
    && navigator.canShare({ files: [file] })) {
    children.push(makeButton('Share', async () => {
      try {
        await navigator.share({ files: [file] });
      } catch {
        // The share sheet was closed or sharing failed; Save still works.
      }
    }));
  }
  $('rx-result').replaceChildren(...children);
}

// ---- Open files ----

function logFile(text) {
  const item = document.createElement('li');
  item.textContent = text;
  $('rx-file-log').appendChild(item);
}

function fileReadText(read) {
  return read && read.path === 'camera' ? 'Read as a photo' : 'frame read';
}

async function imageDataFromFile(file) {
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  } finally {
    bitmap.close();
  }
}

async function openFiles() {
  const input = $('rx-files');
  const files = [...input.files];
  input.value = ''; // so choosing the same files again fires change
  if (files.length === 0) return;
  input.disabled = true;
  $('rx-file-log').replaceChildren();
  try {
    for (const file of files) {
      if (file.type === 'image/jpeg') logFile(`${file.name}: ${JPEG_WARNING}`);
      let img;
      try {
        img = await imageDataFromFile(file);
      } catch {
        logFile(`${file.name}: could not be opened as an image`);
        continue;
      }
      const buffer = img.data.buffer;
      const status = await postToWorker(
        { type: 'image', data: buffer, width: img.width, height: img.height, name: file.name },
        [buffer],
      );
      logFile(`${file.name}: ${status.lastError || fileReadText(status.read)}`);
      if (workerDead) break;
    }
  } finally {
    input.disabled = false;
  }
}

// ---- Reset ----

function reset() {
  clearResult();
  clearStats();
  $('rx-file-log').replaceChildren();
  setupCheck?.reset();
  ignoreComplete = true;
  // Replies come in order, so a 'complete' before this reply belongs to the old collection.
  postToWorker({ type: 'reset' }).then(() => { ignoreComplete = false; });
}

// ---- Debug frame capture ----

// When the project server runs with --capture, the receiver can post the
// current camera frame to it as a lossless PNG, for tools/decode-photo.js.
async function setupCapture() {
  try {
    const res = await fetch('/capture', { cache: 'no-store' });
    if (!res.ok || !(await res.json()).enabled) return;
  } catch {
    return; // no project server, or capture is off
  }
  $('rx-capture-box').hidden = false;
  $('rx-capture').addEventListener('click', sendCameraFrame);
  debugOn = true;
  setInterval(sendDebug, DEBUG_MS);
  // Tell the laptop at once when the page goes to the background, so a run pauses.
  document.addEventListener('visibilitychange', () => sendDebug());
}

// Debug summary: how many camera attempts ended at each stage since the last
// post, plus the latest attempt in full.
const DEBUG_MS = 1000;
let debugOn = false;
let debugStages = {};
let debugLast = null;
let debugTests = {}; // per test id since the last post: { attempts, ok, frame, markers }
let noMarkersStreak = 0;
let currentTest = null; // the test the laptop says is on screen, from the server's reply
let lastReportedComplete = null; // transmission id whose completion was already posted

function noteDebug(msg) {
  if (!debugOn || !msg.debug) return;
  if (msg.record) attemptLog.add(msg.record);
  const stage = msg.debug.stage;
  debugStages[stage] = (debugStages[stage] || 0) + 1;
  noMarkersStreak = msg.read && msg.read.markersFound ? 0 : noMarkersStreak + 1;
  if (currentTest) {
    const counts = debugTests[currentTest.id] ??= { attempts: 0, ok: 0, frame: 0, markers: 0 };
    counts.attempts++;
    const kind = classifyAttempt(msg.debug, msg.read, currentTest);
    if (kind !== 'none') counts[kind]++;
  }
  debugLast = { read: msg.read, debug: msg.debug };
}

function health() {
  const video = $('rx-video');
  return {
    visible: document.visibilityState === 'visible',
    camera: cameraState,
    noMarkersStreak,
    video: { width: video.videoWidth, height: video.videoHeight, resolution: cameraResolution },
  };
}

// The server answers each post with the laptop's instructions: the test on
// screen, and the camera size to use. A new camera request from the test
// runner is followed once; otherwise the size picked on the phone stands.
function followInstructions(state) {
  currentTest = state && state.test ? state.test : null;
  const { camera, seq } = cameraRequest(state, cameraSeqSeen);
  cameraSeqSeen = seq;
  if (camera) setCameraResolution(camera);
}

// Reopens the camera at a new size. Works with no network: the Camera choice
// on the Receive page calls it directly.
function setCameraResolution(resolution) {
  $('rx-camera-size').value = resolution;
  if (resolution === cameraResolution) return;
  cameraResolution = resolution;
  stopCamera();
  syncCamera();
}

function setupCameraChoice() {
  const select = $('rx-camera-size');
  select.replaceChildren(...CAMERA_CHOICES.map(({ id, label }) => new Option(label, id)));
  select.value = cameraResolution;
  select.addEventListener('change', () => setCameraResolution(select.value));
}

function sendDebug() {
  // keepalive bodies share a 64 KB browser quota, so only the post sent as the page hides uses it.
  const keepalive = document.visibilityState === 'hidden';
  // index.html also loads this module behind the Send tab; only a page that is
  // receiving may report, or the laptop's own page reads as a phone with its camera off.
  if (!isReceiveTab()) return;
  // The hidden page post carries the test runner's pause signal and must fit
  // the keepalive quota, so it sends no records, only how many it drained.
  const drained = attemptLog.drain();
  const perAttempt = keepalive ? { attempts: [], dropped: drained.attempts.length + drained.dropped } : drained;
  const body = JSON.stringify({
    source: 'receiver', stages: debugStages, tests: debugTests, health: health(),
    attemptMs: attemptMs.map(Math.round),
    last: debugLast, collector: lastCollector, setup: setupCheck?.summary() ?? null, ua: navigator.userAgent,
    perAttempt,
  });
  debugStages = {};
  debugTests = {};
  attemptMs = [];
  debugLast = null;
  fetch('/debug', { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, keepalive })
    .then(async (res) => {
      $('rx-capture-status').textContent = res.ok ? 'Sending debug data to the computer' : `Debug send failed: ${res.status}`;
      if (res.status === 200) followInstructions(await res.json());
    })
    .catch((err) => { $('rx-capture-status').textContent = `Debug send failed: ${err.message}`; });
}

async function sendCameraFrame() {
  const status = $('rx-capture-status');
  const video = $('rx-video');
  if (!cameraStream || !video.videoWidth) {
    status.textContent = 'The camera is not running';
    return;
  }
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  status.textContent = `Sending ${canvas.width} × ${canvas.height} frame...`;
  try {
    const blob = await new Promise((done) => canvas.toBlob(done, 'image/png'));
    const res = await fetch('/capture', { method: 'POST', body: blob, headers: { 'Content-Type': 'image/png' } });
    if (!res.ok) throw new Error(`server said ${res.status}`);
    const { saved } = await res.json();
    status.textContent = `Saved as ${saved}`;
  } catch (err) {
    status.textContent = `Send failed: ${err.message}`;
  }
}

// ---- Wiring ----

function main() {
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = onWorkerMessage;
  worker.onerror = onWorkerError;
  setupCheck = setupSetupCheck($);
  setupCheck.attachRunStatus(runStatus);
  const video = $('rx-video');
  video.addEventListener('loadedmetadata', fitCameraBox);
  video.addEventListener('resize', fitCameraBox);

  clearStats();
  clearResult();
  setupCameraChoice();
  $('rx-files').addEventListener('change', openFiles);
  $('rx-reset').addEventListener('click', reset);
  $('rx-password-form').addEventListener('submit', (e) => {
    e.preventDefault();
    decodeReceived($('rx-password').value);
  });

  window.addEventListener('hashchange', syncCamera);
  document.addEventListener('visibilitychange', syncCamera);
  window.addEventListener('pagehide', stopCamera);
  window.addEventListener('pageshow', syncCamera);
  syncCamera();
  setupCapture();
}

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', main);
