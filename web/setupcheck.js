// The receiver's Setup check panel: aiming advice, the camera profile, probe
// progress, the best probes and a recommendation, all from light alone.
// createSetupModel holds the numbers and has no DOM, so it runs in Node
// tests; setupSetupCheck draws it. See the spec, "Version 3: the optimizer".
import { createScorer } from '../src/optimize/score.js';
import { aimFromCorners } from '../src/optimize/aim.js';
import { PROBE_FPS, schemeLabel } from '../src/optimize/probes.js';
import { FRAME_TYPES, frameCapacity, frameGrossBytes } from '../src/core/frame.js';
import { computeLayout, computeLayoutV4 } from '../src/picture/layout.js';
import { frameShapeV4 } from '../src/core/framev4.js';

const RATE_WINDOW_MS = 10000; // the attempt rate is measured over this much of the camera loop
const TOP_ROWS = 5;
const QUIET_MS = 3000; // no probe frame for this long and the status line says so

const formatFps = (fps) => (Number.isInteger(fps) ? String(fps) : fps.toFixed(1));
const kbps = (bytesPerSecond) => (bytesPerSecond / 1000).toFixed(1);

// The scheme, plus the frame rate when it is not the default and "static" for
// the static twin, so sweep entries and twins of one scheme read apart.
function probeLabel(scheme, fps, isStatic) {
  const parts = [schemeLabel(scheme)];
  if (Number.isFinite(fps) && fps !== PROBE_FPS) parts.push(`${formatFps(fps)} fps`);
  if (isStatic) parts.push('static');
  return parts.join(', ');
}

// What a probe's grid carries, worked out once when the probe is first seen:
// the version 4 packet size and count, or the version 3 bytes per frame.
function sizesOf(version, cols, rows, scheme, parity) {
  if (version === 4) {
    const shape = frameShapeV4(computeLayoutV4(cols, rows), scheme, parity);
    return { packetBytes: shape?.packetBytes ?? 0, packets: shape?.packets ?? 0, bytesPerFrame: 0 };
  }
  return { packetBytes: 0, packets: 0, bytesPerFrame: frameCapacity(frameGrossBytes(computeLayout(cols, rows).dataBlockCount, scheme), parity) };
}

