import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLayoutV4 } from '../src/picture/layout.js';
import { renderFrame } from '../src/picture/render.js';
import { schemeFromLevels } from '../src/core/scheme.js';
import { parseFrameV4 } from '../src/core/framev4.js';
import { FRAME_TYPES } from '../src/core/frame.js';
import { buildProbeFrameV4 } from '../src/optimize/probes.js';
import { probePayload } from '../src/optimize/prbs.js';
import { Collector } from '../src/core/transmission.js';
import { routeRead, attemptHeader } from '../src/optimize/readroute.js';
import { attemptRecord } from '../src/optimize/attemptlog.js';
import { tiltQuad, warpToQuad, blur, brightnessContrast, noise } from '../src/testutil/distort.js';
import { decodeCameraFrame } from '../src/picture/reader.js';

const COLS = 137, ROWS = 77, BLOCK_PX = 13, W = 1920, H = 1080, TX = 0x5eed1234;
const layoutV4 = computeLayoutV4(COLS, ROWS);
const probe = { id: 7, blockSize: BLOCK_PX, scheme: schemeFromLevels(2), parity: 32, fps: 4, static: false };

function make(index) {
  const { frameBytes, shape } = buildProbeFrameV4({ probe, txId: TX, index, layoutV4, probeCount: 50 });
  const screen = renderFrame({ frameBytes, index, scheme: probe.scheme, blockSize: BLOCK_PX, layout: layoutV4, version: 4 });
  return { frameBytes, shape, screen };
}

function scribble(screen, cells, seed) {
  let s = seed >>> 0;
  const next = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s >>> 24; };
  for (const cell of cells) {
    const x0 = (cell % COLS) * BLOCK_PX, y0 = Math.floor(cell / COLS) * BLOCK_PX;
    const rgb = [next(), next(), next()];
    for (let y = y0; y < y0 + BLOCK_PX; y++) for (let x = x0; x < x0 + BLOCK_PX; x++) {
      const p = (y * screen.width + x) * 4;
      screen.data[p] = rgb[0]; screen.data[p + 1] = rgb[1]; screen.data[p + 2] = rgb[2];
    }
  }
}

const camera = (screen) => decodeCameraFrame({
  data: noise(brightnessContrast(blur(warpToQuad(screen, tiltQuad(screen.width, screen.height, W, H, 3, 0.88), W, H), 1), 0.2, 0.9), 3, 5).data,
  width: W, height: H,
});

test('a v4 probe frame parses with known packets', () => {
  const { frameBytes, shape } = make(3);
  const out = parseFrameV4(frameBytes);
  assert.equal(shape.packets, 14);
  assert.equal(out.header.frameType, FRAME_TYPES.probe);
  assert.equal(out.header.probeId, 7);
  assert.equal(out.header.sourceCount, 0);
  assert.equal(out.header.streamLength, 0);
  assert.equal(out.packets.length, 14);
  out.packets.forEach((p, k) => {
    assert.equal(p.symbolId, 42 + k);
    assert.deepEqual(p.data, probePayload(TX, 42 + k, 214));
  });
});

test('v4 probe frames never reach the collector', () => {
  const read = camera(make(3).screen);
  assert.ok(read.frame, read.read.reason);
  assert.equal(read.read.frameHeader.frameType, FRAME_TYPES.probe);
  const collector = new Collector();
  let failures = 0;
  collector.noteFailure = () => { failures++; };
  const added = [];
  collector.add = (f) => added.push(f);
  assert.equal(routeRead(collector, read), false);
  assert.equal(added.length, 0);
  assert.equal(failures, 0);
  assert.equal(collector.status().received ?? 0, 0);
  // A failed probe read is not a data failure either.
  routeRead(collector, { read: read.read, frame: null });
  assert.equal(failures, 0);
});

