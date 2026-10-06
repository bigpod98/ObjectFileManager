const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Readable, Writable } = require("node:stream");
const commands = require("@aws-sdk/client-s3");
const { client } = require("../src/providers/gcs.cjs");
const payloadChecksum = new (require("@google-cloud/storage").CRC32C)();
payloadChecksum.update(Buffer.from("payload"));

const profile = {
  serviceAccountJson: JSON.stringify({
    type: "service_account",
    project_id: "example-project",
    client_email: "test@example.test",
    private_key: "test-key",
  }),
};
const metadata = {
  name: "folder/a?b.txt",
  generation: "17200000000000001",
  metageneration: "3",
  size: "7",
  crc32c: payloadChecksum.toString(),
  md5Hash: "Mhw89IbtUJFk7eweGYH+yA==",
  updated: "2026-10-01T12:00:00Z",
  contentType: "text/plain",
  metadata: { owner: "test" },
};
const revision = '"gcs:17200000000000001:3"';

function fixture(t, respond, write) {
  const requests = [];
  const files = [];
  class Storage {
    constructor(options) {
      this.options = options;
      this.authClient = {
        request: async (options) => {
          requests.push(options);
          return { data: await respond(options, requests.length) };
        },
      };
    }
    bucket(bucket) {
      return {
        file: (key) => {
          const file = {
            metadata: { ...metadata },
            createWriteStream(options) {
              files.push({ bucket, key, options });
              return write
                ? write(file, options)
                : new Writable({
                    write(chunk, encoding, done) {
                      done();
                    },
                  });
            },
            async getSignedUrl(options) {
              files.push({ bucket, key, options });
              return ["https://storage.googleapis.com/signed"];
            },
          };
          return file;
        },
      };
    }
  }
  t.mock.getter(require("@google-cloud/storage"), "Storage", () => Storage);
  return { adapter: client(profile), requests, files };
}

function send(adapter, name, input, options) {
  return adapter.send(new commands[name](input), options);
}

test("GCS validates service account credentials without falling back to ambient credentials", () => {
  for (const value of [
    undefined,
    "{broken",
    "null",
    "{}",
    '{"type":"authorized_user"}',
  ])
    assert.throws(
      () => client({ serviceAccountJson: value }),
      /service account/,
    );
});

test("GCS bucket and folder listings preserve pagination and exact revision IDs", async (t) => {
  const { adapter, requests } = fixture(t, (options) => {
    const url = new URL(options.url);
    if (url.pathname.endsWith("/b"))
      return url.searchParams.has("pageToken")
        ? { items: [{ name: "second" }] }
        : { items: [{ name: "first" }], nextPageToken: "bucket-page" };
    return {
      items: [metadata],
      prefixes: ["folder/sub/"],
      nextPageToken: "next+page",
    };
  });
  const buckets = await send(adapter, "ListBucketsCommand", {});
  assert.deepEqual(
    buckets.Buckets.map((item) => item.Name),
    ["first", "second"],
  );
  assert.equal(
    new URL(requests[0].url).searchParams.get("project"),
    "example-project",
  );
  const page = await send(adapter, "ListObjectsV2Command", {
    Bucket: "bucket",
    Prefix: "folder/",
    Delimiter: "/",
    ContinuationToken: "previous+page",
  });
  assert.equal(page.Contents[0].ETag, revision);
  assert.equal(page.Contents[0].Size, 7);
  assert.deepEqual(page.CommonPrefixes, [{ Prefix: "folder/sub/" }]);
  assert.equal(page.NextContinuationToken, "next+page");
  assert.equal(
    new URL(requests[2].url).searchParams.get("pageToken"),
    "previous+page",
  );
});

test("GCS downloads pin media to the metadata revision and preserve raw gzip bytes", async (t) => {
  const { adapter, requests } = fixture(t, (options) =>
    options.responseType === "stream" ? Readable.from(["payload"]) : metadata,
  );
  const response = await send(adapter, "GetObjectCommand", {
    Bucket: "bucket",
    Key: metadata.name,
    IfMatch: revision,
  });
  assert.equal(response.VersionId, metadata.generation);
  assert.equal(response.ChecksumMD5, metadata.md5Hash);
  assert.equal(response.ChecksumType, "FULL_OBJECT");
  assert.deepEqual(response.Metadata, { owner: "test" });
  const chunks = [];
  for await (const chunk of response.Body) chunks.push(chunk);
  assert.equal(chunks.join(""), "payload");
  for (const request of requests) {
    const url = new URL(request.url);
    assert.ok(url.pathname.endsWith("folder%2Fa%3Fb.txt"));
    assert.equal(
      url.searchParams.get("ifGenerationMatch"),
      metadata.generation,
    );
    assert.equal(url.searchParams.get("ifMetagenerationMatch"), "3");
  }
  assert.equal(
    new URL(requests[1].url).searchParams.get("generation"),
    metadata.generation,
  );
  assert.equal(requests[1].compress, false);
  assert.equal(requests[1].headers["Accept-Encoding"], "gzip");
});

