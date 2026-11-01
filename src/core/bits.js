// Bit streams, most significant bit first.

export class BitWriter {
  constructor(byteLength) {
    this.buffer = new Uint8Array(byteLength);
    this.bitPos = 0;
  }

  write(value, bits) {
    if (this.bitPos + bits > this.buffer.length * 8) {
      throw new RangeError('BitWriter capacity exceeded');
    }
    for (let i = bits - 1; i >= 0; i--) {
      if ((value >>> i) & 1) {
        this.buffer[this.bitPos >> 3] |= 0x80 >> (this.bitPos & 7);
      }
      this.bitPos++;
    }
  }

  bytes() {
    return this.buffer;
  }
}

export class BitReader {
  constructor(bytes) {
    this.data = bytes;
    this.bitPos = 0;
  }

  read(bits) {
    let value = 0;
    for (let i = 0; i < bits; i++) {
      const byte = this.data[this.bitPos >> 3] ?? 0;
      value = value * 2 + ((byte >> (7 - (this.bitPos & 7))) & 1);
      this.bitPos++;
    }
    return value;
  }

  remaining() {
    return Math.max(0, this.data.length * 8 - this.bitPos);
  }
}
