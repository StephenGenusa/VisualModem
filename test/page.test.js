import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

// The Send page markup checked as text: no DOM library, regular expressions only.
const webDir = new URL('../web/', import.meta.url);
const html = readFileSync(new URL('index.html', webDir), 'utf8');
const scripts = readdirSync(webDir).filter((f) => f.endsWith('.js'))
  .map((f) => ({ name: f, text: readFileSync(new URL(f, webDir), 'utf8') }));

// The markup from the tag that holds id="<id>" to its matching closing tag.
function element(id) {
  const at = html.indexOf(`id="${id}"`);
  assert.ok(at >= 0, `id="${id}" exists`);
  const start = html.lastIndexOf('<', at);
  const tag = /^<(\w+)/.exec(html.slice(start))[1];
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'g');
  re.lastIndex = start;
  let depth = 0;
  for (let m; (m = re.exec(html));) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index + m[0].length);
  }
  assert.fail(`no closing tag for #${id}`);
}

function openingTag(id) {
  const block = element(id);
  return block.slice(0, block.indexOf('>') + 1);
}

const text = (markup) => markup.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

test('every id the scripts look up exists', () => {
  const ids = new Set();
  for (const { text: js } of scripts) {
    for (const m of js.matchAll(/(?:\$|getElementById)\(\s*'([^']+)'\s*\)/g)) ids.add(m[1]);
  }
  assert.ok(ids.size > 20, 'found the lookups');
  for (const id of ids) {
    const count = html.split(`id="${id}"`).length - 1;
    assert.equal(count, 1, `id="${id}" appears once in index.html`);
  }
});

test('actions sit in their groups', () => {
  const send = element('grp-send');
  assert.match(send, /^<section\b/);
  assert.match(send, /id="start"/);
  assert.match(send, /id="save"/);
  const probe = element('grp-probe');
  assert.match(probe, /^<section\b/);
  assert.match(probe, /id="probe"/);
  assert.match(probe, /id="probe-loops"/);
  assert.doesNotMatch(probe, /id="refine"/);
  const refine = element('grp-refine');
  assert.match(refine, /id="refine"/);
  assert.match(refine, /id="refine-limit"/);
  assert.match(refine, /id="refine-status"/);
  assert.match(refine, /id="refine-table"/);
  const dev = element('grp-dev');
  assert.match(dev, /<summary[^>]*>[^]*?<\/span>Measure<span/);
  const open = openingTag('grp-dev');
  assert.match(open, /^<details\b/);
  assert.doesNotMatch(open, /\sopen\b/);
});

test('every Send control has a help line', () => {
  const send = element('send');
  const controls = [...send.matchAll(/<(input|select|textarea)\b[^>]*>/g)].map((m) => m[0]);
  assert.ok(controls.length >= 15, 'found the controls');
  for (const tag of controls) {
    const id = /\sid="([^"]+)"/.exec(tag)?.[1];
    assert.ok(id, `control has an id: ${tag}`);
    assert.match(tag, new RegExp(`aria-describedby="${id}-help"`), `#${id} is described by its help line`);
    const help = new RegExp(`<p class="help" id="${id}-help">([\\s\\S]*?)</p>`).exec(send);
    assert.ok(help, `#${id}-help exists inside #send`);
    assert.ok(text(help[1]).length >= 20, `#${id}-help has at least 20 characters`);
  }
});

test('the main controls have More sections', () => {
  for (const id of ['block-size', 'scheme', 'levels', 'fountain', 'parity', 'fps', 'white', 'password', 'probe-loops', 'refine-limit']) {
    const re = new RegExp(`<p class="help" id="${id}-help">[\\s\\S]*?</p>\\s*<details class="more">\\s*<summary>`);
    assert.ok(re.test(html), `a More section follows #${id}-help`);
  }
});

test('group descriptions', () => {
  const lines = {
    'grp-send': 'Moves your message or file to the phone by light. No network needed.',
    'grp-probe': 'For a new TV, room or phone. No network needed: the phone measures by light and recommends a block size and colors.',
    'grp-refine': 'Works out the best settings by itself in the time you choose. The frames still go by light; only the phone\'s counts use the network.',
    'grp-dev': 'Measurement runs where the phone reports to the computer over the network. The payload still goes by light.',
  };
  for (const [id, line] of Object.entries(lines)) {
    const desc = /<p class="grp-desc">([\s\S]*?)<\/p>/.exec(element(id));
    assert.ok(desc, `#${id} has a p.grp-desc`);
    assert.equal(text(desc[1]), line);
  }
});

test('every button has its approved line', () => {
  const lines = {
    start: 'Shows the file full screen and loops until you press Stop. Phones can join at any time.',
    save: 'Writes the frames as PNG files instead of showing them.',
    probe: 'Shows test patterns at each block size, then a frame rate sweep and a parity sweep. One loop takes about 230 seconds on a 4K screen. Bounded by Loops.',
    refine: 'Tests one setting after another, the Send page settings first, then sets this page to the best it found. Leave it running: the phone counts what it reads.',
  };
  for (const [id, line] of Object.entries(lines)) {
    const help = new RegExp(`<p class="help" id="${id}-help">([\\s\\S]*?)</p>`).exec(html);
    assert.ok(help, `#${id}-help exists`);
    assert.equal(text(help[1]), line);
    assert.match(openingTag(id), new RegExp(`aria-describedby="${id}-help"`));
  }
});

