// Module worker for the receiver: reads camera frames and image files, collects
// frames into a payload stream and reports progress to the main thread.

import { decodeCameraFrame, readBytes } from '../src/picture/reader.js';
import { readImageFrame } from '../src/picture/filereader.js';
import { Collector } from '../src/core/transmission.js';
import { peekHeader, FRAME_TYPES } from '../src/core/frame.js';
import { computeLayout } from '../src/picture/layout.js';
import { estimateColumns } from '../src/tune/attempts.js';
import { analyzeCharacterization } from '../src/optimize/characterize.js';
import { truthFrame, measureErrors } from '../src/optimize/linkerrors.js';
import { attemptRecord } from '../src/optimize/attemptlog.js';
import { routeRead, attemptHeader, packetMaskOf } from '../src/optimize/readroute.js';

const collector = new Collector();
let lastTxId = null; // transmission id already delivered as 'complete'

function stripRead(read) {
  if (!read) return null;
  const { blocks, thresholds, headerThresholds, frameHeader, ...rest } = read;
  return rest;
}

// measure is set when the receiver posts debug reports (--capture); only then
// are probe reads measured against the known payload, which costs decode time.
function handleCamera({ data, width, height, grabMs, measure = false }) {
  // decodeCameraFrame never throws on image content. The parity strip is one bit,
  // so it cannot tell frames apart; every frame with markers is parsed.
  const decodeStart = performance.now();
  const { read, frame, sample } = decodeCameraFrame({ data: new Uint8ClampedArray(data), width, height });
  const decodeMs = performance.now() - decodeStart;
  // Probe and characterization frames measure the light path; only data
  // frames (and version 2 frames, which have no type) go to the collector.
  const h = read.frameHeader ?? null;
  routeRead(collector, { read, frame });
  const attempt = {
    header: attemptHeader(h, frame),
    ok: Boolean(frame),
    estCols: read.markersFound ? estimateColumns(read) : null,
    cols: read.cols ?? null,
    rows: read.rows ?? null,
    gridCorners: read.gridCorners ?? null,
    imageW: width,
    imageH: height,
  };
  let profile;
  if (frame && frame.header.frameType === FRAME_TYPES.characterization) {
    profile = { ...analyzeCharacterization(sample, computeLayout(read.cols, read.rows), read.pitch), blockSize: frame.header.blockSize };
  }
  const debug = diagnose(read, frame, width, height);
  const record = measure ? probeRecord({ grabMs, decodeMs, read, frame, debug, header: h }) : null;
  return { read, debug, attempt, profile, record };
}

// The per attempt record of a version 3 probe read, with its errors measured
// against the known payload. Null for any other read.
function probeRecord({ grabMs, decodeMs, read, frame, debug, header }) {
  if (!header || header.frameType !== FRAME_TYPES.probe) return null;
  let errors = null;
  try {
    errors = measureErrors(read, truthFrame(header, readBytes(read).length));
  } catch {
    errors = null; // a read that cannot be measured is still recorded
  }
  return attemptRecord({ atMs: Date.now(), grabMs, decodeMs, read, frame, debug, errors, packetMask: header.version === 4 ? packetMaskOf(frame) : null });
}

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');

// Which stage a camera frame got to, for the debug log. Sent only to a project
// server running with --capture.
function diagnose(read, frame, width, height) {
  const debug = { width, height };
  if (frame) return { ...debug, stage: 'ok', header: frame.header, corrected: frame.corrected };
  if (!read.blocks) return { ...debug, stage: read.reason || 'no read' };
  debug.thresholds = read.thresholds;
  try {
    const bytes = readBytes(read);
    const header = peekHeader(bytes);
    debug.grossBytes = bytes.length;
    debug.firstBytes = hex(bytes.subarray(0, 24)); // a good header starts da 7a 03 (02 for version 2)
    debug.scheme = read.schemeName ?? null;
    debug.frameType = read.frameType ?? null;
    debug.probeId = read.probeId ?? null;
    debug.stage = header ? 'payload failed' : 'header unreadable';
    if (header) debug.header = header;
  } catch (err) {
    debug.stage = `diagnose error: ${err.message}`;
  }
  return debug;
}

// Tries the pixel exact file reader first. A photo of the screen or a frame a
// messaging app resized is not pixel exact, so it falls back to the camera path.
// read.path says which reader produced the frame: 'file' or 'camera'.
function handleImage({ data, width, height }) {
  const img = { data: new Uint8ClampedArray(data), width, height };
  const result = readImageFrame(img);
  if (result) {
    collector.add(result.frame);
    const { blockSize, levels, scheme, layout } = result;
    return {
      read: { markersFound: true, path: 'file', blockSize, levels, scheme, cols: layout.cols, rows: layout.rows },
    };
  }
  const { read, frame } = decodeCameraFrame(img);
  if (frame) {
    collector.add(frame);
    return { read: { ...read, path: 'camera' } };
  }
  collector.noteFailure();
  return {
    read: { ...read, path: 'camera' },
    lastError: read.markersFound ? `No frame read in this image (${read.reason || 'frame did not parse'})` : 'No frame found in this image',
  };
}

function handleReset() {
  collector.reset();
  lastTxId = null;
  return { read: null };
}

const handlers = { camera: handleCamera, image: handleImage, reset: handleReset };

function reply({ read, lastError, debug, attempt, profile, record }) {
  const status = collector.status();
  self.postMessage({ type: 'status', read: stripRead(read), collector: status, lastError, debug, attempt, profile, record });
  if (status.complete && status.txId !== lastTxId) {
    const stream = collector.stream();
    if (stream) {
      lastTxId = status.txId;
      self.postMessage({ type: 'complete', stream: stream.buffer }, [stream.buffer]);
    }
  }
}

self.onmessage = (event) => {
  const msg = event.data;
  const handler = handlers[msg && msg.type];
  let result;
  try {
    if (!handler) throw new Error(`Unknown message type: ${msg && msg.type}`);
    result = handler(msg);
  } catch (err) {
    result = { read: null, lastError: String(err.message ?? err) };
  }
  reply(result);
};