test("GCS guarded deletion uses generation and metadata preconditions and fails closed", async (t) => {
  const { adapter, requests } = fixture(t, () => {
    throw Object.assign(new Error("changed"), { response: { status: 412 } });
  });
  await assert.rejects(
    send(adapter, "DeleteObjectCommand", {
      Bucket: "b",
      Key: "k",
      IfMatch: revision,
    }),
    (error) =>
      error.name === "PreconditionFailed" &&
      error.$metadata.httpStatusCode === 412,
  );
  assert.equal(requests.length, 1);
  assert.equal(
    new URL(requests[0].url).searchParams.get("ifMetagenerationMatch"),
    "3",
  );
  await assert.rejects(
    send(adapter, "DeleteObjectCommand", {
      Bucket: "b",
      Key: "k",
      IfMatch: '"s3-etag"',
    }),
    /Refresh the object/,
  );
  assert.equal(requests.length, 1);
});

test("GCS rewrite retains both source and destination guards across large copy continuations", async (t) => {
  const { adapter, requests } = fixture(t, (options, count) =>
    count === 1
      ? { done: false, rewriteToken: "rewrite+next" }
      : {
          done: true,
          resource: { ...metadata, generation: "17200000000000002" },
        },
  );
  const result = await send(adapter, "CopyObjectCommand", {
    Bucket: "dest",
    Key: "a?b.txt",
    CopySource: "src/folder/a%3Fb.txt?versionId=17100000000000001",
    CopySourceIfMatch: '"gcs:17100000000000001:2"',
    IfMatch: revision,
    MetadataDirective: "REPLACE",
    Metadata: { updated: "yes" },
    ContentType: "text/plain",
  });
  assert.equal(result.VersionId, "17200000000000002");
  for (const options of requests) {
    const url = new URL(options.url);
    assert.equal(url.searchParams.get("sourceGeneration"), "17100000000000001");
    assert.equal(
      url.searchParams.get("ifSourceGenerationMatch"),
      "17100000000000001",
    );
    assert.equal(url.searchParams.get("ifSourceMetagenerationMatch"), "2");
    assert.equal(
      url.searchParams.get("ifGenerationMatch"),
      metadata.generation,
    );
    assert.equal(url.searchParams.get("ifMetagenerationMatch"), "3");
    assert.deepEqual(options.data, {
      contentType: "text/plain",
      metadata: { updated: "yes" },
    });
  }
  assert.equal(
    new URL(requests[1].url).searchParams.get("rewriteToken"),
    "rewrite+next",
  );
});

test("GCS copy to absent destination has an atomic generation-zero guard", async (t) => {
  const { adapter, requests } = fixture(t, () => ({
    done: true,
    resource: metadata,
  }));
  await send(adapter, "CopyObjectCommand", {
    Bucket: "b",
    Key: "d",
    CopySource: "b/s",
    CopySourceIfMatch: revision,
    IfNoneMatch: "*",
  });
  assert.equal(
    new URL(requests[0].url).searchParams.get("ifGenerationMatch"),
    "0",
  );
});

test("GCS resumable uploads stream bytes, metadata, and exact preconditions", async (t) => {
  const chunks = [];
  const { adapter, files } = fixture(
    t,
    () => {},
    () =>
      new Writable({
        write(chunk, encoding, done) {
          chunks.push(chunk);
          done();
        },
      }),
  );
  const progress = [];
  const result = await adapter.upload(
    {
      Bucket: "b",
      Key: "k",
      Body: Readable.from([Buffer.from("pay"), Buffer.from("load")]),
      Metadata: { token: "durable" },
      IfMatch: revision,
    },
    { onProgress: (bytes) => progress.push(bytes) },
  );
  assert.equal(Buffer.concat(chunks).toString(), "payload");
  assert.deepEqual(progress, [3, 7]);
  assert.equal(result.ETag, revision);
  assert.deepEqual(files[0].options.preconditionOpts, {
    ifGenerationMatch: metadata.generation,
    ifMetagenerationMatch: "3",
  });
  assert.deepEqual(files[0].options.metadata, {
    metadata: { token: "durable" },
  });
  assert.equal(files[0].options.resumable, true);
  assert.equal(files[0].options.validation, false);
});

