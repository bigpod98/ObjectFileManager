const { test } = require("node:test");
const assert = require("node:assert/strict");
const { copyObject } = require("../src/operations.cjs");
const sdk = require("@aws-sdk/client-s3");
const { client } = require("../src/storage.cjs");

const protections = {
  active: {
    ObjectLockMode: "GOVERNANCE",
    ObjectLockRetainUntilDate: new Date("2099-01-01T00:00:00Z"),
  },
  expired: {
    ObjectLockMode: "GOVERNANCE",
    ObjectLockRetainUntilDate: new Date("2000-01-01T00:00:00Z"),
  },
  hold: { ObjectLockLegalHoldStatus: "ON" },
  combined: {
    ObjectLockMode: "COMPLIANCE",
    ObjectLockRetainUntilDate: new Date("2099-01-01T00:00:00Z"),
    ObjectLockLegalHoldStatus: "ON",
  },
};

for (const [name, protection] of Object.entries(protections)) {
  for (const multipart of [false, true]) {
    test(`${name} Object Lock settings are explicit in ${multipart ? "multipart" : "small"} copy`, async () => {
      const calls = [];
      const size = multipart ? 5 * 1024 ** 3 + 1 : 3;
      const s3 = {
        async send(command) {
          calls.push(command);
          switch (command.constructor.name) {
            case "CopyObjectCommand":
              return { CopyObjectResult: { ETag: '"copied"' } };
            case "GetObjectTaggingCommand":
              return {};
            case "CreateMultipartUploadCommand":
              return { UploadId: "upload" };
            case "UploadPartCopyCommand":
              return { CopyPartResult: { ETag: '"part"' } };
            case "CompleteMultipartUploadCommand":
              return { ETag: '"copied"' };
            default:
              throw new Error(command.constructor.name);
          }
        },
      };
      await copyObject(s3, {
        bucket: "source",
        key: "a",
        destinationBucket: "destination",
        destinationKey: "b",
        size,
        etag: '"source"',
        sourceHead: { ETag: '"source"', ContentLength: size, ...protection },
      });
      const created = calls.find((command) =>
        ["CopyObjectCommand", "CreateMultipartUploadCommand"].includes(
          command.constructor.name,
        ),
      );
      for (const [key, value] of Object.entries(protection))
        assert.deepEqual(created.input[key], value);
      assert.equal(created.input.BypassGovernanceRetention, undefined);
    });
  }
}

test("expired retention rejection never retries copy without protection", async () => {
  for (const size of [3, 6 * 1024 ** 3]) {
    const calls = [];
    const s3 = {
      async send(command) {
        calls.push(command);
        if (command.constructor.name === "GetObjectTaggingCommand") return {};
        throw Object.assign(new Error("retention date must be in the future"), {
          name: "InvalidRequest",
          $metadata: { httpStatusCode: 400 },
        });
      },
    };
    await assert.rejects(
      copyObject(s3, {
        bucket: "source",
        key: "a",
        destinationBucket: "destination",
        destinationKey: "b",
        size,
        etag: '"source"',
        sourceHead: {
          ETag: '"source"',
          ContentLength: size,
          ...protections.expired,
          ...protections.hold,
        },
      }),
      /retention date/,
    );
    const writes = calls.filter((command) =>
      ["CopyObjectCommand", "CreateMultipartUploadCommand"].includes(
        command.constructor.name,
      ),
    );
    assert.equal(writes.length, 1);
    assert.deepEqual(
      writes[0].input.ObjectLockRetainUntilDate,
      protections.expired.ObjectLockRetainUntilDate,
    );
    assert.equal(writes[0].input.ObjectLockLegalHoldStatus, "ON");
  }
});

test(
  "S3 Object Lock service policy: active retention and holds persist; expired retention fails closed",
  { skip: !process.env.S3_TEST_ENDPOINT, timeout: 30_000 },
  async (t) => {
    const s3 = client({
      endpoint: process.env.S3_TEST_ENDPOINT,
      pathStyle: true,
      accessKeyId: process.env.S3_TEST_ACCESS_KEY,
      secretAccessKey: process.env.S3_TEST_SECRET_KEY,
    });
    const Bucket = `objectfilemanager-lock-${Date.now()}-${process.pid}`;
    let created = false;
    t.after(async () => {
      try {
        if (created) {
          const listing = await s3.send(
            new sdk.ListObjectVersionsCommand({ Bucket }),
          );
          for (const item of listing.Versions || []) {
            const input = { Bucket, Key: item.Key, VersionId: item.VersionId };
            await s3.send(
              new sdk.PutObjectLegalHoldCommand({
                ...input,
                LegalHold: { Status: "OFF" },
              }),
            );
            await s3.send(
              new sdk.DeleteObjectCommand({
                ...input,
                BypassGovernanceRetention: true,
              }),
            );
          }
          await s3.send(new sdk.DeleteBucketCommand({ Bucket }));
        }
      } finally {
        s3.destroy();
      }
    });
    await s3.send(
      new sdk.CreateBucketCommand({ Bucket, ObjectLockEnabledForBucket: true }),
    );
    created = true;
    for (const [name, protection] of Object.entries({
      active: protections.active,
      hold: protections.hold,
      expired: protections.expired,
    })) {
      // An expired retention is still source metadata after its period ends.
      // Exercise the service's explicit-date validation directly for that case.
      const source = await s3.send(
        new sdk.PutObjectCommand({
          Bucket,
          Key: name,
          Body: "abc",
          ...(name === "expired" ? {} : protection),
        }),
      );
      if (name === "expired") {
        for (const Command of [
          sdk.CopyObjectCommand,
          sdk.CreateMultipartUploadCommand,
        ]) {
          await assert.rejects(
            s3.send(
              new Command({
                Bucket,
                Key: `${name}-${Command.name}`,
                CopySource: `${Bucket}/${name}`,
                ...protection,
              }),
            ),
            (error) => error.$metadata?.httpStatusCode === 400,
          );
        }
        continue;
      }
      const head = await s3.send(
        new sdk.HeadObjectCommand({ Bucket, Key: name }),
      );
      await copyObject(s3, {
        bucket: Bucket,
        key: name,
        destinationKey: `${name}-copy`,
        size: 3,
        etag: source.ETag,
        sourceHead: head,
      });
      const copied = await s3.send(
        new sdk.HeadObjectCommand({ Bucket, Key: `${name}-copy` }),
      );
      for (const [key, value] of Object.entries(protection))
        assert.deepEqual(copied[key], value);
      const started = await s3.send(
        new sdk.CreateMultipartUploadCommand({
          Bucket,
          Key: `${name}-multipart`,
          ...protection,
        }),
      );
      await s3.send(
        new sdk.AbortMultipartUploadCommand({
          Bucket,
          Key: `${name}-multipart`,
          UploadId: started.UploadId,
        }),
      );
    }
  },
);
