// Known-pattern probe payloads: a pseudorandom byte stream the phone can
// regenerate from a probe frame's txId and index alone, so it can count bit
// errors against the true bytes. No DOM; pure.

/** The mulberry32 step: a function returning the next unsigned 32-bit value. */
export function random32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}

/**
 * @param {number} txId
 * @param {number} index frame index within the showing
 * @param {number} length
 * @returns {Uint8Array}
 */
export function probePayload(txId, index, length) {
  const next = random32((txId ^ Math.imul(index + 1, 0x9E3779B1)) >>> 0);
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = next() & 0xff;
  return out;
}
