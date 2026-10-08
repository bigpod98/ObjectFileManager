const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { transfer } = require("../src/storage.cjs");
const operations = require("../src/operations.cjs");
const objectTools = require("../src/object-tools.cjs");
const sync = require("../src/sync.cjs");
const { capabilities } = require("../src/provider-capabilities.cjs");

test("native uploads retain streaming, throttling, conditions and recovery metadata", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "native-transfer-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "object.txt");
  const bytes = Buffer.alloc(9 * 1024 ** 2, 42);
  await fs.writeFile(source, bytes);
  const signal = new AbortController().signal;
  let uploaded,
    throttled = 0,
    progress = 0;
  const sha256 = createHash("sha256").update(bytes).digest("base64");
  const client = {
    async upload(input, options) {
      assert.equal(options.abortSignal, signal);
      assert.equal(input.IfNoneMatch, "*");
      assert.equal(input.ContentLength, bytes.length);
      assert.equal(
        input.Metadata["objectfilemanager-upload-token"],
        "operation",
      );
      assert.equal(input.Metadata["objectfilemanager-sha256"], sha256);
      assert.ok(input.Body[Symbol.asyncIterator]);
      const chunks = [];
      for await (const chunk of input.Body) chunks.push(chunk);
      uploaded = Buffer.concat(chunks);
      options.onProgress(uploaded.length);
    },
    send() {
      throw new Error("Unexpected S3 transport");
    },
  };
  await transfer(
    client,
    {
      bucket: "container",
      overwrite: true,
      throttle: async (size) => {
        throttled += size;
      },
    },
    {
      source,
      key: "object.txt",
      size: bytes.length,
      expectedAbsent: true,
      uploadToken: "operation",
      sha256,
    },
    signal,
    (size) => {
      progress = size;
    },
  );
  assert.deepEqual(uploaded, bytes);
  assert.equal(throttled, bytes.length);
  assert.equal(progress, bytes.length);
});

test("native upload rejects changed local bytes before stream completion", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "native-changed-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "changed");
  await fs.writeFile(source, "new");
  let committed = false;
  await assert.rejects(
    transfer(
      {
        async upload(input) {
          for await (const chunk of input.Body) void chunk;
          committed = true;
        },
      },
      { bucket: "b", overwrite: true },
      {
        source,
        key: "changed",
        size: 3,
        sha256: createHash("sha256").update("old").digest("base64"),
      },
      new AbortController().signal,
      () => {},
    ),
    /Source content changed/,
  );
  assert.equal(committed, false);
});

test("native skip upload keeps create-only race protection", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "native-skip-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "object");
  await fs.writeFile(source, "bytes");
  const client = {
    async send() {
      throw Object.assign(new Error("missing"), {
        $metadata: { httpStatusCode: 404 },
      });
    },
    async upload(input) {
      assert.equal(input.IfNoneMatch, "*");
      throw Object.assign(new Error("already exists"), {
        $metadata: { httpStatusCode: 412 },
      });
    },
  };
  assert.equal(
    await transfer(
      client,
      { bucket: "b", overwrite: false },
      {
        source,
        key: "object",
        size: 5,
      },
      new AbortController().signal,
      () => {},
    ),
    "skipped",
  );
});

test("native large copy uses provider transport and retains both guards", async () => {
  let command;
  const result = await operations.copyObject(
    {
      upload() {},
      async send(value) {
        command = value;
        return { CopyObjectResult: { ETag: "new" }, VersionId: "v2" };
      },
    },
    {
      bucket: "b",
      key: "source",
      destinationKey: "target",
      size: 6 * 1024 ** 3,
      etag: "reviewed",
    },
  );
  assert.equal(command.constructor.name, "CopyObjectCommand");
  assert.equal(command.input.IfNoneMatch, "*");
  assert.equal(command.input.CopySourceIfMatch, "reviewed");
  assert.deepEqual(result, { etag: "new", versionId: "v2" });
});

test("unsupported reviewed Swift mutations fail before requests or partial copies", async () => {
  const client = {
    provider: "OpenStack Swift",
    send() {
      assert.fail("No remote request should be made");
    },
  };
  for (const action of ["move", "delete"]) {
    await assert.rejects(
      operations.preview(client, {
        action,
        bucket: "b",
        selection: [{ key: "a" }],
      }),
      /not supported safely/,
    );
    await assert.rejects(
      operations.execute(client, { action, bucket: "b", items: [] }),
      /not supported safely/,
    );
  }
  await assert.rejects(
    objectTools.metadata(client, {}),
    /not supported safely/,
  );
  await assert.rejects(
    objectTools.versions(client, {}),
    /not supported safely/,
  );
  await assert.rejects(
    sync.compare(client, { deleteRemote: true }),
    /not supported safely/,
  );
  await assert.rejects(
    sync.validate({ entries: [{ etag: "old" }] }, client),
    /not supported safely/,
  );
  await assert.rejects(
    objectTools.multipart(client, {}),
    /not supported safely/,
  );
});

test("signed links dispatch to native providers and validate expiry first", async () => {
  let called = 0;
  const client = {
    provider: "Azure Blob Storage",
    async signedUrl(input, lifetime) {
      called++;
      assert.deepEqual(input, { Bucket: "container", Key: "file" });
      assert.equal(lifetime, 60);
      return "https://example.com/signed";
    },
  };
  assert.equal(
    await objectTools.signedUrl(client, {
      bucket: "container",
      key: "file",
      expiresIn: 60,
    }),
    "https://example.com/signed",
  );
  await assert.rejects(
    objectTools.signedUrl(client, {
      bucket: "container",
      key: "file",
      expiresIn: 0,
    }),
    /lifetime/,
  );
  assert.equal(called, 1);
  assert.equal(capabilities({ provider: "OpenStack Swift" }).signedUrl, false);
  assert.equal(
    capabilities({ provider: "OpenStack Swift", swiftTempUrlKey: "key" })
      .signedUrl,
    true,
  );
  assert.equal(capabilities({}).multipart, true);
});