export function createSetupModel() {
  let visible = false;
  let probeCount = 0;
  let scorer = null;
  let info = new Map(); // probe id -> what its headers said: block, scheme, parity, grid
  let times = []; // attempt times, for the attempt rate
  let advice = [];
  let angleKnown = true;
  const profiles = {}; // block size -> camera profile
  let current = null; // the latest probe or characterization header
  let currentAtMs = 0;
  let loopsDone = 0;

  function startRun(count) {
    probeCount = count;
    info = new Map();
    const probes = Array.from({ length: count }, (_, i) => ({ id: i + 1, fps: PROBE_FPS }));
    scorer = createScorer(probes, {
      packetBytes: (probe) => info.get(probe.id)?.sizes.packetBytes ?? 0,
      packetCount: (probe) => info.get(probe.id)?.sizes.packets ?? 0,
      bytesPerFrame: (probe) => info.get(probe.id)?.sizes.bytesPerFrame ?? 0,
    });
  }

  function attemptRate(nowMs) {
    times = times.filter((t) => nowMs - t <= RATE_WINDOW_MS);
    if (times.length === 0) return 0;
    const span = Math.max(1000, Math.min(RATE_WINDOW_MS, nowMs - times[0]));
    return times.length / (span / 1000);
  }

  return {
    /**
     * One camera attempt: header is the version 3 header the reader found,
     * or null; ok says the whole frame read.
     */
    noteAttempt({ atMs, header, ok, estCols, cols, rows, gridCorners, imageW, imageH }) {
      times.push(atMs);
      if (gridCorners && gridCorners.tl && gridCorners.tr && gridCorners.bl && imageW > 0) {
        const aim = aimFromCorners(gridCorners, { width: imageW, height: imageH });
        advice = aim.advice;
        angleKnown = aim.angleKnown;
      }
      const isProbe = header && header.frameType === FRAME_TYPES.probe;
      const isRunFrame = isProbe || (header && header.frameType === FRAME_TYPES.characterization);
      if (isRunFrame) {
        visible = true;
        if (header.probeCount > 0 && header.probeCount !== probeCount) { startRun(header.probeCount); loopsDone = 0; current = null; }
        // The run loops: a probe id lower than the last one starts the next loop.
        // A small step back is a late camera frame of the previous probe, not a new loop.
        if (current && header.probeId > 0 && header.probeId < current.probeId - probeCount / 2) loopsDone++;
        if (header.probeId > 0) current = header;
        currentAtMs = atMs;
      }
      if (!scorer) return;
      if (isProbe && cols && rows && !info.has(header.probeId)) {
        info.set(header.probeId, {
          version: header.version, blockSize: header.blockSize, scheme: header.scheme, parity: header.parity, cols, rows,
          probeFps: header.probeFps ?? null, probeStatic: Boolean(header.probeStatic),
          sizes: sizesOf(header.version, cols, rows, header.scheme, header.parity),
        });
      }
      scorer.addAttempt({
        atMs,
        // Only probe headers count; a data or characterization header is no
        // attempt on any probe, though a characterization frame names one.
        header: header ? (isProbe ? header : { probeId: 0 }) : null,
        ok,
        estCols,
        colsOf: (id) => info.get(id)?.cols ?? 0,
      });
    },

    noteProfile(p) {
      profiles[p.blockSize ?? 0] = p;
      visible = true;
    },

    state(nowMs) {
      const rate = attemptRate(nowMs);
      const results = scorer ? scorer.results(rate) : [];
      const rows = results
        .filter((r) => r.bytesPerSecond !== null && info.has(r.probe.id))
        .sort((a, b) => b.bytesPerSecond - a.bytesPerSecond)
        .slice(0, TOP_ROWS)
        .map((r) => {
          const p = info.get(r.probe.id);
          return { id: r.probe.id, blockSize: p.blockSize, label: probeLabel(p.scheme, p.probeFps, p.probeStatic), readRate: r.readRate, attempts: r.attempts, bytesPerSecond: r.bytesPerSecond, partialGain: r.partialGain ?? null };
        });
      // Every probe seen, compact, for the debug report (rows is only the top few).
      const probes = results
        .filter((r) => info.has(r.probe.id))
        .sort((a, b) => a.probe.id - b.probe.id)
        .map((r) => {
          const p = info.get(r.probe.id);
          return {
            id: r.probe.id, blockSize: p.blockSize, label: probeLabel(p.scheme, p.probeFps, p.probeStatic), fps: p.probeFps ?? null,
            attempts: r.attempts, ok: r.ok, packets: r.packets ?? null, wholeFrames: r.wholeFrames ?? null,
            partialGain: r.partialGain ?? null, bytesPerSecond: r.bytesPerSecond ?? null,
          };
        });
      const rec = scorer ? scorer.recommend(rate) : null;
      const recInfo = rec && info.get(rec.probe.id);
      const recommendation = recInfo
        ? `Use block ${recInfo.blockSize}, ${schemeLabel(recInfo.scheme)}, ${formatFps(rec.fps)} frames per second. About ${kbps(rec.bytesPerSecond)} KB/s here.`
        : null;
      // The one-line form for the run panel's state word, once a whole loop has run.
      const best = recInfo && loopsDone > 0
        ? `Best: block ${recInfo.blockSize}, ${schemeLabel(recInfo.scheme)}, ${formatFps(rec.fps)} fps`
        : null;
      let statusLine = null;
      if (current) {
        const where = current.frameType === FRAME_TYPES.probe
          ? `Probe ${current.probeId} of ${probeCount}: block ${current.blockSize}, ${probeLabel(current.scheme, current.probeFps, current.probeStatic)}.`
          : `Measuring the camera at block ${current.blockSize}.`;
        const quiet = nowMs - currentAtMs >= QUIET_MS ? `No probe frames seen for ${Math.round((nowMs - currentAtMs) / 1000)} s. Last: ` : '';
        const done = loopsDone > 0 ? ` Loop ${loopsDone} done. ${recommendation ?? 'No setting reads reliably yet.'}` : '';
        statusLine = `${quiet}${where} Loop ${loopsDone + 1}, ${info.size} of ${probeCount} probes seen.${done}`;
      }
      return {
        visible,
        advice,
        angleKnown,
        profiles,
        statusLine,
        attemptRate: rate,
        seen: info.size,
        probeCount,
        rows,
        probes,
        recommendation,
        partialGain: rec?.partialGain ?? null,
        best,
      };
    },
  };
}

const round2 = (v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v ?? null);

/**
 * What the phone adds to its debug report: the status line, the camera
 * profiles without their patch details, the best probes and the
 * recommendation. Null until probe frames are seen.
 */
