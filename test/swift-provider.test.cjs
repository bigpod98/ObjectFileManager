const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { Readable } = require("node:stream");
const { createHmac } = require("node:crypto");
const { client } = require("../src/providers/swift.cjs");
const {
  ListBucketsCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
} = require("@aws-sdk/client-s3");

async function fixture(t, handler, { prefix = "", info } = {}) {
  const requests = [];
  const infoRequests = [];
  const server = http.createServer((req, res) => {
    assert.equal(req.headers["x-auth-token"], "test-token");
    if (req.url === `${prefix}/info`) {
      infoRequests.push(req);
      if (info) info(req, res);
      else res.end(JSON.stringify({ swift: { max_file_size: 5 * 1024 ** 3 } }));
      return;
    }
    requests.push(req);
    Promise.resolve(handler(req, res)).catch((e) => {
      res.destroy(e);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const profile = {
    endpoint: `http://127.0.0.1:${server.address().port}${prefix}/v1/AUTH_test`,
    swiftToken: "test-token",
    swiftTempUrlKey: "temp-secret",
  };
  const swift = client(profile);
  t.after(async () => {
    swift.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { swift, profile, requests, infoRequests };
}
async function body(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

test("Swift account and delimiter listings retain pagination and UTC timestamps", async (t) => {
  const { swift } = await fixture(t, (req, res) => {
    const url = new URL(req.url, "http://local");
    if (url.pathname === "/v1/AUTH_test") {
      const rows = url.searchParams.has("marker")
        ? [{ name: "last" }]
        : Array.from({ length: 1000 }, (_, i) => ({ name: `bucket-${i}` }));
      if (url.searchParams.has("marker"))
        assert.equal(url.searchParams.get("marker"), "bucket-999");
      res.end(JSON.stringify(rows));
    } else {
      assert.equal(url.searchParams.get("prefix"), "folder/");
      assert.equal(url.searchParams.get("delimiter"), "/");
      if (url.searchParams.has("marker")) {
        assert.equal(url.searchParams.get("marker"), "folder/sub/");
        res.end("[]");
      } else
        res.end(
          JSON.stringify([
            {
              name: "folder/a",
              bytes: 3,
              hash: "abc",
              last_modified: "2026-01-01T01:02:03.000000",
            },
            { subdir: "folder/sub/" },
          ]),
        );
    }
  });
  assert.equal(
    (await swift.send(new ListBucketsCommand({}))).Buckets.length,
    1001,
  );
  const input = {
    Bucket: "container",
    Prefix: "folder/",
    Delimiter: "/",
    MaxKeys: 2,
  };
  const page = await swift.send(new ListObjectsV2Command(input));
  assert.equal(
    page.Contents[0].LastModified.toISOString(),
    "2026-01-01T01:02:03.000Z",
  );
  assert.equal(page.Contents[0].ETag, '"abc"');
  assert.deepEqual(page.CommonPrefixes, [{ Prefix: "folder/sub/" }]);
  assert.equal(page.NextContinuationToken, "folder/sub/");
  assert.equal(
    (
      await swift.send(
        new ListObjectsV2Command({
          ...input,
          ContinuationToken: page.NextContinuationToken,
        }),
      )
    ).IsTruncated,
    false,
  );
});

test("Swift streams conditional uploads and downloads and preserves encoded object paths", async (t) => {
  const received = [];
  const { swift } = await fixture(t, async (req, res) => {
    assert.equal(
      req.url,
      "/v1/AUTH_test/container/folder/a..b/%252e/%C3%A9%20%3F%23",
    );
    if (req.method === "PUT") {
      assert.equal(req.headers["if-none-match"], "*");
      assert.equal(req.headers["x-object-meta-test"], "value");
      received.push(await body(req));
      res.writeHead(201, { etag: "checksum" });
      res.end();
    } else {
      assert.equal(req.headers["if-match"], '"checksum"');
      res.writeHead(200, {
        "content-length": 6,
        etag: "checksum",
        "x-object-meta-test": "value",
        "content-type": "text/plain",
      });
      res.end("abcdef");
    }
  });
  const input = { Bucket: "container", Key: "folder/a..b/%2e/é ?#" };
  const progress = [];
  const uploaded = await swift.upload(
    {
      ...input,
      Body: Readable.from([Buffer.from("abc"), Buffer.from("def")]),
      ContentLength: 6,
      IfNoneMatch: "*",
      Metadata: { test: "value" },
    },
    { onProgress: (loaded) => progress.push(loaded) },
  );
  assert.equal(uploaded.ETag, '"checksum"');
  assert.equal(progress.at(-1), 6);
  assert.equal(received[0].toString(), "abcdef");
  const downloaded = await swift.send(
    new GetObjectCommand({ ...input, IfMatch: '"checksum"' }),
  );
  assert.equal(downloaded.Metadata.test, "value");
  assert.equal((await body(downloaded.Body)).toString(), "abcdef");
});

test("Swift rejects exact dot segments before reads, writes, copy or discovery requests", async (t) => {
  const { swift, requests, infoRequests } = await fixture(t, (_, res) =>
    res.end(),
  );
  const unsafeKeys = [
    ".",
    "..",
    "./file",
    "../file",
    "folder/./file",
    "folder/../file",
    "folder/.",
    "folder/..",
    "folder//../file",
  ];
  for (const Key of unsafeKeys) {
    const input = { Bucket: "container", Key };
    for (const command of [
      new GetObjectCommand(input),
      new HeadObjectCommand(input),
      new PutObjectCommand({ ...input, Body: Buffer.from("data") }),
      new DeleteObjectCommand(input),
      new CopyObjectCommand({ ...input, CopySource: "source/safe" }),
      new CopyObjectCommand({
        ...input,
        CopySource: "source/safe",
        IfNoneMatch: "*",
      }),
    ])
      await assert.rejects(swift.send(command), /dot path segments/);
    await assert.rejects(swift.signedUrl(input, 600), /dot path segments/);
    let read = false;
    const source = new Readable({
      read() {
        read = true;
        this.push(null);
      },
    });
    await assert.rejects(
      swift.upload({ ...input, Body: source, ContentLength: 4 }),
      /dot path segments/,
    );
    assert.equal(read, false);
    assert.equal(source.destroyed, true);
  }
  for (const Bucket of [".", ".."]) {
    await assert.rejects(
      swift.send(new ListObjectsV2Command({ Bucket })),
      /dot path segments/,
    );
    await assert.rejects(
      swift.send(new GetObjectCommand({ Bucket, Key: "safe" })),
      /dot path segments/,
    );
    await assert.rejects(
      swift.upload({ Bucket, Key: "safe", Body: "data" }),
      /dot path segments/,
    );
  }
  assert.equal(requests.length, 0);
  assert.equal(infoRequests.length, 0, "no credentialed discovery request");
});

test("Swift validates decoded copy source dot segments before either copy strategy makes requests", async (t) => {
  const { swift, requests, infoRequests } = await fixture(t, (_, res) =>
    res.end(),
  );
  for (const CopySource of [
    "source/.",
    "source/..",
    "/source/./file",
    "source/../file",
    "source/%2e/file",
    "source/%2E%2e/file",
    "source/.%2E/file",
    "source/%2e./file",
    "source/folder%2F..%2Ffile",
    "../file",
    "%2e/file",
  ]) {
    for (const IfNoneMatch of [undefined, "*"])
      await assert.rejects(
        swift.send(
          new CopyObjectCommand({
            Bucket: "destination",
            Key: "safe",
            CopySource,
            IfNoneMatch,
          }),
        ),
        /dot path segments/,
      );
  }
  assert.equal(requests.length, 0);
  assert.equal(infoRequests.length, 0);
});

test("Swift copies dotted names and literal percent sequences without altering them", async (t) => {
  const Key = ".hidden/.../a..b/%2e/%2E%2e/100%/file.txt";
  const encoded = Key.split("/").map(encodeURIComponent).join("/");
  const { swift, requests } = await fixture(t, async (req, res) => {
    if (req.method === "GET") {
      assert.equal(req.url, `/v1/AUTH_test/source/${encoded}`);
      res.writeHead(200, { "content-length": 4 });
      res.end("data");
    } else {
      assert.equal(req.url, `/v1/AUTH_test/destination/${encoded}`);
      if (req.headers["x-copy-from"])
        assert.equal(req.headers["x-copy-from"], `/source/${encoded}`);
      else assert.equal((await body(req)).toString(), "data");
      res.writeHead(201);
      res.end();
    }
  });
  for (const IfNoneMatch of [undefined, "*"])
    await swift.send(
      new CopyObjectCommand({
        Bucket: "destination",
        Key,
        CopySource: `source/${encoded}`,
        IfNoneMatch,
      }),
    );
  const url = new URL(
    await swift.signedUrl({ Bucket: "destination", Key }, 600),
  );
  assert.equal(url.pathname, `/v1/AUTH_test/destination/${encoded}`);
  assert.equal(requests.length, 3);
});

test("Swift guarded copy streams source and keeps destination create-only condition and metadata", async (t) => {
  const { swift, requests } = await fixture(t, async (req, res) => {
    if (req.method === "GET") {
      assert.equal(req.url, "/v1/AUTH_test/source/a%20b");
      assert.equal(req.headers["if-match"], '"original"');
      res.writeHead(200, {
        "content-length": 4,
        "content-type": "text/plain",
        "x-object-meta-label": "keep",
      });
      res.end("data");
    } else {
      assert.equal(req.url, "/v1/AUTH_test/dest/new");
      assert.equal(req.headers["if-none-match"], "*");
      assert.equal(req.headers["x-object-meta-label"], "keep");
      assert.equal(req.headers["content-type"], "text/plain");
      assert.equal((await body(req)).toString(), "data");
      res.writeHead(201, { etag: "copied" });
      res.end();
    }
  });
  const result = await swift.send(
    new CopyObjectCommand({
      Bucket: "dest",
      Key: "new",
      CopySource: "source/a%20b",
      CopySourceIfMatch: '"original"',
      IfNoneMatch: "*",
    }),
  );
  assert.equal(result.CopyObjectResult.ETag, '"copied"');
  assert.equal(requests.length, 2);
});

test("Swift fails unsupported guards before any network request", async (t) => {
  const { swift, requests } = await fixture(t, (_, res) => {
    res.end();
  });
  for (const command of [
    new PutObjectCommand({ Bucket: "b", Key: "k", IfMatch: '"old"' }),
    new PutObjectCommand({ Bucket: "b", Key: "k", IfNoneMatch: '"old"' }),
    new DeleteObjectCommand({ Bucket: "b", Key: "k", IfMatch: '"old"' }),
    new CopyObjectCommand({
      Bucket: "b",
      Key: "k",
      CopySource: "s/k",
      IfMatch: '"old"',
    }),
    new GetObjectCommand({ Bucket: "b", Key: "k", VersionId: "old" }),
  ])
    await assert.rejects(swift.send(command), { name: "UnsupportedOperation" });
  assert.equal(requests.length, 0);
  assert.equal(swift.capabilities.conditionalDelete, false);
  assert.equal(swift.capabilities.createOnlyWrite, true);
});

test("Swift maps provider failures and explains expired tokens", async (t) => {
  const { swift } = await fixture(t, (req, res) => {
    res.writeHead(Number(req.url.split("/").at(-1)));
    res.end();
  });
  for (const [status, name] of [
    [404, "NotFound"],
    [412, "PreconditionFailed"],
    [401, "Unauthorized"],
  ]) {
    await assert.rejects(
      swift.send(new HeadObjectCommand({ Bucket: "b", Key: String(status) })),
      (e) => {
        assert.equal(e.name, name);
        assert.equal(e.$metadata.httpStatusCode, status);
        if (status === 401) assert.match(e.message, /expired/);
        return true;
      },
    );
  }
});

test("Swift cancellation terminates an in-flight download", async (t) => {
  const { swift } = await fixture(t, (_, res) => {
    res.writeHead(200, { "content-length": 100000 });
    res.write("first");
  });
  const controller = new AbortController();
  const result = await swift.send(
    new GetObjectCommand({ Bucket: "b", Key: "k" }),
    { abortSignal: controller.signal },
  );
  const reading = body(result.Body);
  controller.abort();
  await assert.rejects(reading);
});

test("Swift TempURL signs the decoded path and never discloses authentication secrets", async (t) => {
  const { swift, profile } = await fixture(t, (_, res) => res.end());
  const result = new URL(
    await swift.signedUrl({ Bucket: "container", Key: "é space/file" }, 600),
  );
  const expires = result.searchParams.get("temp_url_expires");
  const expected = createHmac("sha256", profile.swiftTempUrlKey)
    .update(`GET\n${expires}\n/v1/AUTH_test/container/é space/file`)
    .digest("hex");
  assert.equal(result.searchParams.get("temp_url_sig"), expected);
  assert.ok(!result.href.includes(profile.swiftToken));
  assert.ok(!result.href.includes(profile.swiftTempUrlKey));
});

test("Swift guarded copy refuses changed sources and occupied destinations", async (t) => {
  let phase = "source";
  const { swift, requests } = await fixture(t, async (req, res) => {
    if (phase === "source" || req.method === "PUT") {
      req.resume();
      res.writeHead(412);
      res.end();
    } else {
      res.writeHead(200, { "content-length": 4 });
      res.end("data");
    }
  });
  const command = new CopyObjectCommand({
    Bucket: "dest",
    Key: "new",
    CopySource: "source/k",
    CopySourceIfMatch: '"old"',
    IfNoneMatch: "*",
  });
  await assert.rejects(swift.send(command), { name: "PreconditionFailed" });
  assert.equal(requests.length, 1);
  phase = "destination";
  await assert.rejects(swift.send(command), { name: "PreconditionFailed" });
  assert.equal(requests.length, 3);
});

test("Swift cancellation destroys a stalled upload's input stream", async (t) => {
  let resolveStarted;
  const started = new Promise((resolve) => {
    resolveStarted = resolve;
  });
  const { swift } = await fixture(t, (req) => {
    req.on("data", resolveStarted);
  });
  const source = new Readable({ read() {} });
  source.push(Buffer.from("first"));
  const controller = new AbortController();
  const uploading = swift.upload(
    { Bucket: "b", Key: "k", Body: source },
    { abortSignal: controller.signal },
  );
  await started;
  controller.abort();
  await assert.rejects(uploading, { name: "AbortError" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(source.destroyed, true);
});

// Exercise shared queue/sync/operation contracts through an actual HTTP Swift
// client, including real stream bodies and conditional header enforcement.
async function objectStore(t) {
  const { createHash } = require("node:crypto");
  const objects = new Map();
  const modified = "Tue, 06 Oct 2026 12:00:00 GMT";
  const setup = await fixture(t, async (req, res) => {
    const url = new URL(req.url, "http://local");
    const relative = decodeURIComponent(url.pathname).slice(
      "/v1/AUTH_test/".length,
    );
    const slash = relative.indexOf("/");
    if (req.method === "GET" && slash === -1) {
      const prefix = url.searchParams.get("prefix") || "";
      const marker = url.searchParams.get("marker") || "";
      res.end(
        JSON.stringify(
          [...objects]
            .filter(([name]) => name.startsWith(`${relative}/${prefix}`))
            .map(([name, o]) => ({
              name: name.slice(relative.length + 1),
              bytes: o.data.length,
              hash: o.etag,
              last_modified: "2026-10-06T12:00:00.000000",
            }))
            .filter((o) => o.name > marker),
        ),
      );
      return;
    }
    const object = objects.get(relative);
    if (req.method === "PUT") {
      if (req.headers["if-none-match"] === "*" && object) {
        req.resume();
        res.writeHead(412);
        res.end();
        return;
      }
      const data = await body(req);
      const etag = createHash("md5").update(data).digest("hex");
      const headers = Object.fromEntries(
        Object.entries(req.headers).filter(
          ([name]) =>
            name.startsWith("x-object-meta-") ||
            ["content-type", "cache-control"].includes(name),
        ),
      );
      objects.set(relative, { data, etag, headers });
      res.writeHead(201, { etag, "last-modified": modified });
      res.end();
      return;
    }
    if (!object) {
      res.writeHead(404);
      res.end();
      return;
    }
    if (
      req.headers["if-match"] &&
      req.headers["if-match"] !== `"${object.etag}"`
    ) {
      res.writeHead(412);
      res.end();
      return;
    }
    res.writeHead(200, {
      ...object.headers,
      "content-length": object.data.length,
      "last-modified": modified,
      etag: object.etag,
    });
    res.end(req.method === "HEAD" ? undefined : object.data);
  });
  return { ...setup, objects };
}

async function tempDirectory(t) {
  const fs = require("node:fs/promises"),
    path = require("node:path");
  const root = await fs.mkdtemp(
    path.join(require("node:os").tmpdir(), "swift-contract-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("Swift shared upload, recovery, reviewed copy and queued download contracts", async (t) => {
  const fs = require("node:fs/promises"),
    path = require("node:path"),
    { createHash } = require("node:crypto");
  const storage = require("../src/storage.cjs"),
    operations = require("../src/operations.cjs"),
    downloads = require("../src/downloads.cjs");
  const { swift, objects, requests } = await objectStore(t);
  const root = await tempDirectory(t);
  const source = path.join(root, "source.txt");
  const data = "shared transfer contract ✓";
  await fs.writeFile(source, data);
  const entry = {
    source,
    key: "source.txt",
    size: Buffer.byteLength(data),
    expectedAbsent: true,
    uploadToken: "durable-test",
    sha256: createHash("sha256").update(data).digest("base64"),
    attempts: 1,
  };
  const signal = new AbortController().signal;
  const progress = [];
  await storage.transfer(
    swift,
    { bucket: "container" },
    entry,
    signal,
    (bytes) => progress.push(bytes),
  );
  assert.equal(progress.at(-1), entry.size);
  assert.equal(objects.get("container/source.txt").data.toString(), data);
  const putCount = requests.filter((r) => r.method === "PUT").length;
  await storage.transfer(
    swift,
    { bucket: "container" },
    { ...entry, attempts: 2 },
    signal,
    () => {},
  );
  assert.equal(
    requests.filter((r) => r.method === "PUT").length,
    putCount,
    "recovery verifies bytes and metadata without a repeated upload",
  );
  assert.equal(
    await storage.transfer(
      swift,
      { bucket: "container" },
      { ...entry, expectedAbsent: false, uploadToken: undefined },
      signal,
      () => {},
    ),
    "skipped",
  );
  const preview = await operations.preview(swift, {
    bucket: "container",
    selection: [{ key: "source.txt" }],
    destinationPrefix: "copy/",
    action: "copy",
  });
  const copied = await operations.execute(swift, preview);
  assert.equal(copied.failed, 0, JSON.stringify(copied.failures));
  assert.equal(copied.succeeded, 1);
  assert.equal(objects.get("container/copy/source.txt").data.toString(), data);
  const destination = path.join(root, "downloads");
  await fs.mkdir(destination);
  const planned = await downloads.plan(swift, {
    bucket: "container",
    prefix: "copy/",
    selection: [{ key: "copy/source.txt" }],
    destination,
  });
  assert.equal(planned.length, 1);
  await downloads.transfer(swift, { bucket: "container" }, planned[0], signal);
  assert.equal(
    await fs.readFile(path.join(destination, "source.txt"), "utf8"),
    data,
  );
  await assert.rejects(
    operations.preview(swift, {
      bucket: "container",
      selection: [{ key: "source.txt" }],
      action: "delete",
    }),
    /not supported/i,
  );
});

test("Swift shared sync permits new files and blocks reviewed replacement before mutations", async (t) => {
  const fs = require("node:fs/promises"),
    path = require("node:path");
  const sync = require("../src/sync.cjs"),
    storage = require("../src/storage.cjs");
  const { swift, requests } = await objectStore(t);
  const source = await tempDirectory(t);
  await fs.writeFile(path.join(source, "new.txt"), "first");
  const options = {
    profile: "swift-test",
    bucket: "container",
    prefix: "sync/",
    source,
  };
  const plan = await sync.compare(swift, options);
  assert.equal(plan.counts.new, 1);
  const signal = new AbortController().signal;
  assert.equal(await sync.validate(plan, swift, signal), true);
  await storage.transfer(
    swift,
    { bucket: "container" },
    plan.entries[0],
    signal,
    () => {},
  );
  assert.equal((await sync.compare(swift, options)).counts.unchanged, 1);
  await fs.writeFile(path.join(source, "new.txt"), "changed content");
  const changed = await sync.compare(swift, options);
  assert.equal(changed.counts.changed, 1);
  const before = requests.length;
  await assert.rejects(sync.validate(changed, swift, signal), /not supported/i);
  assert.equal(
    requests.length,
    before,
    "replacement is rejected before any validation or mutation request",
  );
});

test("Swift rejects changed source hashes before the HTTP upload can commit", async (t) => {
  const fs = require("node:fs/promises"),
    path = require("node:path");
  const storage = require("../src/storage.cjs");
  let committed = false;
  let received = 0;
  let resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  const { swift, requests } = await fixture(t, (req, res) => {
    assert.equal(req.method, "PUT");
    assert.equal(req.headers["content-length"], undefined);
    assert.equal(req.headers["transfer-encoding"], "chunked");
    req.on("data", (chunk) => {
      received += chunk.length;
    });
    req.on("end", () => {
      committed = true;
      res.writeHead(201);
      res.end();
    });
    req.on("close", resolveClosed);
  });
  const root = await tempDirectory(t);
  const source = path.join(root, "changed.bin");
  const data = Buffer.alloc(3 * 1024 * 1024, 42);
  await fs.writeFile(source, data);
  await assert.rejects(
    storage.transfer(
      swift,
      {
        bucket: "container",
        overwrite: true,
        // Yield between chunks so the server receives the upload before the
        // final checksum fails; this catches commit races, not preflight errors.
        throttle: () => new Promise((resolve) => setImmediate(resolve)),
      },
      {
        source,
        key: "changed.bin",
        size: data.length,
        sha256: "wrong-checksum",
      },
      new AbortController().signal,
      () => {},
    ),
    /Source content changed/,
  );
  await closed;
  assert.equal(requests.length, 1);
  assert.ok(
    received > 0,
    "server must receive bytes before hash validation fails",
  );
  assert.equal(
    committed,
    false,
    "no successful request EOF may publish the changed object",
  );
});

test("Swift discovers and caches prefixed single-upload limits before reading a body", async (t) => {
  const { swift, requests, infoRequests } = await fixture(
    t,
    async (req, res) => {
      assert.equal(req.method, "PUT");
      assert.equal((await body(req)).toString(), "tiny");
      res.writeHead(201);
      res.end();
    },
    {
      prefix: "/storage/proxy",
      info(req, res) {
        assert.equal(req.method, "GET");
        res.end(JSON.stringify({ swift: { max_file_size: 4 } }));
      },
    },
  );
  let read = false;
  const source = new Readable({
    read() {
      read = true;
      this.push(null);
    },
  });
  await assert.rejects(
    swift.upload({ Bucket: "b", Key: "large", Body: source, ContentLength: 5 }),
    (error) => {
      assert.equal(error.name, "EntityTooLarge");
      assert.equal(error.$metadata.httpStatusCode, 413);
      assert.match(error.message, /4 bytes/);
      return true;
    },
  );
  assert.equal(read, false);
  assert.equal(source.destroyed, true);
  assert.equal(requests.length, 0);
  await swift.upload({ Bucket: "b", Key: "tiny", Body: Buffer.from("tiny") });
  assert.equal(infoRequests.length, 1);
  assert.equal(requests.length, 1);
});

test("Swift falls back to a cached 5 GiB limit for unavailable or invalid discovery", async (t) => {
  for (const kind of [
    "unavailable",
    "invalid-json",
    "invalid-limit",
    "redirect",
  ]) {
    await t.test(kind, async (t) => {
      const { swift, requests, infoRequests } = await fixture(
        t,
        (_, res) => res.end(),
        {
          info(_, res) {
            if (kind === "unavailable") res.writeHead(404);
            if (kind === "redirect")
              res.writeHead(302, { location: "/secret-token-recipient" });
            res.end(
              kind === "invalid-json"
                ? "not json"
                : JSON.stringify({ swift: { max_file_size: -1 } }),
            );
          },
        },
      );
      for (let attempt = 0; attempt < 2; attempt++) {
        let read = false;
        const source = new Readable({
          read() {
            read = true;
            this.push(null);
          },
        });
        await assert.rejects(
          swift.upload({
            Bucket: "b",
            Key: "large",
            Body: source,
            ContentLength: 5 * 1024 ** 3 + 1,
          }),
          { name: "EntityTooLarge" },
        );
        assert.equal(read, false);
      }
      assert.equal(infoRequests.length, 1);
      assert.equal(requests.length, 0, "no PUT or redirect request is made");
    });
  }
});

test("Swift guarded copy closes an oversized source at its headers without a PUT", async (t) => {
  let resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  const { swift, requests } = await fixture(
    t,
    (req, res) => {
      assert.equal(req.method, "GET");
      assert.equal(req.url, "/v1/AUTH_test/source/large");
      res.on("close", resolveClosed);
      res.writeHead(200, { "content-length": 5 });
      res.flushHeaders();
      // Send no data: rejection must depend on the size header alone.
    },
    {
      info(_, res) {
        res.end(JSON.stringify({ swift: { max_file_size: 4 } }));
      },
    },
  );
  await assert.rejects(
    swift.send(
      new CopyObjectCommand({
        Bucket: "dest",
        Key: "large",
        CopySource: "source/large",
        IfNoneMatch: "*",
      }),
    ),
    { name: "EntityTooLarge" },
  );
  await closed;
  assert.equal(requests.length, 1);
});

test("Swift propagates discovery cancellation and retries without caching a fallback", async (t) => {
  let resolveStarted;
  const started = new Promise((resolve) => {
    resolveStarted = resolve;
  });
  let attempts = 0;
  const { swift, requests, infoRequests } = await fixture(
    t,
    (_, res) => res.end(),
    {
      info(_, res) {
        if (++attempts === 1) {
          res.writeHead(200);
          res.write('{"swift":');
          resolveStarted();
        } else res.end(JSON.stringify({ swift: { max_file_size: 4 } }));
      },
    },
  );
  const controller = new AbortController();
  let read = false;
  const source = new Readable({
    read() {
      read = true;
      this.push(null);
    },
  });
  const uploading = swift.upload(
    { Bucket: "b", Key: "k", Body: source, ContentLength: 5 },
    { abortSignal: controller.signal },
  );
  await started;
  controller.abort();
  await assert.rejects(uploading, { name: "AbortError" });
  assert.equal(read, false);
  assert.equal(source.destroyed, true);
  await assert.rejects(
    swift.upload({ Bucket: "b", Key: "k", Body: Buffer.from("12345") }),
    { name: "EntityTooLarge" },
  );
  assert.equal(infoRequests.length, 2);
  assert.equal(requests.length, 0);
});

test("Swift shared upload cancellation during discovery observes the source error", async (t) => {
  const fs = require("node:fs/promises"),
    path = require("node:path");
  const storage = require("../src/storage.cjs");
  let resolveStarted;
  const started = new Promise((resolve) => {
    resolveStarted = resolve;
  });
  const { swift, requests } = await fixture(t, (_, res) => res.end(), {
    info(_, res) {
      res.writeHead(200);
      res.write('{"swift":');
      resolveStarted();
    },
  });
  const root = await tempDirectory(t);
  const source = path.join(root, "source.bin");
  await fs.writeFile(source, Buffer.alloc(128 * 1024));
  const controller = new AbortController();
  const uploading = storage.transfer(
    swift,
    { bucket: "b", overwrite: true },
    { source, key: "k", size: 128 * 1024 },
    controller.signal,
    () => {},
  );
  await started;
  controller.abort();
  await assert.rejects(uploading, { name: "AbortError" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 0);
});

test("Swift preserves source errors raised during capability discovery", async (t) => {
  let resolveStarted, discoveryResponse;
  const started = new Promise((resolve) => {
    resolveStarted = resolve;
  });
  const { swift, requests } = await fixture(t, (_, res) => res.end(), {
    info(_, res) {
      discoveryResponse = res;
      resolveStarted();
    },
  });
  const source = new Readable({ read() {} });
  const uploading = swift.upload({
    Bucket: "b",
    Key: "k",
    Body: source,
    ContentLength: 4,
  });
  await started;
  source.destroy(new Error("source validation failed"));
  await new Promise((resolve) => setImmediate(resolve));
  discoveryResponse.end(JSON.stringify({ swift: { max_file_size: 100 } }));
  await assert.rejects(uploading, /source validation failed/);
  assert.equal(requests.length, 0);
});

test("Swift shared checksum failure during discovery rejects before a PUT", async (t) => {
  const fs = require("node:fs/promises"),
    path = require("node:path");
  const storage = require("../src/storage.cjs");
  let resolveStarted, discoveryResponse, resolveSourceClosed;
  const started = new Promise((resolve) => {
    resolveStarted = resolve;
  });
  const sourceClosed = new Promise((resolve) => {
    resolveSourceClosed = resolve;
  });
  const { swift, requests } = await fixture(t, (_, res) => res.end(), {
    info(_, res) {
      discoveryResponse = res;
      resolveStarted();
    },
  });
  const upload = swift.upload;
  swift.upload = (input, options) => {
    input.Body.once("close", resolveSourceClosed);
    return upload(input, options);
  };
  const root = await tempDirectory(t);
  const source = path.join(root, "source.txt");
  await fs.writeFile(source, "changed");
  const uploading = storage.transfer(
    swift,
    { bucket: "b", overwrite: true },
    { source, key: "k", size: 7, sha256: "wrong-checksum" },
    new AbortController().signal,
    () => {},
  );
  await started;
  await sourceClosed;
  discoveryResponse.end(JSON.stringify({ swift: { max_file_size: 100 } }));
  await assert.rejects(uploading, /Source content changed/);
  assert.equal(requests.length, 0);
});
