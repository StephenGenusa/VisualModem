// Row formatting for tools/probe-report.js, apart so tests can import it.

export const pct = (v, d = 1) => (v === null || v === undefined ? '-' : `${(v * 100).toFixed(d)}%`);
export function reportRows(summaries) {
  return summaries.map((r) => {
  const row = {
    block: r.blockSize, scheme: r.scheme, fps: r.fps, static: r.static ? 'yes' : '',
    att: r.attempts, frames: r.okFrames, show: r.showings, newFps: r.newFramesPerSecond.toFixed(2),
    attPs: r.attemptsPerSecond.toFixed(2), okShare: pct(r.okShare, 0), 'Partial gain': r.partialGain === null ? '-' : r.partialGain.toFixed(2), pf32: pct(r.predictedFrame[32].plain, 0),
    decMs: r.decodeMsMedian ?? '-', gapMs: r.grabGapMedian ?? '-',
    cellErr: pct(r.cellErrorRate, 2), shift: pct(r.shiftShare, 0),
    stages: Object.entries(r.stageShares).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([s, v]) => `${s} ${pct(v, 0)}`).join(', '),
  };
  for (const p of [16, 32, 64]) row[`p${p}`] = `${pct(r.predicted[p].plain, 0)}/${pct(r.predicted[p].erasures, 0)}`;
  const worst = r.regionErrorRate.reduce((m, v, i) => (v !== null && v > m.v ? { v, i } : m), { v: -1, i: -1 });
  row.worst = worst.i < 0 ? '-' : `r${worst.i} ${pct(worst.v, 1)}`;
  return row;
});
}

export const PARTIAL_GAIN_NOTE = 'Partial gain (version 4) = good packets per whole frame, estimated from the packet masks of the attempts; it is not the phone\'s exact figure.';
