const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const { createHash } = require("node:crypto");
const commands = require("@aws-sdk/client-s3");
const { client } = require("../src/providers/azure.cjs");

function fixture(overrides = {}) {
  const calls = [];
  const body = Readable.from([Buffer.from([0, 255, 1, 128])]);
  const head = {
    etag: '"source"',
    contentLength: 4,
    contentType: "image/png",
    cacheControl: "max-age=60",
    versionId: "v1",
    blobType: "BlockBlob",
    metadata: { existing: "value" },
    tagCount: 1,
  };
  const nativeBlob = {
    url: "https://account.blob.core.windows.net/container/source",
    withVersion(version) {
      calls.push(["version", version]);
      return this;
    },
    async getProperties(options) {
      calls.push(["head", options]);
      return head;
    },
    async getTags(options) {
      calls.push(["tags", options]);
      return { tags: { label: "keep" } };
    },
    async download(offset, count, options) {
      calls.push(["download", offset, count, options]);
      return { ...head, readableStreamBody: body };
    },
    async stageBlock(id, data, length, options) {
      calls.push(["stage", id, Buffer.from(data), length, options]);
    },
    async commitBlockList(ids, options) {
      calls.push(["commit", ids, options]);
      return { etag: '"new"', versionId: "v2" };
    },
    async uploadData(data, options) {
      calls.push(["uploadData", data, options]);
      return { etag: '"new"' };
    },
    async delete(options) {
      calls.push(["delete", options]);
    },
    async abortCopyFromURL(copyId, options) {
      calls.push(["abortCopy", copyId, options]);
    },
    async startCopyFromURL(url, options) {
      calls.push(["copy", url, options]);
      return {
        etag: '"new"',
        versionId: "v2",
        copyId: "copy-id",
        copyStatus: "success",
      };
    },
    ...overrides,
  };
  let page = { segment: { blobItems: [], blobPrefixes: [] } };
  const pages = (name, options) => ({
    byPage(paging) {
      calls.push([name, options, paging]);
      return {
        async next() {
          return { value: page };
        },
      };
    },
  });
  const service = {
    async *listContainers(options) {
      calls.push(["containers", options]);
      yield { name: "one" };
      yield { name: "two" };
    },
    getContainerClient(name) {
      calls.push(["container", name]);
      return {
        getBlockBlobClient(key) {
          calls.push(["blob", key]);
          return nativeBlob;
        },
        listBlobsFlat(options) {
          return pages("flat", options);
        },
        listBlobsByHierarchy(delimiter, options) {
          calls.push(["delimiter", delimiter]);
          return pages("hierarchy", options);
        },
      };
    },
  };
  return {
    adapter: client(
      { bucket: "default" },
      { service, credential: {}, sdk: {} },
    ),
    calls,
    body,
    head,
    setPage(value) {
      page = value;
    },
  };
}
const command = (name, input = {}) => new commands[name + "Command"](input);

test("Azure lists containers and translates flat/hierarchical continuation pages", async () => {
  const f = fixture();
  assert.deepEqual(
    (await f.adapter.send(command("ListBuckets"))).Buckets.map((x) => x.Name),
    ["one", "two"],
  );
  const date = new Date("2026-01-01");
  f.setPage({
    continuationToken: "next",
    segment: {
      blobItems: [
        {
          name: "folder/object",
          properties: { contentLength: 12, etag: '"etag"', lastModified: date },
        },
      ],
      blobPrefixes: [{ name: "folder/" }],
    },
  });
  const signal = new AbortController().signal;
  const result = await f.adapter.send(
    command("ListObjectsV2", {
      Bucket: "bucket",
      Prefix: "f",
      Delimiter: "/",
      MaxKeys: 25,
      ContinuationToken: "previous",
    }),
    { abortSignal: signal },
  );
  assert.equal(result.NextContinuationToken, "next");
  assert.equal(result.IsTruncated, true);
  assert.deepEqual(result.Contents, [
    { Key: "folder/object", Size: 12, ETag: '"etag"', LastModified: date },
  ]);
  assert.deepEqual(result.CommonPrefixes, [{ Prefix: "folder/" }]);
  assert.deepEqual(
    f.calls.find((x) => x[0] === "hierarchy"),
    [
      "hierarchy",
      { prefix: "f", abortSignal: signal },
      { continuationToken: "previous", maxPageSize: 25 },
    ],
  );
  await f.adapter.send(command("ListObjectsV2", {}));
  assert.ok(f.calls.some((x) => x[0] === "flat"));
});

