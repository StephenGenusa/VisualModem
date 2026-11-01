import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readImage } from '../src/testutil/image.js';
import { decodeCameraFrame } from '../src/picture/reader.js';
import { Collector } from '../src/core/transmission.js';
import { decodePayload } from '../src/core/payload.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'photos');
const IMAGE = /\.(jpe?g|png)$/i;

function groupName(file) {
  return file.replace(IMAGE, '').replace(/-\d+$/, '');
}

const files = existsSync(dir) ? readdirSync(dir).filter((f) => IMAGE.test(f)).sort() : [];
const groups = new Map();
for (const f of files) {
  const g = groupName(f);
  if (!groups.has(g)) groups.set(g, []);
  groups.get(g).push(f);
}

if (groups.size === 0) {
  test('no photos', () => {
    console.log('no photos in test/photos');
  });
}

for (const [group, photos] of groups) {
  const expectedPath = join(dir, `${group}.expected`);
  if (!existsSync(expectedPath)) {
    test(`photo group ${group}`, { skip: 'no .expected file' }, () => {});
    console.log(`skipping ${group}: no ${group}.expected`);
    continue;
  }
  test(`photo group ${group}`, async () => {
    const collector = new Collector();
    let first = null;
    for (const f of photos) {
      const { frame } = decodeCameraFrame(readImage(join(dir, f)));
      assert.ok(frame, `${f}: no frame decoded`);
      const id = frame.header.txId;
      if (!first) first = { id, file: f };
      assert.equal(id, first.id, `${f}: transmission id 0x${id.toString(16)} differs from 0x${first.id.toString(16)} seen in ${first.file}`);
      collector.add(frame);
    }
    const status = collector.status();
    assert.ok(status.complete, `incomplete: ${JSON.stringify(status)}`);
    const record = await decodePayload(collector.stream());
    assert.deepEqual(record.data, new Uint8Array(readFileSync(expectedPath)));
  });
}
