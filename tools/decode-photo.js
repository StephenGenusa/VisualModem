// Node command line tool: decode photos of a visual modem screen. No DOM.
// Usage: node tools/decode-photo.js [--password <pw>] <image> [more images...]
import { writeFileSync } from 'node:fs';
import { readImage } from '../src/testutil/image.js';
import { decodeCameraFrame } from '../src/picture/reader.js';
import { readImageFrame } from '../src/picture/filereader.js';
import { Collector } from '../src/core/transmission.js';
import { decodePayload } from '../src/core/payload.js';

const args = process.argv.slice(2);
let password;
const images = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--password') password = args[++i];
  else images.push(args[i]);
}
if (images.length === 0 || (args.includes('--password') && password === undefined)) {
  console.error('Usage: node tools/decode-photo.js [--password <pw>] <image> [more images...]');
  process.exit(2);
}

const collector = new Collector();
let hadErrors = false;
let first = null; // first parsed frame's transmission id and file

function addFrame(frame, path) {
  const id = frame.header.txId;
  if (!first) first = { id, path };
  if (id !== first.id) {
    hadErrors = true;
    console.log(`  ${path}: transmission id 0x${id.toString(16)} differs from 0x${first.id.toString(16)} seen in ${first.path}`);
    return;
  }
  collector.add(frame);
}

for (const path of images) {
  console.log(`== ${path}`);
  let img;
  try {
    img = readImage(path);
  } catch (err) {
    console.log(`  cannot read image: ${err.message}`);
    hadErrors = true;
    continue;
  }
  try {
    const { read, frame } = decodeCameraFrame(img);
    if (read.markersFound) {
      console.log('  markers: found');
      if (read.cols !== undefined) {
        console.log(`  grid: ${read.cols} x ${read.rows}`);
        console.log(`  levels: ${read.levels}`);
        console.log(`  pitch: ${read.pitch.toFixed(1)} px`);
        console.log(`  margin: ${Math.round(read.margin * 100)}%`);
        console.log(`  parity: ${read.parity}`);
      } else {
        console.log(`  grid: not read (${read.reason})`);
      }
    } else {
      console.log(`  markers: not found (${read.reason})`);
      const file = readImageFrame(img);
      if (file) {
        const h = file.frame.header;
        console.log(`  file path: ${file.blockSize} px blocks, ${file.levels} levels, frame ${h.index + 1}/${h.count}`);
        addFrame(file.frame, path);
        continue;
      }
      console.log('  file path: no frame');
      continue;
    }
    if (frame) {
      console.log(`  frame: ${frame.header.index + 1}/${frame.header.count}, ${frame.corrected} bytes corrected`);
      addFrame(frame, path);
    } else {
      console.log(read.cols === undefined ? '  frame: grid not read' : '  frame: CRC or RS failed');
      collector.noteFailure();
    }
  } catch (err) {
    console.log(`  error: ${err.message}`);
    hadErrors = true;
  }
}

const status = collector.status();
console.log(`collected ${status.have} of ${status.count} frames (ok ${status.crcPass}, failed ${status.crcFail})`);
if (!status.complete) process.exit(1);
if (hadErrors) console.log('some images failed, exit code will be 1');

let record;
try {
  record = await decodePayload(collector.stream(), password);
} catch (err) {
  console.log(err.code === 'NEEDS_PASSWORD' ? 'encrypted, pass --password' : `payload error: ${err.message}`);
  process.exit(1);
}
console.log(`type: ${record.type}`);
console.log(`name: ${record.name}`);
console.log(`mime: ${record.mime}`);
console.log(`size: ${record.data.length} bytes`);
if (record.type === 'message') console.log(`message: ${new TextDecoder().decode(record.data)}`);
const out = `${images[0]}.decoded`;
writeFileSync(out, record.data);
console.log(`wrote ${out}`);
if (hadErrors) process.exit(1);
