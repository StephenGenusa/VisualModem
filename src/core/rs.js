// Reed-Solomon over GF(256): field polynomial 0x11d, generator 2, first
// consecutive root 0 (the QR code convention). Written by hand.
//
// A codeword is data followed by parity bytes. Byte j of an n byte codeword is
// the coefficient of x^(n-1-j), so shortened codewords (n < 255) need no
// special handling.

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x; LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

function mul(a, b) {
  return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]];
}

function div(a, b) {
  return a === 0 ? 0 : EXP[LOG[a] + 255 - LOG[b]];
}

/** Evaluates a polynomial stored lowest degree first at x. */
function evalLow(poly, x) {
  let y = 0;
  for (let i = poly.length - 1; i >= 0; i--) y = mul(y, x) ^ poly[i];
  return y;
}

const generators = new Map();

/** Product of (x - 2^i) for i in 0..parity-1, highest degree first, monic. */
function generator(parity) {
  let g = generators.get(parity);
  if (g) return g;
  g = new Uint8Array([1]);
  for (let i = 0; i < parity; i++) {
    const next = new Uint8Array(g.length + 1);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j];
      next[j + 1] ^= mul(g[j], EXP[i]);
    }
    g = next;
  }
  generators.set(parity, g);
  return g;
}

function checkArgs(length, parity) {
  if (!Number.isInteger(parity) || parity < 0 || parity % 2 !== 0) {
    throw new RangeError(`parity must be a non-negative even integer, got ${parity}`);
  }
  if (length > 255) throw new RangeError(`codeword length ${length} exceeds 255`);
}

/**
 * @param {Uint8Array} data
 * @param {number} parity number of parity bytes (even, data.length + parity <= 255)
 * @returns {Uint8Array} data followed by parity bytes
 */
export function rsEncode(data, parity) {
  checkArgs(data.length + parity, parity);
  const out = new Uint8Array(data.length + parity);
  out.set(data);
  if (parity === 0) return out;
  const g = generator(parity);
  // Long division of data * x^parity by g; the remainder lands in out's tail.
  const rem = new Uint8Array(parity);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i] ^ rem[0];
    rem.copyWithin(0, 1); rem[parity - 1] = 0;
    if (factor !== 0) for (let j = 0; j < parity; j++) rem[j] ^= mul(g[j + 1], factor);
  }
  out.set(rem, data.length);
  return out;
}

function syndromes(cw, parity) {
  const s = new Uint8Array(parity);
  for (let i = 0; i < parity; i++) {
    let y = 0;
    for (let j = 0; j < cw.length; j++) y = mul(y, EXP[i]) ^ cw[j];
    s[i] = y;
  }
  return s;
}

/** Berlekamp-Massey. Returns the error locator, lowest degree first. */
function errorLocator(s) {
  let c = [1], b = [1], len = 0, m = 1, lastD = 1;
  for (let n = 0; n < s.length; n++) {
    let d = s[n];
    for (let i = 1; i <= len; i++) d ^= mul(c[i], s[n - i]);
    if (d === 0) { m++; continue; }
    const coef = div(d, lastD);
    const next = c.slice();
    while (next.length < b.length + m) next.push(0);
    for (let i = 0; i < b.length; i++) next[i + m] ^= mul(coef, b[i]);
    if (2 * len <= n) {
      b = c; len = n + 1 - len; lastD = d; m = 1;
    } else {
      m++;
    }
    c = next;
  }
  return c.slice(0, len + 1);
}

/**
 * @param {Uint8Array} codeword
 * @param {number} parity
 * @returns {{ data: Uint8Array, corrected: number } | null} null when more
 *   than parity / 2 bytes are wrong and the codeword cannot be repaired
 */
export function rsDecode(codeword, parity) {
  checkArgs(codeword.length, parity);
  if (codeword.length < parity) throw new RangeError('codeword shorter than parity');
  const n = codeword.length;
  const dataLen = n - parity;
  if (parity === 0) return { data: codeword.slice(), corrected: 0 };

  const s = syndromes(codeword, parity);
  if (s.every((v) => v === 0)) return { data: codeword.slice(0, dataLen), corrected: 0 };

  const locator = errorLocator(s);
  const errors = locator.length - 1;
  if (errors > parity / 2) return null;

  // Chien search over the positions that exist in this (possibly shortened) codeword.
  const positions = [];
  for (let j = 0; j < n; j++) {
    const power = n - 1 - j;
    if (evalLow(locator, EXP[(255 - power) % 255]) === 0) positions.push(j);
  }
  if (positions.length !== errors) return null;

  // Forney: omega = S(x) * locator(x) mod x^parity; with first root 0 the
  // magnitude is X * omega(X^-1) / locator'(X^-1).
  const omega = new Uint8Array(parity);
  for (let i = 0; i < parity; i++) {
    for (let j = 0; j <= i && j < locator.length; j++) omega[i] ^= mul(s[i - j], locator[j]);
  }
  const derivative = locator.map((v, i) => (i % 2 === 1 ? v : 0)).slice(1);

  const fixed = codeword.slice();
  for (const j of positions) {
    const power = n - 1 - j;
    const x = EXP[power];
    const xInv = EXP[(255 - power) % 255];
    const denom = evalLow(derivative, xInv);
    if (denom === 0) return null;
    fixed[j] ^= mul(x, div(evalLow(omega, xInv), denom));
  }

  if (!syndromes(fixed, parity).every((v) => v === 0)) return null;
  return { data: fixed.slice(0, dataLen), corrected: errors };
}