test('the run view comes first on Receive', () => {
  const receive = element('receive');
  const inner = receive.slice(receive.indexOf('>') + 1);
  assert.match(inner, /^\s*<div class="rx-run">/, 'the first element inside #receive is div.rx-run');
  const start = inner.indexOf('<div class="rx-run">');
  // The run view ends at its matching </div>.
  const re = /<(\/?)div\b[^>]*>/g;
  re.lastIndex = start;
  let depth = 0, run = null;
  for (let m; (m = re.exec(inner));) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) { run = inner.slice(start, m.index + m[0].length); break; }
  }
  assert.ok(run, 'div.rx-run closes');
  assert.match(run, /class="camera-box"/);
  assert.match(run, /class="rx-panel"/);
  const panel = run.slice(run.indexOf('class="rx-panel"'));
  let last = -1;
  for (const id of ['rx-read', 'rx-progress', 'rx-progress-text', 'rx-time', 'rx-rate', 'rx-reason', 'rx-hint', 'rx-counts']) {
    const at = panel.indexOf(`id="${id}"`);
    assert.ok(at > last, `#${id} is in the panel after the one before it`);
    last = at;
  }
});

test('every Receive control has a help line', () => {
  const receive = element('receive');
  const controls = [...receive.matchAll(/<(input|select)\b[^>]*>/g)].map((m) => m[0]);
  assert.ok(controls.length >= 3, 'found the controls');
  for (const tag of controls) {
    const id = /\sid="([^"]+)"/.exec(tag)?.[1];
    assert.ok(id, `control has an id: ${tag}`);
    assert.match(tag, new RegExp(`aria-describedby="${id}-help"`), `#${id} is described by its help line`);
    const help = new RegExp(`<p class="help" id="${id}-help">([\\s\\S]*?)</p>`).exec(receive);
    assert.ok(help, `#${id}-help exists inside #receive`);
    assert.ok(text(help[1]).length >= 20, `#${id}-help has at least 20 characters`);
  }
});

test('the run panel details carry the grid line', () => {
  const details = /<p class="rx-details">([\s\S]*?)<\/p>/.exec(element('receive'));
  assert.ok(details, 'p.rx-details exists');
  assert.match(details[1], /<span id="rx-grid"><\/span>/);
});

test('the message box starts with the default saying', () => {
  const box = /<textarea id="message"[^>]*>([\s\S]*?)<\/textarea>/.exec(html);
  assert.ok(box, 'textarea#message exists');
  assert.equal(
    box[1],
    "That's one small step for a photon, one giant leap for bandwidth. Mr. Watson — come here — I want to see you. Can you hear me now? Houston, we have a problem. LO. just setting up my twttr.",
  );
});

test('Refine shows only with the capture server, and its limits are 1, 3, 5 and 30 minutes with 3 selected', () => {
  const open = openingTag('grp-refine');
  assert.match(open, /\shidden\b/);
  assert.match(open, /^<section\b/);
  assert.match(element('grp-refine'), /<span class="tag">Capture server<\/span>/);
  const select = element('refine-limit');
  const options = [...select.matchAll(/<option value="(\d+)"( selected)?>/g)];
  assert.deepEqual(options.map((m) => m[1]), ['1', '3', '5', '30']);
  assert.deepEqual(options.filter((m) => m[2]).map((m) => m[1]), ['3']);
  const refine = scripts.find((f) => f.name === 'refine.js').text;
  assert.match(refine, /if \(!captureOn\) return/);
  assert.match(refine, /\$\('grp-refine'\)\.hidden = false/);
});

