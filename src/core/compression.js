/**
 * Compression and hashing helpers.
 *
 * Uses the web Compression Streams API (gzip) and Web Crypto API (SHA-256).
 * Both require a secure context in browsers; in Node.js ≥ 18 they're
 * available via globalThis or node: built-ins.
 */

/**
 * Gzip-compress a byte array.
 * @param {Uint8Array} data
 * @returns {Promise<Uint8Array>}
 */
export async function gzipCompress(data) {
  if (typeof CompressionStream === 'undefined') {
    throw new Error('gzipCompress: CompressionStream not available (requires a secure context or Node.js ≥ 18)');
  }
  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  const reader = cs.readable.getReader();

  // Write and close in the background
  const writePromise = writer.write(data).then(() => writer.close());

  // Collect chunks
  const chunks = [];
  let totalLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalLength += value.length;
  }
  await writePromise;

  // Concatenate
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

/**
 * Gzip-decompress a byte array.
 * @param {Uint8Array} data
 * @returns {Promise<Uint8Array>}
 */
export async function gzipDecompress(data) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('gzipDecompress: DecompressionStream not available (requires a secure context or Node.js ≥ 18)');
  }
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();

  const writePromise = writer.write(data).then(() => writer.close());

  const chunks = [];
  let totalLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalLength += value.length;
  }
  await writePromise;

  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

/**
 * Compute SHA-256 hex digest of a byte array.
 * @param {Uint8Array} data
 * @returns {Promise<string>} Lowercase hex string (64 chars).
 */
export async function sha256(data) {
  let subtle;
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.subtle) {
    subtle = globalThis.crypto.subtle;
  } else {
    // Node.js fallback
    try {
      const { webcrypto } = await import('node:crypto');
      subtle = webcrypto.subtle;
    } catch {
      throw new Error('sha256: crypto.subtle not available (requires a secure context or Node.js ≥ 16)');
    }
  }
  const hashBuffer = await subtle.digest('SHA-256', data);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray, b => b.toString(16).padStart(2, '0')).join('');
}
