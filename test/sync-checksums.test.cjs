const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { compare } = require("../src/sync.cjs");
const { createCRC32, createCRC32C } = require("../src/checksums.cjs");
const {
  measureChecksumGaps,
} = require("../scripts/measure-sync-checksum-gaps.cjs");

test("checksum-gap measurement accepts full checksums above 8 MiB and retains conservative uploads", async () => {
  const measurement = await measureChecksumGaps();
  assert.equal(measurement.groups[0].bytes, 1024);
  assert.ok(measurement.groups[1].bytes > 8 * 1024 * 1024);
  for (const group of measurement.groups) {
    assert.equal(group.files, 13);
    assert.equal(group.unchanged, 6);
    assert.equal(group.changed, 7);
    assert.equal(group.uncertain, 7);
    for (const row of group.rows) {
      const trusted =
        row.scenario.startsWith("full-") ||
        row.scenario === "single-part-md5-etag";
      assert.equal(row.status, trusted ? "unchanged" : "changed", row.scenario);
      assert.equal(row.uncertain, !trusted, row.scenario);
      if (!trusted) assert.match(row.reason, /uncertain/);
    }
  }
  assert.equal(measurement.counts.unchanged, 12);
  assert.equal(measurement.counts.changed, 14);
  assert.equal(measurement.counts.uncertain, 14);
});

async function fixture(t, objects, body = Buffer.from("é")) {
  const source = await fs.mkdtemp(path.join(os.tmpdir(), "sync-crc-"));
  t.after(() => fs.rm(source, { recursive: true, force: true }));
  for (const key of Object.keys(objects))
    await fs.writeFile(path.join(source, key), body);
  const s3 = {
    async send(command) {
      if (command.constructor.name === "ListObjectsV2Command")
        return {
          Contents: Object.entries(objects).map(([Key, metadata]) => ({
            Key,
            Size: metadata.ContentLength,
            ETag: metadata.ETag,
          })),
        };
      if (command.constructor.name === "HeadObjectCommand")
        return objects[command.input.Key];
      throw new Error(`Unexpected ${command.constructor.name}`);
    },
  };
  return { source, s3 };
}

test("CRC mismatches and size differences are proven changes; SHA keeps priority over CRC", async (t) => {
  const base = {
    ContentLength: 2,
    ETag: '"opaque-2"',
    ChecksumType: "FULL_OBJECT",
  };
  const metadata = {
    "crc32-different": {
      ...base,
      ChecksumCRC32: createCRC32().update(Buffer.from("ab")).digest(),
    },
    "crc32c-different": {
      ...base,
      ChecksumCRC32C: createCRC32C().update(Buffer.from("ab")).digest(),
    },
    "size-different": {
      ...base,
      ContentLength: 3,
      ChecksumCRC32: createCRC32().update(Buffer.from("é")).digest(),
    },
    "sha-first": {
      ...base,
      ChecksumSHA256: createHash("sha256").update("ab").digest("base64"),
      ChecksumCRC32: createCRC32().update(Buffer.from("é")).digest(),
    },
    "unknown-without-etag": { ContentLength: 2 },
  };
  const { source, s3 } = await fixture(t, metadata);
  const plan = await compare(s3, { bucket: "b", source });
  const rows = Object.fromEntries(plan.rows.map((row) => [row.key, row]));
  for (const key of [
    "crc32-different",
    "crc32c-different",
    "size-different",
    "sha-first",
  ]) {
    assert.equal(rows[key].status, "changed");
    assert.equal(rows[key].uncertain, false);
  }
  assert.match(rows["crc32-different"].reason, /CRC32 differs/);
  assert.match(rows["crc32c-different"].reason, /CRC32C differs/);
  assert.match(rows["size-different"].reason, /Size differs/);
  assert.match(rows["sha-first"].reason, /SHA-256 differs/);
  assert.equal(rows["unknown-without-etag"].status, "conflict");
  assert.equal(rows["unknown-without-etag"].uncertain, true);
  assert.equal(plan.counts.uncertain, 1);
  assert.equal(plan.counts.changed, 4);
  assert.equal(plan.counts.conflict, 1);
});

test("unsupported checksum HEAD falls back and user metadata alone cannot establish equality", async (t) => {
  const metadata = {
    file: {
      ContentLength: 2,
      ETag: '"opaque-2"',
      Metadata: { crc32: createCRC32().update(Buffer.from("é")).digest() },
    },
  };
  const { source, s3 } = await fixture(t, metadata);
  const send = s3.send.bind(s3);
  let checksumHeads = 0,
    plainHeads = 0;
  s3.send = async (command) => {
    if (command.constructor.name === "HeadObjectCommand") {
      if (command.input.ChecksumMode) {
        checksumHeads++;
        throw Object.assign(new Error("Unsupported"), {
          name: "NotImplemented",
        });
      }
      plainHeads++;
    }
    return send(command);
  };
  const plan = await compare(s3, { bucket: "b", source });
  assert.equal(checksumHeads, 1);
  assert.equal(plainHeads, 1);
  assert.equal(plan.rows[0].status, "changed");
  assert.equal(plan.counts.uncertain, 1);
});