export function setupSummary(state) {
  if (!state.visible) return null;
  const profiles = {};
  for (const [block, p] of Object.entries(state.profiles)) {
    profiles[block] = p.measured
      ? {
        measured: true,
        luma: [1, 2, 4].map((s) => round2(p.luma[s])),
        chroma: [1, 2, 4].map((s) => round2(p.chroma[s])),
        cast: p.cast.map(round2),
        pitchPx: round2(p.pitchPx),
      }
      : { measured: false, reason: p.reason };
  }
  return {
    statusLine: state.statusLine,
    recommendation: state.recommendation,
    partialGain: round2(state.partialGain),
    seen: state.seen,
    probeCount: state.probeCount,
    attemptRate: round2(state.attemptRate),
    advice: state.advice,
    rows: state.rows.map((r) => ({ ...r, readRate: round2(r.readRate), partialGain: round2(r.partialGain), bytesPerSecond: Math.round(r.bytesPerSecond) })),
    probes: state.probes.map((p) => ({ ...p, partialGain: round2(p.partialGain), bytesPerSecond: p.bytesPerSecond === null ? null : Math.round(p.bytesPerSecond) })),
    profiles,
  };
}

// ---- drawing ----

const percent = (v) => (v === null || v === undefined ? '-' : `${Math.round(v * 100)}%`);

// One line per block size measured, largest first.
function profileText(profiles) {
  const blocks = Object.keys(profiles).map(Number).sort((a, b) => b - a);
  if (blocks.length === 0) return 'Camera profile: waiting for a characterization frame';
  const sizes = (o) => [1, 2, 4].map((s) => percent(o[s])).join(' / ');
  return blocks.map((b) => {
    const p = profiles[b];
    if (!p.measured) return `Block ${b}: not measured (${p.reason})`;
    return `Block ${b}: brightness detail ${sizes(p.luma)}, color detail ${sizes(p.chroma)} at 1 / 2 / 4 blocks; `
      + `cast red ${p.cast[0].toFixed(2)}, green ${p.cast[1].toFixed(2)}, blue ${p.cast[2].toFixed(2)}`;
  }).join('\n');
}

/**
 * Wires the panel to the page. Returns { onStatus(msg), reset(), summary(),
 * attachRunStatus(runStatus) } for the receiver. The run status gets the
 * one-line recommendation for the phone panel's state word.
 * @param {(id: string) => HTMLElement} $
 */
export function setupSetupCheck($) {
  let model = createSetupModel();
  let runStatus = null;
  const draw = () => {
    const s = model.state(performance.now());
    $('setup-check').hidden = !s.visible;
    runStatus?.noteRecommendation(s.best);
    if (!s.visible) return;
    const aim = s.advice.length ? s.advice.join('. ') : 'Aim is good';
    $('setup-aim').textContent = s.angleKnown ? aim : `${aim}. Angle unknown: the small marker is not found`;
    $('setup-profile').textContent = profileText(s.profiles);
    const progress = s.probeCount
      ? `Probes seen ${s.seen} of ${s.probeCount}, ${s.attemptRate.toFixed(1)} camera reads a second`
      : 'Waiting for probes';
    $('setup-progress').textContent = s.statusLine ? `${s.statusLine} ${progress}` : progress;
    const table = document.createElement('table');
    const head = table.createTHead().insertRow();
    for (const h of ['Block', 'Colors', 'Read rate', 'Bytes a second']) {
      const th = document.createElement('th');
      th.textContent = h;
      head.appendChild(th);
    }
    const body = table.createTBody();
    for (const r of s.rows) {
      const tr = body.insertRow();
      for (const text of [r.blockSize, r.label, `${percent(r.readRate)} of ${r.attempts}`, Math.round(r.bytesPerSecond)]) {
        tr.insertCell().textContent = String(text);
      }
    }
    $('setup-table').replaceChildren(table);
    $('setup-recommendation').textContent = s.recommendation ?? 'No setting reads reliably yet';
  };
  return {
    onStatus(msg) {
      if (msg.profile) model.noteProfile(msg.profile);
      if (msg.attempt) model.noteAttempt({ ...msg.attempt, atMs: performance.now() });
      if (msg.attempt || msg.profile) draw();
    },
    summary: () => setupSummary(model.state(performance.now())),
    attachRunStatus(next) { runStatus = next; },
    reset() {
      model = createSetupModel();
      $('setup-check').hidden = true;
    },
  };
}
