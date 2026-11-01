import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScorer } from '../src/optimize/score.js';

const probes = [
  { id: 1, blockSize: 28, fps: 4, cols: 68 },
  { id: 2, blockSize: 19, fps: 4, cols: 101 },
  { id: 3, blockSize: 13, fps: 4, cols: 147 },
];
const bpf = { 1: 500, 2: 1200, 3: 2600 };
const colsOf = (id) => probes.find((p) => p.id === id).cols;
const make = () => createScorer(probes, { bytesPerFrame: (p) => bpf[p.id] });
// Attempts 2 s apart are separate showings, so the scorer falls back to the
// attempt rate it is given; gapMs below the showing gap measures the probe's own.
let clock = 0;
// Each probe has one showing (txId = its id) of `frames` distinct frames, read in turn.
const next = {};
const feed = (s, probeId, n, ok, estCols = null, gapMs = 2000, extra = {}) => {
  for (let i = 0; i < n; i++) {
    const index = (next[probeId] = (next[probeId] ?? -1) + 1) % (extra.frames ?? Infinity);
    const { frames, ...rest } = extra;
    const header = probeId ? { probeId, txId: extra.txId ?? probeId, index, ...rest } : null;
    s.addAttempt({ atMs: (clock += gapMs), header, ok, estCols, colsOf });
  }
};
const row = (s, id, rate = 3) => s.results(rate).find((r) => r.probe.id === id);

test('a probe whose header reads but payload fails scores zero', () => {
  const s = make();
  feed(s, 2, 10, false);
  const r = row(s, 2);
  assert.equal(r.attempts, 10); assert.equal(r.readRate, 0); assert.equal(r.bytesPerSecond, 0);
});

test('fewer than 6 attempts give no score', () => {
  const s = make();
  feed(s, 1, 5, true);
  assert.equal(row(s, 1).bytesPerSecond, null);
  assert.equal(row(s, 3).bytesPerSecond, null);
});

test('attempts without a header count against the matching probe only', () => {
  const s = make();
  feed(s, 2, 6, true); // probe 2 was seen last
  feed(s, null, 6, false, 104); // within 8 percent of 101 columns
  feed(s, null, 20, false, 147); // probe 3's grid, but probe 3 never showed a header
  feed(s, null, 5, false, null); // no estimate at all
  feed(s, 2, 1, true); // the next header names probe 2 again: its misses are charged
  const r2 = row(s, 2), r3 = row(s, 3);
  assert.equal(r2.attempts, 13); assert.equal(r2.ok, 7); assert.equal(r2.readRate, 7 / 13);
  assert.equal(r3.attempts, 0);
});

test('duplicate reads of one frame count once', () => {
  const s = make();
  feed(s, 1, 20, true, null, 2000, { frames: 2 });
  const r = row(s, 1);
  assert.equal(r.okFrames, 2); assert.equal(r.showings, 1);
  assert.equal(r.newFramesPerSecond, 0.8); // 2 frames in a 2.5 s showing
});

test('misses at a probe change go to the probe they belong to', () => {
  const s = make();
  feed(s, 1, 6, true); feed(s, null, 3, false, 68); feed(s, 2, 6, true);
  assert.equal(row(s, 1).attempts, 6);
});

test('misses followed by the same probe are charged to it', () => {
  const s = make();
  feed(s, 1, 1, true); feed(s, null, 3, false, 68); feed(s, 1, 1, true);
  assert.equal(row(s, 1).attempts, 2 + 3);
});

test('a static probe is never recommended', () => {
  const s = make();
  feed(s, 1, 10, true, null, 2000, { probeStatic: true });
  assert.equal(s.recommend(3), null);
  feed(s, 2, 10, true);
  assert.equal(s.recommend(3).probe.id, 2);
});

test('the lower bound ranks a lucky few below a steady many', () => {
  const s = createScorer(probes, { bytesPerFrame: (p) => ({ 1: 1000, 2: 900 }[p.id]) });
  feed(s, 1, 6, true, null, 2000, { frames: 6 }); // 6 of 6, 6 new frames
  feed(s, 2, 80, true, null, 2000, { frames: 6 }); feed(s, 2, 20, false, null, 2000, { frames: 6 }); // 80 of 100, 6 new frames
  const r1 = row(s, 1), r2 = row(s, 2);
  assert.equal(r1.newFramesPerSecond, r2.newFramesPerSecond);
  assert.ok(r1.readRateLow < 1 && r2.readRateLow < r2.readRate);
  assert.equal(s.recommend(3).probe.id, 2);
});

