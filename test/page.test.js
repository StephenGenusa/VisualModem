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
  const dev = element('grp-dev');
  assert.match(dev, /id="tune"/);
  assert.match(dev, /id="run-tests"/);
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
  for (const id of ['block-size', 'scheme', 'levels', 'fountain', 'parity', 'fps', 'white', 'password', 'probe-loops']) {
    const re = new RegExp(`<p class="help" id="${id}-help">[\\s\\S]*?</p>\\s*<details class="more">\\s*<summary>`);
    assert.ok(re.test(html), `a More section follows #${id}-help`);
  }
});

test('group descriptions', () => {
  const lines = {
    'grp-send': 'Moves your message or file to the phone by light. No network needed.',
    'grp-probe': 'For a new TV, room or phone. No network needed: the phone measures by light and recommends a block size and colors.',
    'grp-dev': 'Measurement runs we do together. The phone reports results to the computer over the network; payload still goes by light.',
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
    probe: 'Shows test patterns at each block size, then a frame rate sweep. Bounded by Loops.',
    tune: 'Tries settings one after another and sets block size and levels to the best.',
    'run-tests': 'Auto tune at each phone camera size, then times a file at several frame rates. Produces a report.',
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
