// The list behind the Send page's "Choose settings" menu: what is known about
// good settings for this screen, in plain words. No DOM and no storage here.

import { describeSettings } from './refineloop.js';
import { candidateKey } from './search.js';
import { SCHEME_CHOICES } from '../core/scheme.js';

// Levels matter only for the color cube; other schemes ignore them.
const schemeOf = (s) => s.scheme ?? 'cube';
const levelsOf = (s) => (schemeOf(s) === 'cube' ? s.levels ?? 2 : 2);
const candidateKeyOf = (s) => `${candidateKey(s)}/${schemeOf(s)}/${levelsOf(s)}`;

const kb = (bytesPerSecond) => (bytesPerSecond / 1000).toFixed(1);

/**
 * The settings in words. The scheme is named as the Scheme control names it,
 * and only when not the color cube at 2 levels; levels show only for the cube.
 */
function words(settings) {
  const scheme = schemeOf(settings);
  const levels = levelsOf(settings);
  let out = describeSettings(settings);
  if (scheme !== 'cube') out += `, ${SCHEME_CHOICES.find((c) => c.id === scheme)?.label ?? scheme}`;
  else if (levels !== 2) out += `, Color cube, ${levels} levels`;
  return out;
}

const plain = (s) => {
  const out = { blockSize: s.blockSize, parity: s.parity, fps: s.fps, white: s.white };
  if (s.levels !== undefined) out.levels = s.levels;
  if (s.scheme !== undefined) out.scheme = s.scheme;
  return out;
};

const ago = (ms) => {
  const min = Math.max(0, Math.round(ms / 60000));
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
};

/**
 * @param {{ current: object, defaults: object, last: object | null, probe: { settings: object, bytesPerSecond: number, ageMs: number } | null,
 *   saved: object[], cap: number }} p last is loadLastResult's result; saved is loadWinners' list; cap is the largest block the screen holds
 * @returns {Array<{ id: string, label: string, settings: object }>} the current settings first, always; a repeated setting keeps its first place
 */
export function buildChoices({ current, defaults, last, probe, timed = [], saved, cap }) {
  const list = [{ id: 'current', label: `Current: ${words(current)}`, settings: plain(current) }];
  const seen = new Set([candidateKeyOf(current)]);
  const add = (id, name, settings, speed, rough = false) => {
    if (!settings || !(settings.blockSize <= cap)) return;
    const key = candidateKeyOf(settings);
    if (seen.has(key)) return;
    seen.add(key);
    const label = `${name}${speed ? ` - ${speed}` : ''} (${words(settings)})${rough ? ' (rough)' : ''}`;
    list.push({ id, label, settings: plain(settings) });
  };
  if (last) {
    const by = last.byConditions;
    add('refine-winner', 'Fastest here', last.winner?.settings, last.winner && `${kb(last.winner.mean)} KB/s`);
    add('refine-tie', 'Glare-tolerant tie', last.tie?.settings, last.tie && `${kb(last.tie.mean)} KB/s`);
    add('refine-steady', 'Steadiest when the light changed', by?.steady?.settings, by?.steady && `${kb(by.steady.before)} then ${kb(by.steady.after)} KB/s`, true);
    add('refine-before', 'Fastest before the light changed', by?.before?.settings, by?.before && `${kb(by.before.mean)} KB/s`, true);
    add('refine-after', 'Fastest after the light changed', by?.after?.settings, by?.after && `${kb(by.after.mean)} KB/s`, true);
  }
  if (probe) add('probe', "Probe's best", probe.settings, `${kb(probe.bytesPerSecond)} KB/s, ${ago(probe.ageMs)}`);
  (timed ?? []).forEach((t, i) => add(`timed-${i}`, `Timed${t.savedOn ? `, ${t.savedOn}` : ''}`, t.settings, `${(t.mean / 1000).toFixed(1)} s over ${t.runs} ${t.runs === 1 ? 'run' : 'runs'}`));
  (saved ?? []).forEach((w, i) => add(`saved-${i}`, `Earlier winner${w.savedOn ? `, ${w.savedOn}` : ''}`, w, `${kb(w.mean)} KB/s`));
  add('default', 'Safe default', defaults);
  // A line listed earlier with the safe default's settings stands in for it, and says so.
  const twin = list.find((c) => c.id !== 'default' && candidateKeyOf(c.settings) === candidateKeyOf(defaults));
  if (twin) twin.label += ', the safe default';
  return list;
}