test('a probe at 7.5 fps is scored and recommended at up to 7.5', () => {
  const s = make();
  feed(s, 1, 40, true, null, 50, { probeFps: 7.5 }); // 20 attempts a second, 40 distinct frames
  const r = row(s, 1, 3);
  assert.equal(r.newFramesPerSecond, 7.5);
  assert.equal(s.recommend(3).fps, 7.5);
});

test('recommendation picks the most bytes per second among reliable probes', () => {
  const s = make();
  feed(s, 1, 10, true); // 500 x 3 = 1500
  feed(s, 2, 6, true); feed(s, 2, 4, false); // 1200 x 1.8 = 2160
  feed(s, 3, 4, true); feed(s, 3, 6, false); // read rate 0.4: unreliable
  const rec = s.recommend(3);
  assert.equal(rec.probe.id, 2);
  // ranked at 1.8 reads a second (2160 B/s); stated at the 1.5 fps it recommends
  assert.equal(rec.fps, 1.5);
  assert.equal(rec.bytesPerSecond, 1200 * 1.5);
  assert.equal(make().recommend(3), null);
});

test('recommended frame rate follows the phone\'s read rate', () => {
  const s = make();
  feed(s, 1, 10, true);
  assert.equal(s.recommend(3).fps, 3);
  assert.equal(s.recommend(1.4).fps, 1);
  assert.equal(s.recommend(0.3).fps, 0.5);
  assert.equal(s.recommend(40).fps, 4); // never above the 4 frames a second the probe showed
});

test('each probe is scored at its own attempt rate', () => {
  const s = make();
  feed(s, 1, 10, true, null, 100); // 10 attempts a second while probe 1 showed
  feed(s, 2, 10, true, null, 500, { frames: 5 }); // decoding probe 2 was slower: 2 a second, 5 distinct frames
  const r1 = row(s, 1, 3), r2 = row(s, 2, 3);
  assert.ok(Math.abs(r1.attemptRate - 10) < 1e-9, `rate 1: ${r1.attemptRate}`);
  assert.ok(Math.abs(r2.attemptRate - 2) < 1e-9, `rate 2: ${r2.attemptRate}`);
  assert.equal(r1.bytesPerSecond, 500 * 4);
  assert.equal(r2.bytesPerSecond, 1200 * 2);
});

test('the recommended frame rate and its bytes a second agree', () => {
  const s = make();
  feed(s, 2, 10, true, null, 125); // 8 reads a second
  const rec = s.recommend(3);
  assert.equal(rec.fps, 4);
  assert.equal(rec.bytesPerSecond, 1200 * rec.fps);
});

test('a non-probe header is not a miss for the last probe', () => {
  const s = make();
  feed(s, 2, 10, true);
  for (let i = 0; i < 20; i++) s.addAttempt({ atMs: (clock += 2000), header: { probeId: 0 }, ok: true, estCols: 101, colsOf });
  assert.equal(row(s, 2).attempts, 10);
  assert.equal(row(s, 2).readRate, 1);
});

// ---- version 4: packets are the unit ----
const v4probes = [{ id: 1, fps: 4 }];
const v4 = () => createScorer(v4probes, { bytesPerFrame: () => 0, packetBytes: () => 214, packetCount: () => 14 });
const v4head = (symbolIds, extra = {}) => ({ version: 4, probeId: 1, txId: 7, symbolIds, ...extra });
const v4add = (s, i, ids, extra) => s.addAttempt({ atMs: 100_000 + i * 250, header: v4head(ids, extra), ok: ids.length > 0, estCols: null, colsOf: () => 0 });

test('v4 probes score by new good packets', () => {
  const s = v4();
  // 100 distinct packets over frames 0..7: frames 0-3 whole (56), then 44 more spread over frames 4-7 so none is whole
  const ids = [];
  for (let f = 0; f < 4; f++) for (let k = 0; k < 14; k++) ids.push(f * 14 + k);
  for (let f = 4; f < 8; f++) for (let k = 0; k < 11; k++) ids.push(f * 14 + k);
  assert.equal(ids.length, 100);
  for (let i = 0; i < 10; i++) v4add(s, i, ids.slice(i * 10, i * 10 + 10));
  const r = s.results(3)[0];
  assert.equal(r.packets, 100);
  assert.equal(r.wholeFrames, 4);
  assert.equal(Math.round(r.partialGain * 100) / 100, 1.79);
  assert.equal(r.bytesPerSecond, 214 * Math.min(100 / 2.5, 14 * 4));
  assert.equal(r.readRate, 1);
});