test('Probe stays free of the network', () => {
  const probe = scripts.find((f) => f.name === 'probe.js').text;
  assert.doesNotMatch(probe, /fetch\(|tune\.js|refine\.js|\/session|\/feedback/);
  assert.match(element('grp-probe'), /<span class="tag">No network<\/span>/);
  const sender = scripts.find((f) => f.name === 'sender.js').text;
  assert.match(sender, /\n  setupProbe\(/, 'wired whether or not the server answers');
});

test('the help says each limit spreads its short tests across the range, then tunes candidates, and how ties go', () => {
  const words = text(element('grp-refine'));
  assert.match(words, /across the whole range of settings/);
  assert.match(words, /up to 6 candidates/);
  assert.match(words, /highest parity wins/);
  assert.match(words, /one phone/i);
  assert.match(words, /provisional/);
  assert.match(words, /lost its aim/);
  assert.match(words, /built-in list of known good settings/);
});

test('applying a result can set every setting Refine tries', () => {
  const sender = scripts.find((f) => f.name === 'sender.js').text;
  const apply = /function applyScreenSettings[\s\S]*?\n}\n/.exec(sender)[0];
  for (const name of ['blockSize', 'parity', 'fps', 'white']) assert.match(apply, new RegExp(`patch\\.${name} !== undefined`), name);
});

test('the Send page has a Choose settings menu first in Screen settings, with help', () => {
  const fieldset = /<fieldset>\s*<legend>Screen settings<\/legend>([\s\S]*?)<\/fieldset>/.exec(html);
  assert.ok(fieldset, 'the Screen settings fieldset exists');
  const first = /<(input|select|textarea)\b[^>]*>/.exec(fieldset[1]);
  assert.match(first[0], /^<select id="settings-choice"/, 'the menu is the first control');
  assert.match(fieldset[1], /^\s*<label for="settings-choice">Choose settings<\/label>/);
  assert.match(openingTag('settings-choice'), /aria-describedby="settings-choice-help"/);
  const help = /<p class="help" id="settings-choice-help">([\s\S]*?)<\/p>/.exec(fieldset[1]);
  assert.ok(help, 'the menu has a help line');
  assert.match(text(help[1]), /Current/);
  assert.match(text(help[1]), /Safe default/);
  // It says exactly what is set, when, and when the menu is off.
  assert.match(text(help[1]), /block size, color scheme, levels, parity, frame rate and white/);
  assert.match(text(help[1]), /Apply/);
  assert.match(text(help[1]), /Off while the screen shows frames or Refine runs/);
  assert.doesNotMatch(text(help[1]), /every setting/);
});

test('an Apply button beside the menu sets the line picked, off until a line other than Current is picked', () => {
  const tag = openingTag('settings-apply');
  assert.match(tag, /^<button id="settings-apply" type="button"/);
  assert.match(tag, /disabled/);
  assert.match(tag, /aria-describedby="settings-choice-help"/);
});

test('the note for no network is in the Probe help, which shows with no capture server', () => {
  const words = text(element('grp-probe'));
  assert.match(words, /no network/i);
  assert.match(words, /read Probe's line on the phone and set it by hand/);
  assert.match(words, /Safe default/);
});

test('the Refine help gives the field notes', () => {
  const words = text(element('grp-refine'));
  assert.match(words, /one phone at a time/i);
  assert.match(words, /steady/);
  assert.match(words, /stand/);
  assert.match(words, /in the light the audience will have/);
  assert.match(words, /3 or 5 minutes before a session/);
  assert.match(words, /30 minutes when the light will change/);
});

test('the Measure panel has no Auto tune or Run tests', () => {
  assert.doesNotMatch(html, /id="tune"/);
  assert.doesNotMatch(html, /id="run-tests"/);
  assert.doesNotMatch(html, /Auto tune|Run tests|Development and testing/);
});

test('no web script imports a removed module', () => {
  for (const { name, text: code } of scripts) {
    for (const gone of ['runner.js', 'tune/tuner.js', 'tune/trialpayload.js', 'tune/throughput.js']) {
      assert.ok(!code.includes(gone), `${name} mentions ${gone}`);
    }
  }
});

test('the Measure panel holds Timed runs: runs per setting, Compare with, the button, help and the report', () => {
  const dev = element('grp-dev');
  for (const id of ['timed', 'timed-count', 'timed-other', 'timed-status', 'timed-report']) assert.match(dev, new RegExp(`id="${id}"`), id);
  assert.match(openingTag('timed'), /^<button id="timed" type="button"/);
  assert.match(openingTag('timed'), /aria-describedby="timed-help"/);
  assert.match(element('timed'), />Timed runs</);
  const count = element('timed-count');
  const options = [...count.matchAll(/<option value="(\d+)"( selected)?>/g)];
  assert.deepEqual(options.map((m) => m[1]), ['3', '5', '10']);
  assert.deepEqual(options.filter((m) => m[2]).map((m) => m[1]), ['5']);
  assert.match(dev, /<label for="timed-count"[^>]*>Runs per setting<\/label>/);
  assert.match(dev, /<label for="timed-other"[^>]*>Compare with<\/label>/);
  assert.match(element('timed-other'), /<option value="none">Nothing<\/option>/);
  const words = text(dev);
  assert.doesNotMatch(words, /10 to 20 seconds/, 'no run length the code does not set');
  assert.match(words, /cut off after 3 minutes/);
  assert.match(words, /fits in one frame cannot be timed/);
  assert.match(words, /Receive page/);
  assert.match(words, /aimed/);
  assert.match(words, /keeps its screen on and shows which run is on/);
  assert.match(words, /is not timed/);
  assert.match(words, /Student t test/);
  assert.match(words, /Only progress, the phone's reports and the run word go over the network/);
  const timed = scripts.find((f) => f.name === 'timedruns.js').text;
  assert.match(timed, /if \(!capture\) return/);
  const sender = scripts.find((f) => f.name === 'sender.js').text;
  assert.match(sender, /setupTimedRuns\(/);
});
