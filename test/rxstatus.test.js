import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRunStatus, MISS_TEXT, formatClock, gridText, REFINE_STALE_MS } from '../web/rxstatus.js';

test('no attempts: looking for markers, warn', () => {
  const s = createRunStatus().state(0);
  assert.equal(s.word, 'Looking for markers'); assert.equal(s.kind, 'warn');
});
test('data progress: Receiving, work, elapsed from the collector', () => {
  const r = createRunStatus();
  r.noteAttempt({ atMs: 0, stage: 'ok', header: { frameType: 0, txId: 7 } });
  r.noteCollector({ atMs: 0, txId: 7, have: 100, count: 949, unit: 'pieces', complete: false, elapsedMs: 2000 });
  const s = r.state(0);
  assert.equal(s.word, 'Receiving'); assert.equal(s.kind, 'work'); assert.equal(s.elapsedMs, 2000);
});
test('time left appears after 3 s of progress, from the last 5 s rate', () => {
  const r = createRunStatus();
  for (let t = 0; t <= 4000; t += 1000) r.noteCollector({ atMs: t, txId: 7, have: t / 10, count: 1000, unit: 'pieces', complete: false, elapsedMs: t });
  // 100 pieces a second, 600 left -> 6 s
  assert.equal(Math.round(r.state(4000).leftMs / 1000), 6);
  const early = createRunStatus(); early.noteCollector({ atMs: 0, txId: 7, have: 5, count: 1000, complete: false, elapsedMs: 0 });
  assert.equal(early.state(1000).leftMs, null);
});
test('complete: ok, and a new txId restarts', () => {
  const r = createRunStatus();
  r.noteCollector({ atMs: 0, txId: 7, have: 949, count: 949, unit: 'pieces', complete: true, elapsedMs: 9669 });
  assert.equal(r.state(0).word, 'Complete'); assert.equal(r.state(0).kind, 'ok');
  r.noteCollector({ atMs: 100, txId: 8, have: 1, count: 64, unit: 'frames', complete: false, elapsedMs: 0 });
  const s = r.state(100);
  assert.equal(s.word, 'Receiving'); assert.equal(s.leftMs, null);
});
test('probe frames with no data: Probe N of M', () => {
  const r = createRunStatus();
  r.noteAttempt({ atMs: 0, stage: 'ok', header: { frameType: 2, probeId: 3, probeCount: 12 } });
  assert.equal(r.state(0).word, 'Probe 3 of 12'); assert.equal(r.state(0).kind, 'work');
});
test('a recommendation after a probe run shows as ok', () => {
  const r = createRunStatus(); r.noteRecommendation('Best: block 28, cube 2, 10 fps');
  assert.equal(r.state(0).word, 'Best: block 28, cube 2, 10 fps'); assert.equal(r.state(0).kind, 'ok');
});
test('an error shows as fail', () => {
  const r = createRunStatus(); r.noteError('Camera unavailable');
  assert.equal(r.state(0).kind, 'fail'); assert.equal(r.state(0).word, 'Camera unavailable');
});
test('read share and main miss over the last 30 attempts', () => {
  const r = createRunStatus();
  for (let i = 0; i < 40; i++) r.noteAttempt({ atMs: i, stage: i < 10 || i % 3 ? 'timing mismatch' : 'ok' });
  const s = r.state(40);
  assert.equal(s.reads.of, 30);
  assert.equal(s.reads.ok, 10); // i = 12, 15, ..., 39 -> 10 ok in the last 30
  assert.equal(s.miss, MISS_TEXT['timing mismatch']);
});
test('every reader stage has plain words', () => {
  for (const k of ['no markers', 'timing mismatch', 'header unreadable', 'payload failed']) assert.ok(MISS_TEXT[k].length > 10);
  assert.match(MISS_TEXT['timing mismatch'], /edge/);
});
test('aim hint from the last grid corners', () => {
  const r = createRunStatus();
  r.noteAttempt({ atMs: 0, stage: 'ok', gridCorners: { tl: [100, 100], tr: [1820, 100], bl: [100, 980], br: [1820, 980] }, imageW: 1920, imageH: 1080 });
  assert.match(r.state(0).hint, /90%/); // widthShare 0.896, and these corners give no advice
});
test('clock format', () => {
  assert.equal(formatClock(null), '--:--'); assert.equal(formatClock(72_000), '1:12'); assert.equal(formatClock(9_669), '0:10');
});
test('probe frames after a finished transfer show Probe N of M, not the stale Complete', () => {
  const r = createRunStatus();
  const done = { txId: 7, have: 949, count: 949, unit: 'pieces', complete: true, elapsedMs: 9669 };
  r.noteCollector({ atMs: 0, ...done });
  assert.equal(r.state(0).word, 'Complete');
  // Probe frames never reach the collector, so each status still carries the old one.
  r.noteAttempt({ atMs: 5000, stage: 'ok', header: { frameType: 2, probeId: 3, probeCount: 12 } });
  r.noteCollector({ atMs: 5000, ...done });
  assert.equal(r.state(5000).word, 'Probe 3 of 12'); assert.equal(r.state(5000).kind, 'work');
  r.noteRecommendation('Best: block 28, cube 2, 10 fps');
  r.noteCollector({ atMs: 60000, ...done }); // long after the run, the collector is still the old one
  assert.equal(r.state(60000).word, 'Best: block 28, cube 2, 10 fps'); assert.equal(r.state(60000).kind, 'ok');
});
test('a stale Receiving collector also gives way to probe frames, and new data takes it back', () => {
  const r = createRunStatus();
  const part = (have, atMs) => r.noteCollector({ atMs, txId: 7, have, count: 949, unit: 'pieces', complete: false, elapsedMs: atMs });
  part(100, 0);
  r.noteAttempt({ atMs: 1000, stage: 'ok', header: { frameType: 2, probeId: 1, probeCount: 12 } });
  part(100, 1000);
  assert.equal(r.state(1000).word, 'Probe 1 of 12');
  part(120, 2000); // data again
  assert.equal(r.state(2000).word, 'Receiving');
});
test('the grid line names the grid size and colors the phone read', () => {
  assert.equal(gridText({ markersFound: true, cols: 137, rows: 77, schemeName: 'rgb 2/2/2' }), 'Grid 137×77, rgb 2/2/2');
  assert.equal(gridText({ markersFound: true, cols: 167, rows: 94, scheme: { kind: 'gray', levels: 2 } }), 'Grid 167×94, gray 2');
  assert.equal(gridText({ markersFound: true, cols: 10, rows: 8, levels: 4 }), 'Grid 10×8, 4 levels');
  assert.equal(gridText({ markersFound: true }), '');
  assert.equal(gridText({ markersFound: false, cols: 10, rows: 8 }), '');
  assert.equal(gridText(null), '');
});