test('duplicate packets count once', () => {
  const s = v4();
  for (let i = 0; i < 6; i++) v4add(s, i, [0, 1, 2]);
  const r = s.results(3)[0];
  assert.equal(r.packets, 3);
  assert.equal(r.wholeFrames, 0);
  assert.equal(r.partialGain, null);
});

test('a v4 attempt with no good packet is a miss; the count comes from the header when the scorer has none', () => {
  const s = createScorer(v4probes, { bytesPerFrame: () => 0, packetBytes: () => 100 });
  v4add(s, 0, [], { packetCount: 2 });
  for (let i = 1; i < 7; i++) v4add(s, i, [0, 1], { packetCount: 2 });
  const r = s.results(3)[0];
  assert.equal(r.ok, 6); assert.equal(r.attempts, 7);
  assert.equal(r.wholeFrames, 1);
});

test('a v4 recommendation is capped at the recommended frame rate', () => {
  const probe = [{ id: 1, fps: 10 }];
  const s = createScorer(probe, { bytesPerFrame: () => 0, packetBytes: () => 100, packetCount: () => 4 });
  // 8 attempts a second apart: a read rate that recommends 6 fps; all 40 packets of 10 frames at 10 fps
  for (let i = 0; i < 8; i++) {
    const ids = [];
    for (let k = 0; k < 20; k++) ids.push(i * 20 + k);
    s.addAttempt({ atMs: 100_000 + i * 160, header: { version: 4, probeId: 1, txId: 3, symbolIds: ids, probeFps: 10 }, ok: true, estCols: null, colsOf: () => 0 });
  }
  const r = s.results(6)[0];
  const rec = s.recommend(6);
  assert.ok(rec.fps < 10);
  assert.ok(r.newPacketsPerSecond > 4 * rec.fps);
  assert.equal(rec.bytesPerSecond, 100 * 4 * rec.fps);
});

test('v4 scoring stays constant time over many loops, with the same numbers', () => {
  const many = Array.from({ length: 55 }, (_, i) => ({ id: i + 1, fps: 4 }));
  const s = createScorer(many, { bytesPerFrame: () => 0, packetBytes: () => 100, packetCount: () => 5 });
  let t = 0;
  for (let loop = 0; loop < 20; loop++) {
    for (const p of many) {
      for (let a = 0; a < 2 + (p.id % 7) * 2; a++) {
        // 3 frames of 5 packets per showing; attempts read a pseudo-random run of ids, with repeats
        const first = (a * 4 + p.id) % 15;
        const ids = [first, (first + 1) % 15, (first + 2) % 15];
        s.addAttempt({ atMs: (t += 200), header: { version: 4, probeId: p.id, txId: loop * 100 + p.id, symbolIds: ids, probeFps: 4 }, ok: true, estCols: null, colsOf: () => 0 });
      }
    }
  }
  const sig = s.results(3).map((r) => `${r.packets}/${r.wholeFrames}/${r.partialGain === null ? 'n' : r.partialGain.toFixed(6)}`).join(',');
  // recorded from the unbounded implementation
  assert.equal(sig, '240/0/n,280/40/1.400000,300/60/1.000000,300/60/1.000000,300/60/1.000000,300/60/1.000000,120/0/n,240/20/2.400000,280/40/1.400000,300/60/1.000000,300/60/1.000000,300/60/1.000000,300/60/1.000000,120/0/n,240/0/n,280/40/1.400000,300/60/1.000000,300/60/1.000000,300/60/1.000000,300/60/1.000000,120/0/n,240/20/2.400000,280/40/1.400000,300/60/1.000000,300/60/1.000000,300/60/1.000000,300/60/1.000000,120/0/n,240/0/n,280/40/1.400000,300/60/1.000000,300/60/1.000000,300/60/1.000000,300/60/1.000000,120/0/n,240/0/n,280/40/1.400000,300/60/1.000000,300/60/1.000000,300/60/1.000000,300/60/1.000000,120/0/n,240/20/2.400000,280/40/1.400000,300/60/1.000000,300/60/1.000000,300/60/1.000000,300/60/1.000000,120/0/n,240/0/n,280/40/1.400000,300/60/1.000000,300/60/1.000000,300/60/1.000000,300/60/1.000000');
  const start = process.hrtime.bigint();
  for (let i = 0; i < 50; i++) s.results(3);
  const ms = Number(process.hrtime.bigint() - start) / 1e6 / 50;
  assert.ok(ms < 1, `results() averaged ${ms} ms`);
});
