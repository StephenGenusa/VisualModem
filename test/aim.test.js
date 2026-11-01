import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aimFromCorners } from '../src/optimize/aim.js';
import { tiltQuad } from '../src/testutil/distort.js';

const image = { width: 1920, height: 1080 };
const quadCorners = ([tl, tr, br, bl]) => ({ tl, tr, br, bl });
const rect = (x0, y0, x1, y1) => ({ tl: [x0, y0], tr: [x1, y0], br: [x1, y1], bl: [x0, y1] });
const rotate = (c, deg, [cx, cy]) => {
  const a = (deg * Math.PI) / 180;
  const r = ([x, y]) => [cx + (x - cx) * Math.cos(a) - (y - cy) * Math.sin(a), cy + (x - cx) * Math.sin(a) + (y - cy) * Math.cos(a)];
  return { tl: r(c.tl), tr: r(c.tr), br: r(c.br), bl: r(c.bl) };
};

test('a square-on grid has no advice', () => {
  const a = aimFromCorners(rect(260, 140, 1660, 940), image);
  assert.deepEqual(a.advice, []);
  assert.ok(Math.abs(a.yawDeg) < 0.5 && Math.abs(a.pitchDeg) < 0.5 && Math.abs(a.rollDeg) < 0.5);
  assert.ok(Math.abs(a.centerX - 0.5) < 0.01 && Math.abs(a.centerY - 0.5) < 0.01);
  assert.ok(Math.abs(a.widthShare - 1400 / 1920) < 0.01);
});

test('20 degrees of yaw is measured within 3 degrees', () => {
  const scale = 0.85;
  // tiltQuad's focal length is scale x outWidth x 3, so its field of view across the width is:
  const fovDeg = (2 * Math.atan(1 / (6 * scale)) * 180) / Math.PI;
  const a = aimFromCorners(quadCorners(tiltQuad(1920, 1080, 1920, 1080, 20, scale)), image, fovDeg);
  assert.ok(Math.abs(Math.abs(a.yawDeg) - 20) <= 3, `yaw ${a.yawDeg}`);
  assert.ok(Math.abs(a.pitchDeg) < 2, `pitch ${a.pitchDeg}`);
  assert.ok(Math.abs(a.rollDeg) < 1, `roll ${a.rollDeg}`);
  assert.ok(a.advice.some((s) => s.startsWith('Turn the phone to face the screen squarely (about 2')), a.advice.join('; '));
});

test('roll of 4 degrees asks to level the phone', () => {
  const a = aimFromCorners(rotate(rect(260, 140, 1660, 940), 4, [960, 540]), image);
  assert.ok(Math.abs(a.rollDeg - 4) < 0.5, `roll ${a.rollDeg}`);
  assert.deepEqual(a.advice, ['Level the phone (rolled about 4 degrees)']);
});

test('an off centre grid asks to centre the screen', () => {
  const a = aimFromCorners(rect(700, 140, 1900, 940), image);
  assert.deepEqual(a.advice, ['Centre the screen in the camera view']);
});

test('a small grid asks to move closer', () => {
  const a = aimFromCorners(rect(760, 400, 1160, 680), image);
  assert.deepEqual(a.advice, ['Move closer']);
});

test('without the bottom right corner the angle is unknown', () => {
  const c = rect(260, 140, 1660, 940);
  const a = aimFromCorners({ ...c, br: null }, image);
  assert.equal(a.yawDeg, null); assert.equal(a.pitchDeg, null);
  assert.equal(a.angleKnown, false);
  assert.deepEqual(a.advice, []);
});
test('a phone held sideways is not told to level itself', () => {
  const a = aimFromCorners(rotate(rect(260, 140, 1660, 940), 90, [960, 540]), image);
  assert.ok(Math.abs(a.rollDeg) < 0.5, `roll ${a.rollDeg}`);
});
test('the reader\'s grid corners give the yaw within 3 degrees', async () => {
  const { computeLayout } = await import('../src/picture/layout.js');
  const { renderFrame } = await import('../src/picture/render.js');
  const { buildFrame, frameGrossBytes } = await import('../src/core/frame.js');
  const { warpToQuad } = await import('../src/testutil/distort.js');
  const { decodeCameraFrame } = await import('../src/picture/reader.js');
  const layout = computeLayout(42, 24); // about 1080p at block 45
  const gross = frameGrossBytes(layout.dataBlockCount, 2);
  const frameBytes = buildFrame({ payload: new Uint8Array(40), index: 0, count: 1, txId: 1, blockSize: 45, levels: 2, parity: 32 }, gross);
  const screen = renderFrame({ frameBytes, index: 0, levels: 2, blockSize: 45, layout });
  const scale = 0.8;
  const fovDeg = (2 * Math.atan(1 / (6 * scale)) * 180) / Math.PI;
  for (const yaw of [10, 20]) {
    const img = warpToQuad(screen, tiltQuad(screen.width, screen.height, 1280, 720, yaw, scale), 1280, 720);
    const { read } = decodeCameraFrame(img);
    assert.ok(read.gridCorners, read.reason);
    const a = aimFromCorners(read.gridCorners, { width: 1280, height: 720 }, fovDeg);
    assert.ok(Math.abs(Math.abs(a.yawDeg) - yaw) <= 3, `yaw ${yaw}: got ${a.yawDeg}`);
    assert.ok(Math.abs(a.pitchDeg) <= 3, `pitch ${a.pitchDeg}`);
  }
});
