// Repeatable synthetic comparison matrix, not a measurement of provider usage.
// Run: node scripts/measure-sync-checksum-gaps.cjs
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { createCRC32, createCRC32C } = require("../src/checksums.cjs");
const { compare } = require("../src/sync.cjs");

async function measureChecksumGaps() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sync-checksum-gaps-"));
  try {
    const sizes = { small: 1024, large: 8 * 1024 * 1024 + 1 };
    const objects = new Map();
    for (const [group, size] of Object.entries(sizes)) {
      const bytes = Buffer.alloc(size, Buffer.from("Primož 👩🏽‍💻\0東京\n"));
      const sha256 = createHash("sha256").update(bytes).digest("base64");
      const sha1 = createHash("sha1").update(bytes).digest("base64");
      const md5 = createHash("md5").update(bytes).digest("hex");
      const crc32 = createCRC32().update(bytes).digest();
      const crc32c = createCRC32C().update(bytes).digest();
      const scenarios = {
        "single-part-md5-etag": { ETag: `"${md5}"` },
        "full-sha256": { ChecksumSHA256: sha256, ChecksumType: "FULL_OBJECT" },
        "full-sha1": { ChecksumSHA1: sha1, ChecksumType: "FULL_OBJECT" },
        "full-md5": {
          ChecksumMD5: Buffer.from(md5, "hex").toString("base64"),
          ChecksumType: "FULL_OBJECT",
        },
        "full-crc32": { ChecksumCRC32: crc32, ChecksumType: "FULL_OBJECT" },
        "full-crc32c": { ChecksumCRC32C: crc32c, ChecksumType: "FULL_OBJECT" },
        "multipart-etag-only": {},
        "composite-crc32": { ChecksumCRC32: crc32, ChecksumType: "COMPOSITE" },
        "composite-crc32c": {
          ChecksumCRC32C: crc32c,
          ChecksumType: "COMPOSITE",
        },
        "untyped-crc32": { ChecksumCRC32: crc32 },
        "untyped-crc32c": { ChecksumCRC32C: crc32c },
        "user-metadata-only": { Metadata: { sha256, crc32, crc32c } },
        "unsupported-full-checksum": {
          ChecksumCRC64NVME: "AAAAAAAAAAA=",
          ChecksumType: "FULL_OBJECT",
        },
      };
      const backing = path.join(root, `${group}-bytes`);
      await fs.writeFile(backing, bytes);
      for (const [scenario, metadata] of Object.entries(scenarios)) {
        const key = `${group}-${scenario}`;
        await fs.link(backing, path.join(root, key));
        objects.set(key, {
          ContentLength: size,
          ETag: `"${md5}-2"`,
          ...metadata,
        });
      }
      await fs.unlink(backing);
    }
    const s3 = {
      async send(command) {
        if (command.constructor.name === "ListObjectsV2Command")
          return {
            Contents: [...objects].map(([Key, object]) => ({
              Key,
              Size: object.ContentLength,
              ETag: object.ETag,
            })),
          };
        if (command.constructor.name === "HeadObjectCommand")
          return objects.get(command.input.Key);
        throw new Error(`Unexpected ${command.constructor.name}`);
      },
    };
    const plan = await compare(s3, { bucket: "synthetic", source: root });
    return {
      fixture:
        "Synthetic equal bytes; results measure checksum support, not provider prevalence.",
      counts: plan.counts,
      groups: Object.entries(sizes).map(([group, bytes]) => {
        const rows = plan.rows.filter((row) => row.key.startsWith(`${group}-`));
        return {
          group,
          bytes,
          files: rows.length,
          unchanged: rows.filter((row) => row.status === "unchanged").length,
          changed: rows.filter((row) => row.status === "changed").length,
          uncertain: rows.filter((row) => row.uncertain).length,
          rows: rows.map(({ key, status, uncertain, reason }) => ({
            scenario: key.slice(group.length + 1),
            status,
            uncertain,
            reason,
          })),
        };
      }),
    };
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

if (require.main === module)
  measureChecksumGaps().then(
    (result) => console.log(JSON.stringify(result, null, 2)),
    (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  );

module.exports = { measureChecksumGaps };
