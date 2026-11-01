// CRC-16/CCITT-FALSE: polynomial 0x1021, init 0xFFFF, no reflection, no final XOR.

let table = null;

function buildTable() {
  const t = new Uint16Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n << 8;
    for (let k = 0; k < 8; k++) c = c & 0x8000 ? (c << 1) ^ 0x1021 : c << 1;
    t[n] = c & 0xffff;
  }
  return t;
}

/**
 * @param {Uint8Array} bytes
 * @returns {number} unsigned 16-bit checksum
 */
export function crc16(bytes) {
  if (!table) table = buildTable();
  let crc = 0xFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc = ((crc << 8) ^ table[((crc >>> 8) ^ bytes[i]) & 0xff]) & 0xffff;
  }
  return crc;
}
