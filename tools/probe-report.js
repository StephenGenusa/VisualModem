// Tabulates the phone's per-attempt probe records from the debug log.
//
// Usage: node tools/probe-report.js [--since <ISO time>] <debug.jsonl>
//
// Streams the log (it is large), keeps the `perAttempt.attempts` of every
// line at or after --since (judged by the line's `time` field), and prints one
// row per (block size, scheme, frame rate, static) from summarizeAttempts.
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { summarizeAttempts } from '../src/optimize/attemptlog.js';
import { reportRows, PARTIAL_GAIN_NOTE } from './probe-report-format.js';

const args = process.argv.slice(2);
let since = null;
let file = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--since') {
    since = Date.parse(args[++i]);
    if (!Number.isFinite(since)) {
      console.error('--since needs an ISO time, for example 2026-10-31T16:00:00Z');
      process.exit(2);
    }
  } else file = args[i];
}
if (!file) {
  console.error('Usage: node tools/probe-report.js [--since <ISO time>] <debug.jsonl>');
  process.exit(2);
}

const records = [];
let lines = 0, dropped = 0;
const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.includes('"perAttempt"')) continue; // cheap skip of the lines that have none
  let entry;
  try { entry = JSON.parse(line); } catch { continue; }
  const per = entry.perAttempt;
  if (!per || !Array.isArray(per.attempts)) continue;
  if (since !== null && !(Date.parse(entry.time) >= since)) continue;
  lines++;
  dropped += per.dropped || 0;
  for (const r of per.attempts) records.push(r);
}

if (records.length === 0) {
  console.log(`No per attempt records in ${file}${since !== null ? ' since that time' : ''}.`);
  process.exit(0);
}

const rows = reportRows(summarizeAttempts(records));
console.log(`${records.length} attempts from ${lines} reports, ${dropped} dropped on the phone. frames = distinct frames read. attPs = attempts a second. okShare = share of attempts that read; pf32 = predicted share of attempts whose every codeword passes at parity 32 (compare with okShare). decMs / gapMs = median decode time and median gap between grabs in one showing. pNN = predicted codeword success at parity NN, plain/erasures. worst = region (row*5+col) with the highest error rate. ${PARTIAL_GAIN_NOTE}`);
console.table(rows);
