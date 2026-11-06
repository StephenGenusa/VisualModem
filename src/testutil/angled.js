// Test and tool helper: a frame as a phone sees it from an angle (used by
// test/angled.test.js and utils/angle-report.mjs).
import { computeLayout, computeLayoutV4 } from '../picture/layout.js';
import { renderFrame } from '../picture/render.js';
import { schemeFromLevels } from '../core/scheme.js';
import { frameShapeV4, buildFrameV4 } from '../core/framev4.js';
import { buildFrame, frameCapacity, frameGrossBytes } from '../core/frame.js';
import { viewQuad, warpToQuad, farSideFalloff, brightnessContrast, noise } from './distort.js';

const W = 1920, H = 1080, BLOCK_PX = 28, BEZEL = 2, SCALE = 0.55;
const SCHEME = schemeFromLevels(2);

function seeded(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s >>> 24; };
}

function frameScreen(cols, rows, version) {
  if (version === 3) {
    const layout = computeLayout(cols, rows);
    const gross = frameGrossBytes(layout.dataBlockCount, SCHEME);
    const payload = Uint8Array.from({ length: frameCapacity(gross, 32) }, seeded(77));
    const frameBytes = buildFrame({ payload, index: 0, count: 4, txId: 9, blockSize: BLOCK_PX, scheme: SCHEME, parity: 32 }, gross);
    return { screen: renderFrame({ frameBytes, index: 0, scheme: SCHEME, blockSize: BLOCK_PX, layout }), payload };
  }
  const layout = computeLayoutV4(cols, rows);
  const shape = frameShapeV4(layout, SCHEME, 32);
  const next = seeded(0x1234abcd);
  const packets = Array.from({ length: shape.packets }, (_, i) => ({
    symbolId: 5 + i, data: Uint8Array.from({ length: shape.packetBytes }, next),
  }));
  const frameBytes = buildFrameV4({
    blockSize: BLOCK_PX, scheme: SCHEME, parity: 32, txId: 0x1234abcd, sourceCount: 100, streamLength: 20000, packets,
  }, shape);
  return { screen: renderFrame({ frameBytes, index: 0, scheme: SCHEME, blockSize: BLOCK_PX, layout, version: 4 }), packets };
}

// A cols by rows frame (block 28, cube 2, parity 32) on a screen with a dark
// bezel, seen from yawDeg / pitchDeg at `distance` screen widths, with the far
// side dimmed and blurred, on a 1920 x 1080 camera image.
export function angledShot({ cols = 137, rows = 77, version = 4, yawDeg = 0, pitchDeg = 0, distance = 0.9, dim = 0, blurPx = 0, surround = [24, 24, 28] } = {}) {
  const { screen, packets, payload } = frameScreen(cols, rows, version);
  const b = BEZEL * BLOCK_PX;
  const full = { data: new Uint8ClampedArray((screen.width + 2 * b) * (screen.height + 2 * b) * 4), width: screen.width + 2 * b, height: screen.height + 2 * b };
  for (let i = 0; i < full.width * full.height; i++) full.data.set([10, 10, 12, 255], i * 4);
  for (let y = 0; y < screen.height; y++) {
    const from = y * screen.width * 4;
    full.data.set(screen.data.subarray(from, from + screen.width * 4), ((y + b) * full.width + b) * 4);
  }
  const quad = viewQuad(full.width, full.height, W, H, { yawDeg, pitchDeg, distance, scale: SCALE });
  let img = warpToQuad(full, quad, W, H, surround);
  img = farSideFalloff(img, quad, { dim, blurPx });
  img = brightnessContrast(img, 0.2, 0.9);
  return { img: noise(img, 3, 5), packets, payload, quad };
}

// The stage a decode reached: no markers, timing mismatch, header unreadable,
// payload failed or ok.
export function stageOf(out, packets, payload) {
  if (out.read.reason === 'no markers') return 'no markers';
  if (out.read.reason === 'timing mismatch') return 'timing mismatch';
  if (!out.frame) return 'header unreadable';
  if (packets) {
    const good = out.frame.packets && out.frame.packets.every((p, i) => p && p.symbolId === packets[i].symbolId && p.data.every((v, k) => v === packets[i].data[k]));
    return good ? 'ok' : 'payload failed';
  }
  if (payload) {
    const p = out.frame.payload;
    return p && p.length === payload.length && p.every((v, i) => v === payload[i]) ? 'ok' : 'payload failed';
  }
  return 'ok';
}
