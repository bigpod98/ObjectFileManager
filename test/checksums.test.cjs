const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createCRC32, createCRC32C } = require("../src/checksums.cjs");

const hex = (checksum) =>
  Buffer.from(checksum.digest(), "base64").toString("hex");
const unicode = Buffer.from("Primož 👩🏽‍💻\0東京");
const vectors = [
  [Buffer.alloc(0), "00000000", "00000000"],
  [Buffer.from("123456789"), "cbf43926", "e3069283"],
  [Buffer.alloc(32), "190a55ad", "8a9136aa"],
  [
    Buffer.from(Array.from({ length: 32 }, (_, i) => i)),
    "91267e8a",
    "46dd794e",
  ],
  [unicode, "d6b55f89", "f37f037d"],
];

for (const [factory, column] of [
  [createCRC32, 1],
  [createCRC32C, 2],
]) {
  test(`${factory.name} matches known vectors as big-endian base64`, () => {
    for (const vector of vectors) {
      const checksum = factory().update(vector[0]);
      assert.equal(hex(checksum), vector[column]);
      assert.equal(checksum.digest().length, 8);
    }
    assert.throws(() => factory().update("é"), /byte buffer/);
  });

  test(`${factory.name} preserves bytes across stream and Unicode chunk boundaries`, () => {
    const body = Buffer.alloc(131107, unicode);
    const expected = column === 1 ? "ac382a37" : "bcad172c";
    for (const chunkSize of [1, 2, 3, 63, 64, 65535, 65536, 65537]) {
      const checksum = factory();
      for (let offset = 0; offset < body.length; offset += chunkSize) {
        checksum.update(body.subarray(offset, offset + chunkSize));
        checksum.update(Buffer.alloc(0));
      }
      assert.equal(hex(checksum), expected, `chunk size ${chunkSize}`);
    }
  });
}