test("Azure downloads preserve byte streams, version selection, ranges, and source conditions", async () => {
  const f = fixture();
  const signal = new AbortController().signal;
  const result = await f.adapter.send(
    command("GetObject", {
      Bucket: "container",
      Key: "file",
      VersionId: "v1",
      IfMatch: '"source"',
      Range: "bytes=1-3",
    }),
    { abortSignal: signal },
  );
  assert.equal(result.Body, f.body);
  assert.equal(result.ContentType, "image/png");
  assert.deepEqual(
    f.calls.find((x) => x[0] === "download"),
    [
      "download",
      1,
      3,
      { abortSignal: signal, conditions: { ifMatch: '"source"' } },
    ],
  );
  assert.deepEqual(
    f.calls.find((x) => x[0] === "version"),
    ["version", "v1"],
  );
  await assert.rejects(
    f.adapter.send(command("GetObject", { Key: "file", Range: "bytes=-10" })),
    /single byte range/,
  );
});

test("Azure streaming uploads retain destination guards, headers, metadata and progress", async () => {
  const f = fixture();
  const signal = new AbortController().signal;
  const progress = [];
  const result = await f.adapter.upload(
    {
      Key: "file",
      Body: f.body,
      IfNoneMatch: "*",
      Metadata: { "s3browser-upload-token": "token", unicode: "é" },
      ContentType: "image/png",
      CacheControl: "private",
    },
    { abortSignal: signal, onProgress: (n) => progress.push(n) },
  );
  const options = f.calls.find((x) => x[0] === "commit")[2];
  assert.equal(options.abortSignal, signal);
  assert.deepEqual(options.conditions, { ifNoneMatch: "*" });
  assert.deepEqual(options.blobHTTPHeaders, {
    blobContentType: "image/png",
    blobCacheControl: "private",
    blobContentMD5: createHash("md5")
      .update(Buffer.from([0, 255, 1, 128]))
      .digest(),
  });
  f.head.contentMD5 = options.blobHTTPHeaders.blobContentMD5;
  const checksumHead = await f.adapter.send(
    command("HeadObject", { Key: "file" }),
  );
  assert.equal(checksumHead.ChecksumType, "FULL_OBJECT");
  assert.equal(checksumHead.ChecksumMD5, f.head.contentMD5.toString("base64"));
  assert.ok(
    Object.keys(options.metadata).every((key) =>
      /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key),
    ),
  );
  f.head.metadata = options.metadata;
  assert.deepEqual(
    (await f.adapter.send(command("HeadObject", { Key: "file" }))).Metadata,
    { "s3browser-upload-token": "token", unicode: "é" },
  );
  assert.deepEqual(
    f.calls.find((x) => x[0] === "stage")[2],
    Buffer.from([0, 255, 1, 128]),
  );
  assert.deepEqual(progress, [4]);
  assert.equal(result.VersionId, "v2");
});

test("Azure empty directory uploads and conditional deletes use native guards", async () => {
  const f = fixture();
  await f.adapter.send(
    command("PutObject", {
      Key: "folder/",
      Body: Buffer.alloc(0),
      ContentType: "application/x-directory",
      IfNoneMatch: "*",
    }),
  );
  const upload = f.calls.find((x) => x[0] === "uploadData");
  assert.equal(upload[1].length, 0);
  assert.deepEqual(upload[2].conditions, { ifNoneMatch: "*" });
  await f.adapter.send(
    command("DeleteObject", { Key: "file", IfMatch: '"reviewed"' }),
  );
  assert.deepEqual(f.calls.find((x) => x[0] === "delete")[1].conditions, {
    ifMatch: '"reviewed"',
  });
});

