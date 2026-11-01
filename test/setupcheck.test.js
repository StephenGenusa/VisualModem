import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSetupModel } from '../web/setupcheck.js';
import { schemeLabel } from '../src/optimize/probes.js';

const g4 = { kind: 'rgb', levels: [2, 4, 2] };
const header = (probeId, scheme = g4, blockSize = 23) => ({ version: 3, frameType: 2, probeId, probeCount: 32, scheme, blockSize, parity: 32 });
const gridCorners = { tl: [300, 200], tr: [1620, 200], bl: [300, 880], br: [1620, 880] };
const attempt = (atMs, h, ok, extra = {}) => ({
  atMs, header: h, ok, estCols: null, cols: 167, rows: 94, gridCorners, pitch: 8, imageW: 1920, imageH: 1080, ...extra,
});

test('scheme labels', () => {
  assert.equal(schemeLabel(g4), 'Green 4, red and blue 2');
  assert.equal(schemeLabel({ kind: 'gray', levels: 4 }), '4 shades of gray');
  assert.equal(schemeLabel({ kind: 'rgb', levels: [2, 2, 2] }), 'Color cube, 2 levels');
});

test('the panel stays hidden until probe frames are seen', () => {
  const m = createSetupModel();
  m.noteAttempt(attempt(0, null, false));
  assert.equal(m.state(100).visible, false);
  m.noteAttempt(attempt(100, header(1), true));
  assert.equal(m.state(200).visible, true);
});

test('a recommendation names the setting to use on the transmitter', () => {
  const m = createSetupModel();
  // 3 attempts a second for 10 s, all on probe 5, every one read
  for (let i = 0; i < 30; i++) m.noteAttempt(attempt(i * 333, header(5), true));
  const s = m.state(10000);
  assert.equal(s.seen, 1); assert.equal(s.probeCount, 32);
  assert.equal(s.rows.length, 1);
  assert.equal(s.rows[0].blockSize, 23);
  assert.match(s.recommendation, /^Use block 23, Green 4, red and blue 2, 3 frames per second\. About [0-9.]+ KB\/s here\.$/);
  assert.deepEqual(s.advice, []);
});

test('a header that reads with a failing payload is in the table at zero', () => {
  const m = createSetupModel();
  for (let i = 0; i < 10; i++) m.noteAttempt(attempt(i * 300, header(2), false));
  const s = m.state(3000);
  assert.equal(s.rows[0].bytesPerSecond, 0);
  assert.equal(s.recommendation, null);
});

test('aim advice comes from the latest corners', () => {
  const m = createSetupModel();
  m.noteAttempt(attempt(0, header(1), true, { gridCorners: { tl: [800, 450], tr: [1100, 450], bl: [800, 620], br: [1100, 620] } }));
  assert.deepEqual(m.state(10).advice, ['Move closer']);
});

test('a new probe count starts a new scoring run', () => {
  const m = createSetupModel();
  for (let i = 0; i < 10; i++) m.noteAttempt(attempt(i * 300, header(5), true));
  m.noteAttempt(attempt(4000, { ...header(1), probeCount: 36 }, true));
  const s = m.state(4100);
  assert.equal(s.probeCount, 36);
  assert.equal(s.seen, 1);
});

test('data frames after a probe run do not erode the recommendation', () => {
  const m = createSetupModel();
  for (let i = 0; i < 10; i++) m.noteAttempt(attempt(i * 333, header(5), true));
  const before = m.state(3500).recommendation;
  assert.ok(before);
  const data = { version: 3, frameType: 0, probeId: 0, probeCount: 0, scheme: g4, blockSize: 23, parity: 32 };
  for (let i = 0; i < 20; i++) m.noteAttempt(attempt(3500 + i * 333, data, true, { estCols: 167 }));
  assert.equal(m.state(10000).recommendation, before);
});

test('without the small marker the aim says the angle is unknown', () => {
  const m = createSetupModel();
  m.noteAttempt(attempt(0, header(1), true, { gridCorners: { ...gridCorners, br: null } }));
  assert.equal(m.state(10).angleKnown, false);
});
const charHeader = (probeId, blockSize = 23) => ({ version: 3, frameType: 1, probeId, probeCount: 32, scheme: { kind: 'rgb', levels: [2, 2, 2] }, blockSize, parity: 0 });

test('a characterization header is no attempt on the probe it precedes', () => {
  const m = createSetupModel();
  for (let i = 0; i < 10; i++) m.noteAttempt(attempt(i * 300, header(5), true));
  for (let i = 0; i < 10; i++) m.noteAttempt(attempt(3000 + i * 300, charHeader(5), false));
  assert.equal(m.state(6000).rows[0].attempts, 10);
});

