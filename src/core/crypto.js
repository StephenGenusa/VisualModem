/**
 * Password encryption helpers: PBKDF2 (SHA-256) key derivation and AES-GCM.
 */
import { VmError } from './errors.js';

const ITERATIONS = 200000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

async function getCrypto() {
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.subtle) {
    return globalThis.crypto;
  }
  try {
    const { webcrypto } = await import('node:crypto');
    return webcrypto;
  } catch {
    throw new Error('crypto.subtle not available (requires a secure context or Node.js >= 16)');
  }
}

async function deriveKey(subtle, password, salt) {
  const material = await subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']);
}

/**
 * @param {Uint8Array} plain
 * @param {string} password
 * @returns {Promise<{ salt: Uint8Array, iv: Uint8Array, ciphertext: Uint8Array }>}
 */
export async function encryptBytes(plain, password) {
  const c = await getCrypto();
  const salt = c.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = c.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(c.subtle, password, salt);
  const ciphertext = new Uint8Array(await c.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
  return { salt, iv, ciphertext };
}

/**
 * @param {Uint8Array} ciphertext
 * @param {string} password
 * @param {Uint8Array} salt
 * @param {Uint8Array} iv
 * @returns {Promise<Uint8Array>}
 * @throws {VmError} BAD_PASSWORD when authentication fails
 */
export async function decryptBytes(ciphertext, password, salt, iv) {
  const c = await getCrypto();
  const key = await deriveKey(c.subtle, password, salt);
  try {
    return new Uint8Array(await c.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext));
  } catch {
    throw new VmError('BAD_PASSWORD', 'Wrong password or corrupted data');
  }
}