test("Azure staged uploads propagate cancellation and never commit incomplete input", async () => {
  const controller = new AbortController();
  let staged = false;
  const cancelled = fixture({
    async stageBlock(id, bytes, size, options) {
      assert.equal(options.abortSignal, controller.signal);
      staged = true;
      controller.abort();
      options.abortSignal.throwIfAborted();
    },
  });
  await assert.rejects(
    cancelled.adapter.upload(
      { Key: "file", Body: cancelled.body },
      { abortSignal: controller.signal },
    ),
    { name: "AbortError" },
  );
  assert.ok(staged);
  assert.ok(!cancelled.calls.some((x) => x[0] === "commit"));
  const changed = fixture();
  await assert.rejects(
    changed.adapter.upload({
      Key: "file",
      Body: changed.body,
      ContentLength: 5,
    }),
    /length changed/,
  );
  assert.ok(!changed.calls.some((x) => x[0] === "commit"));
  const broken = fixture();
  const source = Readable.from(
    (async function* () {
      yield Buffer.alloc(8 * 1024 * 1024);
      throw new Error("Checksum changed");
    })(),
  );
  await assert.rejects(
    broken.adapter.upload({ Key: "file", Body: source }),
    /Checksum changed/,
  );
  assert.ok(!broken.calls.some((x) => x[0] === "commit"));
});

test("Azure staged uploads use unique ordered blocks and condition only the final commit", async () => {
  const f = fixture();
  const bytes = Buffer.alloc(8 * 1024 * 1024 + 13, 0xa5);
  const signal = new AbortController().signal;
  await f.adapter.upload(
    {
      Key: "file",
      Body: Readable.from([bytes]),
      ContentLength: bytes.length,
      IfMatch: '"reviewed"',
    },
    { abortSignal: signal },
  );
  const stages = f.calls.filter((x) => x[0] === "stage");
  assert.deepEqual(
    stages.map((x) => x[3]),
    [8 * 1024 * 1024, 13],
  );
  assert.notEqual(stages[0][1], stages[1][1]);
  assert.deepEqual(Buffer.concat(stages.map((x) => x[2])), bytes);
  assert.ok(stages.every((x) => x[4].abortSignal === signal));
  const commit = f.calls.find((x) => x[0] === "commit");
  assert.deepEqual(
    commit[1],
    stages.map((x) => x[1]),
  );
  assert.deepEqual(commit[2].conditions, { ifMatch: '"reviewed"' });
});

test("Azure server copy checks both guards and waits for successful completion", async () => {
  const f = fixture();
  const result = await f.adapter.send(
    command("CopyObject", {
      Bucket: "target",
      Key: "copy",
      CopySource: "container/path%20with%20space%3Fname?versionId=v1",
      CopySourceIfMatch: '"source"',
      IfNoneMatch: "*",
    }),
  );
  const options = f.calls.find((x) => x[0] === "copy")[2];
  assert.deepEqual(options.conditions, { ifNoneMatch: "*" });
  assert.deepEqual(options.sourceConditions, { ifMatch: '"source"' });
  assert.deepEqual(options.tags, { label: "keep" });
  assert.ok(
    f.calls.some((x) => x[0] === "blob" && x[1] === "path with space?name"),
  );
  assert.equal(result.CopyObjectResult.ETag, '"new"');
  const failure = fixture({
    async startCopyFromURL() {
      return {
        copyId: "copy-id",
        copyStatus: "failed",
        copyStatusDescription: "Source changed",
      };
    },
  });
  await assert.rejects(
    failure.adapter.send(
      command("CopyObject", { Key: "copy", CopySource: "container/source" }),
    ),
    /Source changed/,
  );
});