test('the status line says where the run is', () => {
  const m = createSetupModel();
  m.noteAttempt(attempt(0, charHeader(1, 45), true));
  assert.equal(m.state(100).statusLine, 'Measuring the camera at block 45. Loop 1, 0 of 32 probes seen.');
  m.noteAttempt(attempt(200, header(13), true));
  assert.equal(m.state(300).statusLine, 'Probe 13 of 32: block 23, Green 4, red and blue 2. Loop 1, 1 of 32 probes seen.');
  assert.match(m.state(5000).statusLine, /^No probe frames seen for 5 s\. /);
});

test('the status line gives the recommendation once a loop is done', () => {
  const m = createSetupModel();
  for (let i = 0; i < 30; i++) m.noteAttempt(attempt(i * 333, header(32), true));
  m.noteAttempt(attempt(10000, header(1), false)); // the loop wrapped
  const s = m.state(10100);
  assert.match(s.statusLine, /^Probe 1 of 32: .* Loop 2, 2 of 32 probes seen\. Loop 1 done\. Use block 23, Green 4, red and blue 2, [0-9.]+ frames per second\. About [0-9.]+ KB\/s here\.$/);
});

test('a one-line best setting for the run panel, only once a loop is done', () => {
  const m = createSetupModel();
  for (let i = 0; i < 30; i++) m.noteAttempt(attempt(i * 333, header(32), true));
  assert.equal(m.state(9700).best, null);
  m.noteAttempt(attempt(10000, header(1), false)); // the loop wrapped
  assert.match(m.state(10100).best, /^Best: block 23, Green 4, red and blue 2, [0-9.]+ fps$/);
});

test('camera profiles are kept per block size', () => {
  const m = createSetupModel();
  m.noteProfile({ measured: true, blockSize: 45, luma: { 1: 1, 2: 1, 4: 1 }, chroma: { 1: 0.5, 2: 0.9, 4: 1 }, cast: [1, 1, 1] });
  m.noteProfile({ measured: false, reason: 'too small', blockSize: 9 });
  assert.deepEqual(Object.keys(m.state(0).profiles).map(Number).sort((a, b) => a - b), [9, 45]);
});
test('a late frame from the previous probe is not a new loop', () => {
  const m = createSetupModel();
  m.noteAttempt(attempt(0, header(13), true));
  m.noteAttempt(attempt(100, header(12), true));
  assert.match(m.state(200).statusLine, /Loop 1,/);
});
test('the debug summary carries the status, profiles and recommendation, compactly', async () => {
  const { setupSummary } = await import('../web/setupcheck.js');
  const m = createSetupModel();
  assert.equal(setupSummary(m.state(0)), null); // nothing seen yet: nothing to report
  for (let i = 0; i < 30; i++) m.noteAttempt(attempt(i * 333, header(5), true));
  m.noteProfile({ measured: true, blockSize: 45, luma: { 1: 0.987654, 2: 1, 4: 1 }, chroma: { 1: 0.4321, 2: 0.9, 4: 1 }, cast: [1.0234, 1, 0.97], patches: { big: 'x' }, pitchPx: 13.1 });
  const s = setupSummary(m.state(10000));
  assert.equal(s.statusLine, m.state(10000).statusLine);
  assert.match(s.recommendation, /^Use block 23/);
  assert.equal(s.rows.length, 1);
  assert.deepEqual(s.profiles['45'], { measured: true, luma: [0.99, 1, 1], chroma: [0.43, 0.9, 1], cast: [1.02, 1, 0.97], pitchPx: 13.1 });
  assert.equal(JSON.parse(JSON.stringify(s)).seen, 1);
});
test('rows and the status line tell sweep entries and the static twin apart', () => {
  const cube = { kind: 'rgb', levels: [2, 2, 2] };
  const m = createSetupModel();
  for (let i = 0; i < 10; i++) m.noteAttempt(attempt(i * 300, header(3, cube), true));
  for (let i = 0; i < 10; i++) m.noteAttempt(attempt(3000 + i * 300, { ...header(4, cube), probeFps: 10 }, true));
  for (let i = 0; i < 10; i++) m.noteAttempt(attempt(6000 + i * 300, { ...header(5, cube), probeFps: 4, probeStatic: true }, true));
  const s = m.state(9000);
  assert.deepEqual(s.rows.map((r) => r.label).sort(), ['Color cube, 2 levels', 'Color cube, 2 levels, 10 fps', 'Color cube, 2 levels, static']);
  assert.equal(s.statusLine, 'Probe 5 of 32: block 23, Color cube, 2 levels, static. Loop 1, 3 of 32 probes seen.');
  m.noteAttempt(attempt(9100, { ...header(6, cube), probeFps: 4 }, true));
  assert.match(m.state(9200).statusLine, /^Probe 6 of 32: block 23, Color cube, 2 levels\. /);
});

