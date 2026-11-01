// CRC-32 (IEEE 802.3, reflected polynomial 0xEDB88320).

let table = null;

function buildTable() {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
}

export function crc32(bytes) {
  table ??= buildTable();
  let c = 0xFFFFFFFF;
  for (const b of bytes) c = table[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