test("Azure metadata replacement commits content and metadata atomically with guards", async () => {
  const f = fixture();
  await f.adapter.send(
    command("CopyObject", {
      Bucket: "container",
      Key: "source",
      CopySource: "container/source?versionId=v1",
      CopySourceIfMatch: '"source"',
      IfMatch: '"source"',
      MetadataDirective: "REPLACE",
      Metadata: { changed: "yes" },
      ContentType: "application/octet-stream",
    }),
  );
  assert.equal(
    f.calls.filter((x) => x[0] === "version").length,
    1,
    "only the source should select a historical version",
  );
  assert.deepEqual(f.calls.find((x) => x[0] === "download")[3].conditions, {
    ifMatch: '"source"',
  });
  const options = f.calls.find((x) => x[0] === "commit")[2];
  assert.deepEqual(options.conditions, { ifMatch: '"source"' });
  assert.equal(
    options.blobHTTPHeaders.blobContentType,
    "application/octet-stream",
  );
  assert.equal(options.blobHTTPHeaders.blobCacheControl, "max-age=60");
  assert.deepEqual(options.tags, { label: "keep" });
  f.head.metadata = options.metadata;
  assert.deepEqual(
    (await f.adapter.send(command("HeadObject", { Key: "source" }))).Metadata,
    { changed: "yes" },
  );
  assert.ok(!f.calls.some((x) => x[0] === "copy"));
});

test("Azure pending copies reject cancellation and destination replacement", async () => {
  const controller = new AbortController();
  const cancelled = fixture({
    async startCopyFromURL() {
      controller.abort();
      return { copyId: "original", copyStatus: "pending" };
    },
  });
  await assert.rejects(
    cancelled.adapter.send(
      command("CopyObject", {
        Key: "copy",
        CopySource: "container/source",
        IfNoneMatch: "*",
      }),
      { abortSignal: controller.signal },
    ),
    { name: "AbortError" },
  );
  const cleanup = cancelled.calls.find((x) => x[0] === "abortCopy");
  assert.equal(cleanup[1], "original");
  assert.notEqual(cleanup[2].abortSignal, controller.signal);
  assert.equal(cleanup[2].abortSignal.aborted, false);
  assert.ok(!cancelled.calls.some((x) => x[0] === "delete"));
  let requests = 0;
  const replaced = fixture({
    async getProperties() {
      return ++requests === 1
        ? { etag: '"source"' }
        : { copyId: "replacement", copyStatus: "success" };
    },
    async startCopyFromURL() {
      return { copyId: "original", copyStatus: "pending" };
    },
  });
  await assert.rejects(
    replaced.adapter.send(
      command("CopyObject", {
        Key: "copy",
        CopySource: "container/source",
        IfNoneMatch: "*",
      }),
    ),
    (error) =>
      error.$metadata?.httpStatusCode === 412 &&
      /destination changed/.test(error.message),
  );
  assert.ok(
    !replaced.calls.some((x) => ["abortCopy", "delete"].includes(x[0])),
  );
});

test("Azure cancellation tolerates completed or replaced copies and reports cleanup failures", async () => {
  for (const code of [
    "NoPendingCopyOperation",
    "CopyIdMismatch",
    "ServerBusy",
  ]) {
    const controller = new AbortController();
    let cleanupId;
    const f = fixture({
      async startCopyFromURL() {
        controller.abort();
        return { copyId: "original", copyStatus: "pending" };
      },
      async abortCopyFromURL(copyId) {
        cleanupId = copyId;
        throw Object.assign(new Error(code), { details: { errorCode: code } });
      },
    });
    await assert.rejects(
      f.adapter.send(
        command("CopyObject", {
          Key: "copy",
          CopySource: "container/source",
        }),
        { abortSignal: controller.signal },
      ),
      (error) => {
        assert.equal(error.name, "AbortError");
        assert.equal(
          /cancellation also failed/.test(error.message),
          code === "ServerBusy",
        );
        return true;
      },
    );
    assert.equal(cleanupId, "original");
    assert.ok(!f.calls.some((x) => x[0] === "delete"));
  }
});