test('v4 probes are scored by packets and the summary carries the partial gain', async () => {
  const { setupSummary } = await import('../web/setupcheck.js');
  const { computeLayoutV4 } = await import('../src/picture/layout.js');
  const { frameShapeV4 } = await import('../src/core/framev4.js');
  const shape = frameShapeV4(computeLayoutV4(167, 94), g4, 32);
  const n = shape.packets;
  const m = createSetupModel();
  // two whole frames plus half of two more, read 4 times a second
  const frames = [];
  for (let f = 0; f < 4; f++) for (let k = 0; k < (f < 2 ? n : n / 2 | 0); k++) frames.push(f * n + k);
  const per = Math.ceil(frames.length / 12);
  for (let i = 0; i < 12; i++) {
    const ids = frames.slice(i * per, (i + 1) * per);
    m.noteAttempt(attempt(i * 250, { ...header(5), version: 4, txId: 9, symbolIds: ids, packetCount: n }, ids.length > 0));
  }
  const s = m.state(3000);
  assert.equal(s.rows[0].partialGain > 1, true);
  assert.equal(s.rows[0].bytesPerSecond, shape.packetBytes * Math.min(frames.length / 2.5, n * 4));
  assert.equal(setupSummary(s).rows[0].partialGain, Math.round(s.rows[0].partialGain * 100) / 100);
  assert.ok('partialGain' in setupSummary(s));
});

test('the summary lists every seen probe with its packets and partial gain, sorted by id', async () => {
  const { setupSummary } = await import('../web/setupcheck.js');
  const { computeLayoutV4 } = await import('../src/picture/layout.js');
  const { frameShapeV4 } = await import('../src/core/framev4.js');
  const n = frameShapeV4(computeLayoutV4(167, 94), g4, 32).packets;
  const m = createSetupModel();
  const feed = (id, count, t0) => {
    const per = Math.ceil(count / 12);
    const all = Array.from({ length: count }, (_, i) => i);
    for (let i = 0; i < 12; i++) {
      const ids = all.slice(i * per, (i + 1) * per);
      m.noteAttempt(attempt(t0 + i * 250, { ...header(id), version: 4, txId: 9, symbolIds: ids, packetCount: n }, ids.length > 0));
    }
  };
  feed(9, n * 2 + (n / 2 | 0), 0); // whole frames and a partial one
  feed(2, n / 2 | 0, 3000); // never a whole frame
  feed(6, n * 2, 6000);
  const s = setupSummary(m.state(9000));
  assert.deepEqual(s.probes.map((p) => p.id), [2, 6, 9]);
  for (const p of s.probes) {
    assert.deepEqual(Object.keys(p).sort(), ['attempts', 'blockSize', 'bytesPerSecond', 'fps', 'id', 'label', 'ok', 'packets', 'partialGain', 'wholeFrames']);
    assert.equal(p.blockSize, 23);
  }
  assert.equal(s.probes[0].partialGain, null);
  assert.equal(s.probes[0].wholeFrames, 0);
  assert.ok(s.probes[0].packets > 0);
  assert.equal(s.probes[2].wholeFrames >= 2, true);
  assert.equal(s.probes[2].partialGain > 1, true);
  JSON.parse(JSON.stringify(s));
});

test('rows stay capped at five when more probes score', () => {
  const m = createSetupModel();
  for (let id = 1; id <= 7; id++) for (let i = 0; i < 10; i++) m.noteAttempt(attempt((id - 1) * 3000 + i * 300, header(id), true));
  assert.equal(m.state(21000).rows.length, 5);
});

test('state stays cheap as probes accumulate', () => {
  const m = createSetupModel();
  const scheme = { kind: 'rgb', levels: [2, 2, 2] };
  const corners = { tl: [300, 200], tr: [1620, 200], bl: [300, 880], br: [1620, 880] };
  let t = 0;
  for (let i = 0; i < 55 * 6; i++) {
    const probeId = 1 + (i % 55);
    const n = 14;
    const h = { version: 4, frameType: 2, probeId, probeCount: 55, scheme, blockSize: 28, parity: 32, txId: 1000 + probeId, probeFps: 4, sourceCount: 0,
      packetCount: n, symbolIds: Array.from({ length: n }, (_, k) => Math.floor(i / 55) * n + k) };
    m.noteAttempt({
      atMs: t, header: h, ok: true, estCols: 137, cols: 137, rows: 77, gridCorners: corners, imageW: 1920, imageH: 1080,
    });
    t += 100;
  }
  const t0 = performance.now();
  let s;
  for (let i = 0; i < 50; i++) s = m.state(t);
  const mean = (performance.now() - t0) / 50;
  assert.ok(mean < 2, `state() mean ${mean.toFixed(2)} ms, want under 2`);
  // Results unchanged from before the fix (values recorded at RED time).
  assert.equal(s.rows.length, 5);
  assert.equal(s.rows[0].bytesPerSecond, 7190.400000000001);
  assert.equal(s.rows[0].partialGain, 1);
  const p1 = s.probes[0];
  assert.equal(p1.id, 1);
  assert.equal(p1.packets, 84);
  assert.equal(p1.wholeFrames, 6);
  assert.equal(p1.partialGain, 1);
  assert.equal(p1.bytesPerSecond, 7190.400000000001);
});
