// Opt in with AZURITE_INTEGRATION=1 node --test test/azure-integration.test.cjs.
// AZURITE_TEST_ENDPOINT selects an external disposable emulator (including its
// account path); otherwise Docker starts a local emulator. Optional credentials:
// AZURITE_TEST_ACCOUNT_NAME and AZURITE_TEST_ACCOUNT_KEY.
const test = require("node:test");
const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { randomUUID, createHash } = require("node:crypto");
const { Readable } = require("node:stream");
const { setTimeout: delay } = require("node:timers/promises");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  BlobServiceClient,
  StorageSharedKeyCredential,
} = require("@azure/storage-blob");
const { client } = require("../src/providers/azure.cjs");
const commands = require("@aws-sdk/client-s3");
const objectTools = require("../src/object-tools.cjs");
const sync = require("../src/sync.cjs");
const exec = promisify(execFile);
const command = (name, input = {}) => new commands[name + "Command"](input);
const collect = async (stream) => {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
};

test(
  "native Azure workflows against disposable Azurite",
  { skip: process.env.AZURITE_INTEGRATION !== "1", timeout: 120000 },
  async (t) => {
    const containerName = `s3browser-azurite-${randomUUID()}`;
    const accountName =
      process.env.AZURITE_TEST_ACCOUNT_NAME || "s3browsertest";
    const accountKey =
      process.env.AZURITE_TEST_ACCOUNT_KEY ||
      Buffer.alloc(32, 7).toString("base64");
    let endpoint = process.env.AZURITE_TEST_ENDPOINT;
    let startedDocker = false;
    let cleanupContainer;
    t.after(async () => {
      try {
        await cleanupContainer?.deleteIfExists();
      } finally {
        if (startedDocker) await exec("docker", ["rm", "-f", containerName]);
      }
    });
    if (!endpoint) {
      await exec("docker", [
        "run",
        "--rm",
        "-d",
        "--name",
        containerName,
        "-p",
        "127.0.0.1::10000",
        "-e",
        `AZURITE_ACCOUNTS=${accountName}:${accountKey}`,
        "mcr.microsoft.com/azure-storage/azurite:3.35.0",
        "azurite-blob",
        "--blobHost",
        "0.0.0.0",
        "--skipApiVersionCheck",
        "--silent",
      ]);

      startedDocker = true;
      const { stdout } = await exec("docker", [
        "port",
        containerName,
        "10000/tcp",
      ]);
      endpoint = `http://${stdout.trim()}/${accountName}`;
    }
    const service = new BlobServiceClient(
      endpoint,
      new StorageSharedKeyCredential(accountName, accountKey),
      { retryOptions: { maxTries: 1 } },
    );
    const bucket = `test-${randomUUID()}`;
    for (let attempt = 0; ; attempt++) {
      try {
        const candidate = service.getContainerClient(bucket);
        await candidate.create();
        cleanupContainer = candidate;
        break;
      } catch (error) {
        if (attempt >= 30) throw error;
        await delay(200);
      }
    }
    const adapter = client({ accountName, accountKey, endpoint });
    t.after(() => adapter.destroy());
    const signal = new AbortController().signal;
    const sdkBlob = service
      .getContainerClient(bucket)
      .getBlockBlobClient("sdk-upload.bin");
    await sdkBlob.uploadStream(
      Readable.from([Buffer.from("sdk-created")]),
      undefined,
      undefined,
      { metadata: { author: "external client" } },
    );
    const externalDetails = await objectTools.details(adapter, {
      profile: "test",
      bucket,
      key: "sdk-upload.bin",
    });
    await objectTools.metadata(adapter, {
      profile: "test",
      bucket,
      key: "sdk-upload.bin",
      expectedSnapshot: externalDetails.metadataSnapshot,
      metadata: {
        author: "external client",
        "custom-key": "é",
        s3browser_metadata_encoding: "user value",
        s3browser_meta_6162: "reserved value",
      },
    });
    const externalMetadata = await sdkBlob.getProperties();
    assert.equal(externalMetadata.metadata.author, "external client");
    assert.deepEqual(
      (
        await adapter.send(
          command("HeadObject", { Bucket: bucket, Key: "sdk-upload.bin" }),
        )
      ).Metadata,
      {
        author: "external client",
        "custom-key": "é",
        s3browser_metadata_encoding: "user value",
        s3browser_meta_6162: "reserved value",
      },
    );
    await sdkBlob.stageBlock(
      Buffer.from("external".padEnd(48, "0")).toString("base64"),
      Buffer.from("orphan"),
      6,
    );
    await adapter.upload({
      Bucket: bucket,
      Key: "sdk-upload.bin",
      Body: Readable.from([Buffer.from("replaced")]),
      IfMatch: externalMetadata.etag,
    });
    assert.equal(
      (
        await collect(
          (
            await adapter.send(
              command("GetObject", { Bucket: bucket, Key: "sdk-upload.bin" }),
            )
          ).Body,
        )
      ).toString(),
      "replaced",
    );
    await sdkBlob.delete();
    const customBlob = service
      .getContainerClient(bucket)
      .getBlockBlobClient("custom-blocks.bin");
    const customHead = await customBlob.uploadData(Buffer.from("original"));
    await customBlob.stageBlock(
      Buffer.from("short").toString("base64"),
      Buffer.from("orphan"),
      6,
    );
    await assert.rejects(
      adapter.upload({
        Bucket: bucket,
        Key: "custom-blocks.bin",
        Body: Readable.from([Buffer.from("replacement")]),
        IfMatch: customHead.etag,
      }),
      (error) => error.$metadata?.httpStatusCode === 400,
    );
    assert.equal(
      (
        await collect(
          (
            await adapter.send(
              command("GetObject", {
                Bucket: bucket,
                Key: "custom-blocks.bin",
              }),
            )
          ).Body,
        )
      ).toString(),
      "original",
    );
    await customBlob.delete();
    const bytes = Buffer.alloc(8 * 1024 * 1024 + 23, 0xa5);
    const uploaded = await adapter.upload(
      {
        Bucket: bucket,
        Key: "folder/source.bin",
        Body: Readable.from([bytes]),
        ContentLength: bytes.length,
        ContentType: "application/octet-stream",
        CacheControl: "private",
        Metadata: { "s3browser-upload-token": "test-token", unicode: "é" },
        IfNoneMatch: "*",
      },
      { abortSignal: signal },
    );
    assert.ok(uploaded.ETag);
    const head = await adapter.send(
      command("HeadObject", { Bucket: bucket, Key: "folder/source.bin" }),
    );
    assert.equal(head.ContentLength, bytes.length);
    assert.equal(
      head.ChecksumMD5,
      createHash("md5").update(bytes).digest("base64"),
    );
    assert.deepEqual(head.Metadata, {
      "s3browser-upload-token": "test-token",
      unicode: "é",
    });
    assert.ok(
      (await adapter.send(command("ListBuckets"))).Buckets.some(
        (item) => item.Name === bucket,
      ),
    );
    const root = await adapter.send(
      command("ListObjectsV2", { Bucket: bucket, Delimiter: "/" }),
    );
    assert.deepEqual(root.CommonPrefixes, [{ Prefix: "folder/" }]);
    const downloaded = await adapter.send(
      command("GetObject", {
        Bucket: bucket,
        Key: "folder/source.bin",
        IfMatch: head.ETag,
      }),
    );
    assert.deepEqual(await collect(downloaded.Body), bytes);
    for (const guard of [{ IfNoneMatch: "*" }, { IfMatch: '"outdated"' }]) {
      await assert.rejects(
        adapter.upload({
          Bucket: bucket,
          Key: "folder/source.bin",
          Body: Readable.from([Buffer.from("wrong")]),
          ...guard,
        }),
        (error) => error.$metadata?.httpStatusCode === 412,
      );
    }
    const copyInput = {
      Bucket: bucket,
      Key: "copied.bin",
      CopySource: `${bucket}/folder/source.bin`,
      CopySourceIfMatch: head.ETag,
      IfNoneMatch: "*",
    };
    const copied = await adapter.send(command("CopyObject", copyInput));
    assert.ok(copied.CopyObjectResult.ETag);
    assert.deepEqual(
      await collect(
        (
          await adapter.send(
            command("GetObject", { Bucket: bucket, Key: "copied.bin" }),
          )
        ).Body,
      ),
      bytes,
    );
    await assert.rejects(
      adapter.send(command("CopyObject", copyInput)),
      (error) => error.$metadata?.httpStatusCode === 412,
    );
    await assert.rejects(
      adapter.send(
        command("CopyObject", {
          ...copyInput,
          Key: "bad-copy.bin",
          CopySourceIfMatch: '"outdated"',
        }),
      ),
      (error) => error.$metadata?.httpStatusCode === 412,
    );
    const details = await objectTools.details(adapter, {
      profile: "test",
      bucket,
      key: "copied.bin",
    });
    await objectTools.metadata(adapter, {
      profile: "test",
      bucket,
      key: "copied.bin",
      expectedSnapshot: details.metadataSnapshot,
      metadata: { "custom-key": "new value" },
      contentType: "image/png",
    });
    const updated = await adapter.send(
      command("HeadObject", { Bucket: bucket, Key: "copied.bin" }),
    );
    assert.equal(updated.ContentType, "image/png");
    assert.equal(updated.CacheControl, "private");
    assert.deepEqual(updated.Metadata, { "custom-key": "new value" });
    assert.deepEqual(
      await collect(
        (
          await adapter.send(
            command("GetObject", { Bucket: bucket, Key: "copied.bin" }),
          )
        ).Body,
      ),
      bytes,
    );
    const first = await adapter.send(
      command("ListObjectsV2", { Bucket: bucket, MaxKeys: 1 }),
    );
    assert.ok(first.NextContinuationToken);
    const second = await adapter.send(
      command("ListObjectsV2", {
        Bucket: bucket,
        MaxKeys: 1,
        ContinuationToken: first.NextContinuationToken,
      }),
    );
    assert.notEqual(first.Contents[0].Key, second.Contents[0].Key);
    const signed = await adapter.signedUrl(
      { Bucket: bucket, Key: "copied.bin" },
      60,
    );
    const response = await fetch(signed);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "s3browser-azure-sync-"),
    );
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    await fs.writeFile(path.join(directory, "source.bin"), bytes);
    const syncListing = await adapter.send(
      command("ListObjectsV2", { Bucket: bucket, Prefix: "folder/" }),
    );
    const syncHead = await adapter.send(
      command("HeadObject", { Bucket: bucket, Key: "folder/source.bin" }),
    );
    assert.equal(syncListing.Contents[0].ETag, syncHead.ETag);
    assert.equal(syncListing.Contents[0].Size, syncHead.ContentLength);
    const comparison = await sync.compare(adapter, {
      profile: "test",
      bucket,
      prefix: "folder/",
      source: directory,
    });
    assert.equal(comparison.counts.unchanged, 1);
    assert.equal(comparison.entries.length, 0);
    await assert.rejects(
      adapter.send(
        command("DeleteObject", {
          Bucket: bucket,
          Key: "copied.bin",
          IfMatch: '"outdated"',
        }),
      ),
      (error) => error.$metadata?.httpStatusCode === 412,
    );
    await adapter.send(
      command("DeleteObject", {
        Bucket: bucket,
        Key: "copied.bin",
        IfMatch: updated.ETag,
      }),
    );
    await assert.rejects(
      adapter.send(
        command("HeadObject", { Bucket: bucket, Key: "copied.bin" }),
      ),
      (error) => error.$metadata?.httpStatusCode === 404,
    );
  },
);