test("Azure metadata saves retain interoperable external keys and escape reserved names", async () => {
  const f = fixture();
  const metadata = {
    author: "external client",
    "custom-key": "a value",
    unicode: "é",
    s3browser_metadata_encoding: "v1",
    s3browser_meta_6162: "literal reserved key",
    S3Browser_Meta_6162: "case variant",
  };
  f.head.metadata = { author: metadata.author };
  assert.deepEqual(
    (await f.adapter.send(command("HeadObject", { Key: "source" }))).Metadata,
    { author: metadata.author },
  );
  await f.adapter.send(
    command("CopyObject", {
      Key: "source",
      CopySource: "container/source",
      MetadataDirective: "REPLACE",
      Metadata: metadata,
      IfMatch: '"source"',
    }),
  );
  const stored = f.calls.find((x) => x[0] === "commit")[2].metadata;
  assert.equal(stored.author, "external client");
  assert.equal(stored.s3browser_metadata_encoding, "v1");
  assert.equal(stored.s3browser_meta_6162, undefined);
  f.head.metadata = stored;
  assert.deepEqual(
    (await f.adapter.send(command("HeadObject", { Key: "source" }))).Metadata,
    metadata,
  );
  await f.adapter.upload({ Key: "plain", Metadata: { author: "plain" } });
  assert.deepEqual(f.calls.find((x) => x[0] === "uploadData")[2].metadata, {
    author: "plain",
  });
});

test("Azure creation conflicts normalize both SDK error code representations", async () => {
  for (const details of [
    { code: "BlobAlreadyExists" },
    { details: { errorCode: "BlobAlreadyExists" } },
  ]) {
    const f = fixture({
      async uploadData() {
        throw Object.assign(new Error("already exists"), {
          statusCode: 409,
          ...details,
        });
      },
    });
    await assert.rejects(
      f.adapter.upload({ Key: "file", IfNoneMatch: "*" }),
      (error) =>
        error.name === "PreconditionFailed" &&
        error.$metadata.httpStatusCode === 412,
    );
  }
});

test("Azure version history retains service pagination markers", async () => {
  const f = fixture();
  f.setPage({
    continuationToken: "opaque",
    segment: {
      blobItems: [
        {
          name: "file",
          versionId: "v1",
          isCurrentVersion: true,
          properties: { contentLength: 4, etag: '"source"' },
        },
      ],
    },
  });
  const first = await f.adapter.send(
    command("ListObjectVersions", {
      Bucket: "container",
      Prefix: "file",
      MaxKeys: 1,
    }),
  );
  assert.equal(first.Versions[0].IsLatest, true);
  assert.equal(first.NextKeyMarker, "file");
  await f.adapter.send(
    command("ListObjectVersions", {
      Prefix: "file",
      KeyMarker: first.NextKeyMarker,
      VersionIdMarker: first.NextVersionIdMarker,
    }),
  );
  assert.equal(
    f.calls.filter((x) => x[0] === "flat")[1][2].continuationToken,
    "opaque",
  );
});

test("Azure errors preserve HTTP status, cancellation, and unsupported operations", async () => {
  const f = fixture({
    async delete() {
      throw Object.assign(new Error("condition failed"), { statusCode: 412 });
    },
  });
  await assert.rejects(
    f.adapter.send(
      command("DeleteObject", { Key: "file", IfMatch: '"source"' }),
    ),
    (error) =>
      error.name === "PreconditionFailed" &&
      error.$metadata.httpStatusCode === 412,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    f.adapter.send(command("ListBuckets"), { abortSignal: controller.signal }),
    { name: "AbortError" },
  );
  await assert.rejects(
    f.adapter.send(command("ListMultipartUploads", { Bucket: "container" })),
    { name: "UnsupportedOperation" },
  );
  await assert.rejects(
    f.adapter.upload({ Key: "file", Expires: new Date() }),
    /Expires cannot be applied/,
  );
});

test("Azure signs read-only download URLs for custom endpoints without exposing the account key", async () => {
  const key = Buffer.alloc(32, 7).toString("base64");
  const adapter = client({
    accountName: "account",
    accountKey: key,
    endpoint: "http://127.0.0.1:10000/account",
  });
  const signed = new URL(
    await adapter.signedUrl(
      { Bucket: "container", Key: "folder/file.txt" },
      60,
    ),
  );
  assert.equal(signed.pathname, "/account/container/folder/file.txt");
  assert.equal(signed.searchParams.get("sp"), "r");
  assert.ok(signed.searchParams.get("sig"));
  assert.ok(!signed.toString().includes(key));
});