const PROBE = (id) => ({ frameType: 2, probeId: id, probeCount: 32 });
test('a fresh probe attempt outranks a held recommendation', () => {
  const r = createRunStatus();
  r.noteAttempt({ atMs: 0, stage: 'ok', header: PROBE(1) });
  r.noteRecommendation('Best: block 28, cube 2, 10 fps');
  r.noteAttempt({ atMs: 5000, stage: 'ok', header: PROBE(7) });
  const s = r.state(6000);
  assert.equal(s.word, 'Probe 7 of 32'); assert.equal(s.kind, 'work');
});
test('probe frames stopped for over 3 s: the recommendation shows', () => {
  const r = createRunStatus();
  r.noteAttempt({ atMs: 0, stage: 'ok', header: PROBE(7) });
  r.noteRecommendation('Best: block 28, cube 2, 10 fps');
  const s = r.state(3500);
  assert.equal(s.word, 'Best: block 28, cube 2, 10 fps'); assert.equal(s.kind, 'ok');
});
test('probe frames stopped for over 3 s with no recommendation: Probe stopped, warn', () => {
  const r = createRunStatus();
  r.noteAttempt({ atMs: 0, stage: 'ok', header: PROBE(7) });
  assert.equal(r.state(2000).word, 'Probe 7 of 32');
  const s = r.state(3500);
  assert.equal(s.word, 'Probe stopped'); assert.equal(s.kind, 'warn');
});
const corners = (l, r) => ({ tl: [l, 100], tr: [r, 100], bl: [l, 980], br: [r, 980] });
test('aim hint: a small TV says move closer, a filled view says good', () => {
  const a = createRunStatus();
  a.noteAttempt({ atMs: 0, stage: 'ok', gridCorners: corners(480, 1440), imageW: 1920, imageH: 1080 });
  assert.match(a.state(0).hint, /Move closer: the TV fills 50% of the width \(the best run was at about 70%\)/);
  const b = createRunStatus();
  b.noteAttempt({ atMs: 0, stage: 'ok', gridCorners: corners(100, 1820), imageW: 1920, imageH: 1080 });
  assert.match(b.state(0).hint, /^Aim is good, the TV fills 90% of the width/);
});
test('an attempt without corners clears the aim hint', () => {
  const r = createRunStatus();
  r.noteAttempt({ atMs: 0, stage: 'ok', gridCorners: corners(100, 1820), imageW: 1920, imageH: 1080 });
  r.noteAttempt({ atMs: 100, stage: 'no markers' });
  assert.equal(r.state(100).hint, null);
});

