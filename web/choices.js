// The Send page's "Choose settings" menu: the current settings first, then what
// is known to work on this screen (Refine's last result, Probe's best from the
// phone, earlier winners) and the safe default. Picking a line only selects it;
// the Apply button sets it, so moving through the menu with the arrow keys sets
// nothing. The list itself comes from buildChoices (src/optimize/choices.js).
import { buildChoices } from '../src/optimize/choices.js';
import { loadLastResult, loadWinners } from '../src/optimize/refineloop.js';
import { loadTimed } from '../src/optimize/timedruns.js';
import { computeReadout } from './readout.js';
import { SCREEN_DEFAULTS } from './settings.js';
import { createPoller } from './tune.js';
import { isStageOpen, onStageClosed, onStageOpened } from './stage.js';

export const PROBE_POLL_MS = 2000;
const $ = (id) => document.getElementById(id);

const positive = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
const validBest = (b) => Boolean(b) && positive(b.blockSize) && Number.isFinite(b.parity) && b.parity >= 0
  && positive(b.fps) && positive(b.white) && positive(b.bytesPerSecond);
const BEST_FIELDS = ['blockSize', 'scheme', 'levels', 'parity', 'fps', 'white', 'bytesPerSecond'];
const contentOf = (b) => (validBest(b) ? JSON.stringify(BEST_FIELDS.map((f) => b[f])) : null);

/**
 * The menu's lines for these settings and this screen: the current settings
 * first, then what this browser keeps for the screen and Probe's best, if any.
 * @param {{ hooks: { getSettings: () => object, displayPixels: () => object }, storage: Storage | null, screenKey: string,
 *   probe?: { settings: object, bytesPerSecond: number, ageMs: number } | null }} p
 * @returns {Array<{ id: string, label: string, settings: object }>}
 */
export function choicesFor({ hooks, storage, screenKey, probe = null }) {
  const current = hooks.getSettings();
  const { cap } = computeReadout({ ...hooks.displayPixels(), ...current }, 0);
  return buildChoices({
    current,
    defaults: SCREEN_DEFAULTS,
    last: storage ? loadLastResult(storage, screenKey) : null,
    probe,
    timed: storage ? loadTimed(storage, screenKey) : [],
    saved: storage ? loadWinners(storage, screenKey) : [],
    cap,
  });
}

/**
 * Sets up the menu.
 * @param {{ hooks: { getSettings: () => object, setSettings: (patch: object) => void, displayPixels: () => object },
 *   storage: Storage | null, screenKey: string | (() => string), capture: boolean,
 *   every?: (fn: () => Promise<void>, ms: number) => void, now?: () => number }} p capture says the capture server is on; every runs the poll
 * @returns {{ redraw: () => void, setBusy: (busy: boolean) => void, entries: () => Array<{ id: string, label: string, settings: object }>, ready: Promise<void> }}
 *   entries gives the menu's lines as they are now; ready settles once the reports already held are read
 */
export function setupChoices({ hooks, storage, screenKey, capture, every = (fn, ms) => setInterval(fn, ms), now = () => performance.now() }) {
  const menu = $('settings-choice');
  const apply = $('settings-apply');
  const keyOf = () => (typeof screenKey === 'function' ? screenKey() : screenKey);
  let busy = false;
  let probe = null; // { content, settings, bytesPerSecond, atMs }: Probe's best, new to this page; atMs is when it was first seen
  let list = [];
  let stale = false; // a redraw waits while the menu has focus

  const build = () => choicesFor({
    hooks, storage, screenKey: keyOf(),
    probe: probe && { settings: probe.settings, bytesPerSecond: probe.bytesPerSecond, ageMs: now() - probe.atMs },
  });

  const off = () => busy || isStageOpen();
  const setDisabled = () => {
    menu.disabled = off();
    if (apply) apply.disabled = off() || menu.value === 'current';
  };
  // keep: the line picked stays picked when a line with the same words is still there,
  // so Apply always sets what the operator read.
  const draw = (next, keep = false) => {
    const picked = keep ? list.find((c) => c.id === menu.value)?.label : undefined;
    list = next;
    stale = false;
    menu.replaceChildren(...list.map(({ id, label }) => {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = label;
      return option;
    }));
    menu.value = list.find((c) => c.label === picked)?.id ?? 'current';
    setDisabled();
  };
  const redraw = () => draw(build());

  menu.addEventListener('change', setDisabled);
  menu.addEventListener('blur', () => { if (stale) draw(build(), true); });
  apply?.addEventListener('click', () => {
    const choice = list.find((c) => c.id === menu.value);
    if (!off() && choice && choice.id !== 'current') hooks.setSettings({ ...choice.settings });
    redraw();
  });
  onStageOpened(redraw);
  onStageClosed(redraw);

  // Probe's best is offered only when it is new to this page. The phone keeps
  // reporting the best it holds, so a report arriving after the page loaded
  // proves nothing. Every best in the reports the server already held when the
  // page loaded (or, with none held, in the first report after) is known and is
  // never offered. A best whose settings or speed differ from all of those is
  // new: it is offered, aged from the poll that first showed it. A new Probe run
  // that gives exactly a known best's settings and speed is not offered.
  let known = null; // a Set of best contents, once the first report is read
  const take = (entries, atLoad = false) => {
    for (const e of entries) {
      const content = contentOf(e.probeBest);
      if (atLoad || known === null) {
        known ??= new Set();
        if (content) known.add(content);
      } else if (content && !known.has(content) && content !== probe?.content) {
        const { bytesPerSecond, ...settings } = e.probeBest;
        probe = { content, settings, bytesPerSecond, atMs: now() };
      }
    }
  };

  const poller = createPoller();
  let polling = false;
  const tick = async () => {
    if (polling || location.hash === '#receive') return;
    polling = true;
    const entries = await poller.poll(); // never throws: an unreachable server gives none
    polling = false;
    take(entries);
    // Redrawn only when a line changes, and never while the menu has focus: an
    // open menu is left alone and redrawn when it loses focus.
    const next = build();
    if (next.map((c) => c.label).join('\n') === list.map((c) => c.label).join('\n')) return;
    if (document.activeElement === menu) stale = true;
    else draw(next, true);
  };

  redraw();
  const ready = capture ? poller.poll().then((held) => { take(held, true); every(tick, PROBE_POLL_MS); }) : Promise.resolve();
  return { redraw, setBusy(value) { busy = value; setDisabled(); }, entries: build, ready };
}
