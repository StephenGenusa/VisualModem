// Payload streams for auto tune trials. Each trial is one frame whose whole
// data area carries random bytes, so an error anywhere in the frame counts
// (the decoder skips codewords that hold only padding). Random data does not
// compress, so the stream size is predictable. The seed and trial id make the
// transmission id unique, which ties every phone read to one trial.
import { encodePayload } from '../core/payload.js';
import { VmError } from '../core/errors.js';

export const MIN_CAPACITY = 73; // the smallest frame a trial fits in, measured
const FIRST_GUESS_SLACK = 72; // manifest, gzip and record overhead, measured
const MAX_TRIES = 3;

function randomBytes(length, seed) {
  // mulberry32
  let a = seed >>> 0;
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    out[i] = (t ^ (t >>> 14)) & 0xff;
  }
  return out;
}

/**
 * @param {number} trialId
 * @param {number} capacityBytes payload bytes one frame holds
 * @param {number} seed changes the bytes, and so the transmission id, between runs
 * @param {number} [frames] how many frames the stream fills; the throughput check uses several
 * @returns {Promise<Uint8Array>} a stream no longer than frames * capacityBytes
 */
export async function buildTrialStream(trialId, capacityBytes, seed, frames = 1) {
  const tooSmall = () => new VmError('TRIAL_TOO_SMALL', `A frame of ${capacityBytes} bytes is too small for a tune trial`);
  if (capacityBytes < MIN_CAPACITY) throw tooSmall();
  const total = capacityBytes * frames;
  const bytes = randomBytes(total, Math.imul(trialId, 2654435761) ^ seed);
  let length = total - FIRST_GUESS_SLACK;
  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    if (length < 1) throw tooSmall();
    const stream = await encodePayload({
      type: 'file',
      name: `t${trialId}`, // short name and no MIME type: small screens at 2 levels hold only ~70 bytes a frame
      mime: '',
      data: bytes.subarray(0, length),
    });
    if (stream.length <= total) return stream;
    length -= stream.length - total + 8;
  }
  throw tooSmall();
}
