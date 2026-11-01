// Usage: node utils/setup-check-cost.mjs
// Measures the main thread's setup-check cost per attempt as a probe run accumulates.
const { createSetupModel } = await import(new URL('../web/setupcheck.js', import.meta.url).href);
const m = createSetupModel();
const scheme = { kind: 'rgb', levels: [2, 2, 2] };
const corners = { tl: [300, 200], tr: [1620, 200], bl: [300, 880], br: [1620, 880] };
let t = 0;
for (let i = 0; i < 1200; i++) {
  const probeId = 1 + Math.floor(i / 22) % 55;
  const n = 14, index = i % 50;
  const header = { version: 4, frameType: 2, probeId, probeCount: 55, scheme, blockSize: 28, parity: 32, txId: 1000 + probeId, probeFps: 4, sourceCount: 0 };
  const attempt = { atMs: t, header, ok: true, estCols: 137, cols: 137, rows: 77, gridCorners: corners, imageW: 1920, imageH: 1080,
    packetCount: n, packetMask: '1'.repeat(n), symbolIds: Array.from({ length: n }, (_, k) => index * n + k) };
  const s = performance.now();
  m.noteAttempt(attempt);
  m.state(t);
  const d = performance.now() - s;
  if (i % 200 === 0 || i === 1199) console.log(i, d.toFixed(2), 'ms');
  t += 100;
}
