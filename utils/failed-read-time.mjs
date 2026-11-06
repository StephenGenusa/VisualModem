// Usage: node utils/failed-read-time.mjs [--reader <tree>] [--runs <n>] [--json]
// Times camera decodes of the failed-read cost set (src/testutil/failcases.js):
// failing reads that are not angled (bound 1.3x the reader before the perspective pass),
// angled views that still fail (bound 2.5x), and reads that succeed. Each
// image is decoded --runs times (default 5) and the median is reported, with
// the reader's work counters exactCells and finderCandidates.
// --reader times the reader of another tree, such as a worktree of the commit
// before the perspective pass; the images always come from this
// tree, so both readers see the same pixels. --json prints one JSON object per
// image instead of the table. When test/photos holds the real angled capture,
// it is timed too (kind 'photo').
import { existsSync } from 'node:fs';

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const readerRoot = opt('--reader', root).replace(/\/$/, '');
const runs = Number(opt('--runs', 5));
const json = args.includes('--json');

const { FAIL_CASES } = await import(root + '/src/testutil/failcases.js');
const { decodeCameraFrame } = await import((readerRoot.startsWith('/') ? '' : process.cwd() + '/') + readerRoot + '/src/picture/reader.js');

const cases = [...FAIL_CASES];
const photo = root + '/test/photos/capture-2026-11-01T22-41-33-145Z.png';
if (existsSync(photo)) {
  const { readImage } = await import(root + '/src/testutil/image.js');
  cases.push({ name: 'real angled capture', kind: 'photo', build: () => readImage(photo) });
}

for (const { name, kind, build } of cases) {
  const img = build();
  const ms = [];
  let out;
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    out = decodeCameraFrame(img);
    ms.push(performance.now() - start);
  }
  ms.sort((a, b) => a - b);
  const { read, frame } = out;
  const row = {
    name, kind,
    outcome: frame ? 'ok' : read.reason ?? 'header unreadable',
    pass: read.finderPass ?? null,
    medianMs: Math.round(ms[Math.floor(ms.length / 2)]),
    exactCells: read.exactCells ?? null,
    finderCandidates: read.finderCandidates ?? null,
  };
  if (json) console.log(JSON.stringify(row));
  else console.log(name.padEnd(28), kind.padEnd(8), row.outcome.padEnd(18), String(row.medianMs).padStart(5), 'ms', 'cells', row.exactCells, 'candidates', row.finderCandidates);
}
