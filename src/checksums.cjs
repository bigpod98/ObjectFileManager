const { crc32 } = require("node:zlib");

// Reflected Castagnoli polynomial; initial/final XOR are both 0xffffffff.
const crc32cTable = Uint32Array.from({ length: 256 }, (_, byte) => {
  let value = byte;
  for (let bit = 0; bit < 8; bit++)
    value = (value >>> 1) ^ (value & 1 ? 0x82f63b78 : 0);
  return value >>> 0;
});

function crc32c(bytes, previous) {
  let value = previous ^ 0xffffffff;
  for (let i = 0; i < bytes.length; i++)
    value = (value >>> 8) ^ crc32cTable[(value ^ bytes[i]) & 0xff];
  return (value ^ 0xffffffff) >>> 0;
}

// Accept byte buffers so stream boundaries cannot change Unicode encoding.
// S3 encodes the unsigned checksum as four big-endian bytes, then base64.
function accumulator(calculate) {
  let value = 0;
  return {
    update(bytes) {
      if (!(bytes instanceof Uint8Array))
        throw new TypeError("Checksum input must be a byte buffer.");
      value = calculate(bytes, value);
      return this;
    },
    digest() {
      const bytes = Buffer.allocUnsafe(4);
      bytes.writeUInt32BE(value);
      return bytes.toString("base64");
    },
  };
}

const createCRC32 = () => accumulator(crc32);
const createCRC32C = () => accumulator(crc32c);

module.exports = { createCRC32, createCRC32C };