test('the attempt names its good packets', () => {
  const { screen } = make(3);
  // Data cells of packets 2 and 5: payload starts after the header cells; scribble well inside each.
  const cells = [];
  const per = (layoutV4.dataBlockCount - 256) / 14;
  for (const k of [2, 5]) {
    const mid = 128 + Math.floor((k + 0.5) * per);
    for (let c = mid - 40; c < mid + 40; c++) cells.push(layoutV4.cellIndexOf ? layoutV4.cellIndexOf(c) : layoutV4.v3Index[c]);
  }
  scribble(screen, cells, 9);
  const out = camera(screen);
  assert.ok(out.frame, out.read.reason);
  const header = attemptHeader(out.read.frameHeader, out.frame);
  assert.equal(header.packetCount, 14);
  assert.equal(header.packetMask, '11011011111111');
  assert.equal(header.goodPackets, 12);
  const rec = attemptRecord({ atMs: 1, grabMs: 1, decodeMs: 1, read: out.read, frame: out.frame, debug: null, errors: null, packetMask: header.packetMask });
  assert.equal(rec.packetMask, '11011011111111');
  assert.equal(attemptRecord({ atMs: 1, grabMs: 1, decodeMs: 1, read: out.read, frame: null, debug: null, errors: null }).packetMask, undefined);
});

test('a parity 0 probe frame round trips and a wrong byte fails only its packet', () => {
  const p0 = { ...probe, parity: 0 };
  const { frameBytes, shape } = buildProbeFrameV4({ probe: p0, txId: TX, index: 3, layoutV4, probeCount: 50 });
  assert.equal(shape.packetBytes, shape.codewordBytes - 7);
  const clean = parseFrameV4(frameBytes);
  assert.equal(clean.header.parity, 0);
  assert.equal(clean.packets.length, shape.packets);
  clean.packets.forEach((q, k) => {
    assert.ok(q, `packet ${k}`);
    assert.deepEqual(q.data, probePayload(TX, 3 * shape.packets + k, shape.packetBytes));
  });
  const bad = frameBytes.slice();
  bad[2 * 48 + 3 * shape.codewordBytes + 20] ^= 0x5a;
  const out = parseFrameV4(bad);
  out.packets.forEach((q, k) => assert.equal(q === null, k === 3, `packet ${k}`));
});

test('a Refine test frame round trips the run id, the refine flag and white', async () => {
  const { PROBE_FLAGS } = await import('../src/core/frame.js');
  const refine = { ...probe, refine: true, white: 223 };
  const { frameBytes } = buildProbeFrameV4({ probe: refine, txId: TX, index: 1, layoutV4, probeCount: 15, runId: 0xdeadbeef });
  const { header } = parseFrameV4(frameBytes);
  assert.equal(header.streamLength, 0xdeadbeef);
  assert.equal(header.sourceCount, 223);
  assert.equal(header.probeRefine, true);
  assert.equal(header.probeStatic, false);
  assert.equal(header.probeFps, 4);
  assert.equal(PROBE_FLAGS.refine, 4);
  const whole = parseFrameV4(buildProbeFrameV4({ probe: { ...refine, static: true }, txId: TX, index: 0, layoutV4, probeFps: 30, shownFps: 30 }).frameBytes).header;
  assert.equal(whole.probeFps, 30); assert.equal(whole.probeStatic, true); assert.equal(whole.probeRefine, true);
  const plain = parseFrameV4(make(0).frameBytes).header;
  assert.equal(plain.probeRefine, false); assert.equal(plain.streamLength, 0);
  const attempt = attemptHeader(header, parseFrameV4(frameBytes));
  assert.equal(attempt.streamLength, 0xdeadbeef); assert.equal(attempt.sourceCount, 223); assert.equal(attempt.probeRefine, true);
});

test('a Refine frame names no probe count and reaches the phone with its test ids', async () => {
  const { attemptHeader: toAttempt } = await import('../src/optimize/readroute.js');
  const { createTestCounter } = await import('../src/optimize/testcount.js');
  const test3 = { ...probe, id: 3, refine: true, white: 255 };
  const { frameBytes } = buildProbeFrameV4({ probe: test3, txId: TX, index: 0, layoutV4, probeCount: 0, runId: 41 });
  const frame = parseFrameV4(frameBytes);
  assert.equal(frame.header.probeCount, 0);
  const counter = createTestCounter();
  counter.add({ atMs: 5, header: toAttempt(frame.header, frame) });
  const [t] = counter.report();
  assert.equal(t.runId, 41);
  assert.equal(t.probeId, 3);
  assert.equal(t.packets, frame.packets.length);
});