test("GCS cancellation interrupts streaming uploads and prevents later requests", async (t) => {
  const controller = new AbortController();
  const { adapter } = fixture(
    t,
    () => {},
    () =>
      new Writable({
        write(chunk, encoding, done) {
          controller.abort();
          done();
        },
      }),
  );
  await assert.rejects(
    adapter.upload(
      { Bucket: "b", Key: "k", Body: Readable.from(["payload"]) },
      { abortSignal: controller.signal },
    ),
    { name: "AbortError" },
  );
  adapter.destroy();
  await assert.rejects(
    send(adapter, "HeadObjectCommand", { Bucket: "b", Key: "k" }),
    { name: "AbortError" },
  );
});

test("GCS versions retain native pagination, archived state, and signed links", async (t) => {
  const { adapter, requests, files } = fixture(t, () => ({
    items: [
      { ...metadata, timeDeleted: "2026-10-02T00:00:00Z" },
      { ...metadata, generation: "17200000000000002" },
    ],
    nextPageToken: "version-next",
  }));
  const page = await send(adapter, "ListObjectVersionsCommand", {
    Bucket: "b",
    Prefix: "k",
    KeyMarker: "k",
    VersionIdMarker: "version-previous",
  });
  assert.deepEqual(
    page.Versions.map((item) => item.IsLatest),
    [false, true],
  );
  assert.equal(page.NextKeyMarker, "k");
  assert.equal(page.NextVersionIdMarker, "version-next");
  assert.equal(
    new URL(requests[0].url).searchParams.get("pageToken"),
    "version-previous",
  );
  assert.equal(
    await adapter.signedUrl({ Bucket: "b", Key: "k" }, 60),
    "https://storage.googleapis.com/signed",
  );
  assert.equal(files[0].options.version, "v4");
  assert.equal(adapter.capabilities.multipart, false);
  await assert.rejects(
    send(adapter, "ListMultipartUploadsCommand", { Bucket: "b" }),
    { name: "NotSupported" },
  );
});

test("GCS actual SDK sends both revision guards during resumable session creation", async (t) => {
  const sdk = require("@google-cloud/storage");
  const ActualStorage = sdk.Storage;
  const bytes = Buffer.from("payload");
  const crc = new sdk.CRC32C();
  crc.update(bytes);
  const requests = [];
  class Storage extends ActualStorage {
    constructor(options) {
      super(options);
      this.authClient.request = async (request) => {
        requests.push(request);
        if (request.method === "POST")
          return {
            status: 200,
            headers: {
              location: "https://storage.googleapis.com/upload/test-session",
            },
            data: {},
          };
        const chunks = [];
        for await (const chunk of request.body) chunks.push(chunk);
        assert.deepEqual(Buffer.concat(chunks), bytes);
        return {
          status: 200,
          headers: {},
          data: { ...metadata, crc32c: crc.toString() },
        };
      };
    }
  }
  t.mock.getter(sdk, "Storage", () => Storage);
  const result = await client(profile).upload({
    Bucket: "b",
    Key: "k",
    Body: Readable.from([bytes]),
    IfMatch: revision,
  });
  assert.equal(result.ETag, revision);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].params.ifGenerationMatch, metadata.generation);
  assert.equal(requests[0].params.ifMetagenerationMatch, "3");
});

test("GCS actual SDK checksum failures never delete the live object", async (t) => {
  for (const checksum of [undefined, "AAAAAA=="])
    await t.test(
      checksum === undefined ? "missing checksum" : "mismatched checksum",
      async (t) => {
        const sdk = require("@google-cloud/storage");
        const ActualStorage = sdk.Storage;
        let deletes = 0;
        t.mock.method(sdk.File.prototype, "delete", () => {
          deletes++;
          throw new Error("Unexpected live object deletion");
        });
        const requests = [];
        class Storage extends ActualStorage {
          constructor(options) {
            super(options);
            this.authClient.request = async (request) => {
              requests.push(request);
              if (request.method === "POST")
                return {
                  status: 200,
                  headers: {
                    location:
                      "https://storage.googleapis.com/upload/test-session",
                  },
                  data: {},
                };
              for await (const chunk of request.body) assert.ok(chunk.length);
              return {
                status: 200,
                headers: {},
                data: { ...metadata, crc32c: checksum },
              };
            };
          }
        }
        t.mock.getter(sdk, "Storage", () => Storage);
        await assert.rejects(
          client(profile).upload({
            Bucket: "b",
            Key: "k",
            Body: Readable.from([Buffer.from("payload")]),
            IfMatch: revision,
          }),
          /checksum is missing or does not match/,
        );
        assert.equal(deletes, 0);
        assert.deepEqual(
          requests.map((request) => request.method),
          ["POST", "PUT"],
        );
      },
    );
});

test("GCS rejects range reads before making any request", async (t) => {
  const { adapter, requests } = fixture(t, () => metadata);
  await assert.rejects(
    send(adapter, "GetObjectCommand", {
      Bucket: "b",
      Key: "k",
      Range: "bytes=0-2",
    }),
    { name: "NotSupported" },
  );
  assert.equal(requests.length, 0);
});