test('aim hint: 70% framing is good, 60% says move closer', () => {
  const at = (l, r) => { const s = createRunStatus(); s.noteAttempt({ atMs: 0, stage: 'ok', gridCorners: corners(l, r), imageW: 1920, imageH: 1080 }); return s.state(0).hint; };
  assert.match(at(288, 1632), /^Aim is good, the TV fills 70% of the width/);
  assert.match(at(384, 1536), /^Move closer: the TV fills 60% of the width/);
});

const refineFrame = (probeId) => ({ frameType: 2, probeId, probeCount: 0, probeRefine: true, streamLength: 9 });

test('a Refine frame shows Refine progress on the big status, not a probe count', () => {
  const r = createRunStatus();
  r.noteAttempt({ atMs: 1000, stage: 'ok', header: refineFrame(12) });
  const s = r.state(1000);
  assert.equal(s.word, 'Refine test 12');
  assert.equal(s.kind, 'work');
  assert.equal(r.state(9000).word, 'Refine ended');
  assert.equal(r.state(9000).kind, 'warn');
});

test('the computer\'s word for a running Refine outranks a stale transfer and the frames', () => {
  const r = createRunStatus();
  r.noteCollector({ atMs: 0, txId: 7, have: 949, count: 949, unit: 'pieces', complete: true, elapsedMs: 9669 });
  r.noteRefine({ seq: 1, active: true, word: 'Refine 2:13 left', kind: 'work' }, 100);
  assert.equal(r.state(100).word, 'Refine 2:13 left');
  r.noteAttempt({ atMs: 200, stage: 'ok', header: refineFrame(1) });
  assert.equal(r.state(200).word, 'Refine 2:13 left');
  assert.equal(r.refineActive(200), true);
});

test('a Refine result stays on the big status until something newer happens', () => {
  const r = createRunStatus();
  r.noteAttempt({ atMs: 100, stage: 'ok', header: refineFrame(1) });
  r.noteRefine({ seq: 2, active: false, word: 'Refine done: block 25', kind: 'ok' }, 200);
  // A late read of the last test does not hide it.
  r.noteAttempt({ atMs: 300, stage: 'ok', header: refineFrame(1) });
  assert.equal(r.state(600000).word, 'Refine done: block 25');
  assert.equal(r.state(600000).kind, 'ok');
  assert.equal(r.refineActive(300), false);
  r.noteAttempt({ atMs: 700000, stage: 'ok', header: { frameType: 2, probeId: 3, probeCount: 40 } });
  assert.equal(r.state(700000).word, 'Probe 3 of 40');
  const sent = createRunStatus();
  sent.noteRefine({ seq: 2, active: false, word: 'Refine done: block 25', kind: 'ok' }, 200);
  sent.noteCollector({ atMs: 500, txId: 8, have: 1, count: 64, unit: 'frames', complete: false, elapsedMs: 0 });
  assert.equal(sent.state(500).word, 'Receiving');
});

test('a Refine word that stops being renewed lapses, and clearing removes it', () => {
  const r = createRunStatus();
  r.noteRefine({ seq: 1, active: true, word: 'Refine 2:13 left', kind: 'work' }, 0);
  r.noteRefine({ seq: 1, active: true, word: 'Refine 2:13 left', kind: 'work' }, 50000);
  assert.equal(r.refineActive(50000), true);
  assert.equal(r.refineActive(REFINE_STALE_MS + 1), false, 'the same seq does not renew it');
  assert.notEqual(r.state(REFINE_STALE_MS + 1).word, 'Refine 2:13 left');
  r.noteRefine({ seq: 2, active: true, word: 'Refine 2:06 left', kind: 'work' }, REFINE_STALE_MS + 2);
  assert.equal(r.refineActive(REFINE_STALE_MS + 2), true);
  r.noteRefine(null, REFINE_STALE_MS + 3);
  assert.equal(r.refineActive(REFINE_STALE_MS + 3), false);
  assert.equal(r.state(REFINE_STALE_MS + 3).word, 'Looking for markers');
});
