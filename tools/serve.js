// The project web server. Serves the app (web and src) over HTTPS on every
// network interface, using certs/cert.pem and certs/key.pem.
//
// Usage: node tools/serve.js [--port 8443] [--capture]
//
// --capture turns on a debug endpoint: the receiver shows a "Send camera frame
// to computer" button, and the frames it posts are saved as PNG files in
// test/photos, where tools/decode-photo.js can read them. The receiver also
// posts a debug summary once a second, appended to test/photos/debug.jsonl.
// It is off by default.
import { createServer } from 'node:https';
import { readFileSync, createReadStream, statSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFeedbackBuffer } from './feedback.js';
import { createSession } from './session.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVED = ['web', 'src']; // only these folders are reachable; never certs or the rest of the repo
const CAPTURE_DIR = join(ROOT, 'test', 'photos');
const MAX_CAPTURE_BYTES = 30 * 1024 * 1024;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const args = process.argv.slice(2);
const port = Number(args.includes('--port') ? args[args.indexOf('--port') + 1] : 8443);
const capture = args.includes('--capture');
const feedback = createFeedbackBuffer(); // receiver reports, polled by auto tune and the test runner
const session = createSession(); // the test on screen and the camera size the phone should use

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

// Maps a URL path to a file inside a served folder, or null.
function resolveFile(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  let rel = normalize(decoded).replace(/^[/\\]+/, '');
  if (rel === '' ) return null;
  const top = rel.split(/[/\\]/)[0];
  if (!SERVED.includes(top)) return null;
  let file = resolve(ROOT, rel);
  if (!file.startsWith(join(ROOT, top) + sep) && file !== join(ROOT, top)) return null;
  try {
    if (statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!statSync(file).isFile()) return null;
  } catch {
    return null;
  }
  return file;
}

function serveStatic(req, res, path) {
  if (path === '/') {
    res.writeHead(302, { Location: '/web/' });
    res.end();
    return;
  }
  // A folder without its trailing slash would break relative links.
  if (SERVED.includes(path.slice(1))) {
    res.writeHead(301, { Location: path + '/' });
    res.end();
    return;
  }
  const file = resolveFile(path);
  if (!file) return send(res, 404, 'Not found');
  res.writeHead(200, {
    'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}

function receiveCapture(req, res) {
  if (!capture) return send(res, 404, 'Not found');
  const chunks = [];
  let size = 0;
  let tooBig = false;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_CAPTURE_BYTES) {
      tooBig = true;
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (tooBig) return;
    const body = Buffer.concat(chunks);
    const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (!body.subarray(0, 8).equals(PNG_SIGNATURE)) return send(res, 400, 'Expected a PNG');
    mkdirSync(CAPTURE_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const name = `capture-${stamp}.png`;
    writeFileSync(join(CAPTURE_DIR, name), body);
    console.log(`Saved test/photos/${name} (${body.length} bytes) from ${req.socket.remoteAddress}`);
    send(res, 200, JSON.stringify({ saved: name }), 'application/json');
  });
}

const MAX_DEBUG_BYTES = 256 * 1024;
const DEBUG_LOG = join(CAPTURE_DIR, 'debug.jsonl');

function readJson(req, res, done) {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > MAX_DEBUG_BYTES) req.destroy();
  });
  req.on('end', () => {
    let value;
    try {
      value = JSON.parse(body);
    } catch {
      return send(res, 400, 'Expected JSON');
    }
    done(value);
  });
}

function receiveDebug(req, res) {
  if (!capture) return send(res, 404, 'Not found');
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > MAX_DEBUG_BYTES) req.destroy();
  });
  req.on('end', () => {
    let entry;
    try {
      entry = JSON.parse(body);
    } catch {
      return send(res, 400, 'Expected JSON');
    }
    mkdirSync(CAPTURE_DIR, { recursive: true });
    appendFileSync(DEBUG_LOG, JSON.stringify({ time: new Date().toISOString(), from: req.socket.remoteAddress, ...entry }) + '\n');
    if (entry && entry.source === 'receiver') {
      feedback.add(entry, Date.now());
      return send(res, 200, JSON.stringify(session.get()), 'application/json'); // the phone's instructions
    }
    send(res, 204, '');
  });
}

function handle(req, res) {
  const path = new URL(req.url, 'https://localhost').pathname;
  if (path !== '/debug' && path !== '/feedback') console.log(`${req.socket.remoteAddress} ${req.method} ${path}`);
  if (path === '/session') {
    if (!capture) return send(res, 404, 'Not found');
    if (req.method !== 'POST') return send(res, 405, 'Method not allowed');
    return readJson(req, res, (patch) => send(res, 200, JSON.stringify(session.set(patch)), 'application/json'));
  }
  if (path === '/feedback') {
    if (!capture) return send(res, 404, 'Not found');
    if (req.method !== 'GET') return send(res, 405, 'Method not allowed');
    const after = Number(new URL(req.url, 'https://localhost').searchParams.get('after')) || 0;
    return send(res, 200, JSON.stringify(feedback.since(after)), 'application/json');
  }
  if (path === '/debug') {
    if (req.method === 'POST') return receiveDebug(req, res);
    return send(res, 405, 'Method not allowed');
  }
  if (path === '/capture') {
    if (req.method === 'GET') return send(res, 200, JSON.stringify({ enabled: capture }), 'application/json');
    if (req.method === 'POST') return receiveCapture(req, res);
    return send(res, 405, 'Method not allowed');
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
  serveStatic(req, res, path);
}

let tls;
try {
  tls = { cert: readFileSync(join(ROOT, 'certs', 'cert.pem')), key: readFileSync(join(ROOT, 'certs', 'key.pem')) };
} catch {
  console.error('Missing certs/cert.pem or certs/key.pem. See "Serve locally over HTTPS" in the README.');
  process.exit(1);
}

createServer(tls, handle).listen(port, () => {
  console.log(`Visual Modem server on port ${port}${capture ? ', frame capture on' : ''}. Open:`);
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4') console.log(`  https://${a.address}:${port}/web/`);
    }
  }
});
