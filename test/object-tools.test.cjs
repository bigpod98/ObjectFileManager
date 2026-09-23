const { test } = require("node:test");
const assert = require("node:assert/strict");
const { S3Client } = require("@aws-sdk/client-s3");
const tools = require("../src/object-tools.cjs");

function client(replies) {
  const calls = [];
  return {
    calls,
    async send(command) {
      calls.push(command);
      assert.ok(replies.length, `Unexpected ${command.constructor.name}`);
      const reply = replies.shift();
      if (reply instanceof Error) throw reply;
      return typeof reply === "function" ? reply(command) : reply;
    },
  };
}

test("recursive search scans a bounded batch and resumes without a delimiter", async () => {
  const s3 = client(
    Array.from({ length: 6 }, (_, i) => ({
      Contents: [
        { Key: `base/deep/${i}-Needle.txt`, Size: i },
        { Key: `base/deep/${i}-other`, Size: 3 },
      ],
      IsTruncated: i < 5,
      NextContinuationToken: i < 5 ? String(i + 1) : undefined,
    })),
  );
  const first = await tools.search(s3, {
    bucket: "bucket",
    prefix: "base/",
    query: "needle",
  });
  assert.equal(first.scanned, 10);
  assert.equal(first.objects.length, 5);
  assert.equal(first.token, "5");
  assert.ok(
    s3.calls.every((c) => !c.input.Delimiter && c.input.MaxKeys === 500),
  );
  const second = await tools.search(s3, {
    bucket: "bucket",
    prefix: "base/",
    query: "needle",
    token: first.token,
  });
  assert.equal(second.objects[0].key, "base/deep/5-Needle.txt");
  assert.equal(second.token, null);
  assert.equal(s3.calls[5].input.ContinuationToken, "5");
});

test("search refuses a repeating provider token", async () => {
  const s3 = client([{ IsTruncated: true, NextContinuationToken: "same" }]);
  await assert.rejects(
    tools.search(s3, { bucket: "b", token: "same" }),
    /invalid search continuation/,
  );
});

test("details expose metadata, headers, size and version without SDK response internals", async () => {
  const s3 = client([
    {
      ContentLength: 12,
      ETag: '"etag"',
      VersionId: "v1",
      LastModified: new Date("2026-01-01"),
      ContentType: "text/plain",
      Metadata: { owner: "me" },
      ServerSideEncryption: "AES256",
      $metadata: { requestId: "private" },
    },
  ]);
  const result = await tools.details(s3, { bucket: "b", key: "x" });
  assert.equal(result.size, 12);
  assert.equal(result.modified, "2026-01-01T00:00:00.000Z");
  assert.equal(result.versionId, "v1");
  assert.equal(result.encryption, "AES256");
  assert.deepEqual(result.metadata, { owner: "me" });
  assert.equal(result.$metadata, undefined);
});

test("version pages include delete markers, filter exact keys and retain paired markers", async () => {
  const s3 = client([
    {
      Versions: [
        {
          Key: "a",
          VersionId: "v1",
          Size: 5,
          LastModified: new Date("2026-01-01"),
        },
        { Key: "ab", VersionId: "wrong" },
      ],
      DeleteMarkers: [
        {
          Key: "a",
          VersionId: "v2",
          IsLatest: true,
          LastModified: new Date("2026-02-01"),
        },
      ],
      IsTruncated: true,
      NextKeyMarker: "a",
      NextVersionIdMarker: "v1",
    },
    {
      Versions: [{ Key: "ab", VersionId: "unrelated" }],
      IsTruncated: true,
      NextKeyMarker: "ab",
      NextVersionIdMarker: "unrelated",
    },
  ]);
  const first = await tools.versions(s3, { bucket: "b", key: "a" });
  assert.equal(first.versions.length, 2);
  assert.equal(first.versions[0].deleteMarker, true);
  assert.equal(first.keyMarker, "a");
  assert.equal(first.versionIdMarker, "v1");
  const last = await tools.versions(s3, {
    bucket: "b",
    key: "a",
    keyMarker: first.keyMarker,
    versionIdMarker: first.versionIdMarker,
  });
  assert.deepEqual(last.versions, []);
  assert.equal(last.keyMarker, null);
  assert.equal(s3.calls[1].input.VersionIdMarker, "v1");
});

test("metadata editing preserves attributes and tags while replacing only requested fields", async () => {
  const head = {
    ContentLength: 3,
    ETag: '"source"',
    VersionId: "version /1",
    Metadata: { old: "value" },
    ContentType: "text/plain",
    ContentEncoding: "gzip",
    CacheControl: "private",
    ContentDisposition: "attachment",
    ContentLanguage: "en",
    Expires: new Date("2030-01-01"),
    WebsiteRedirectLocation: "/target",
    StorageClass: "STANDARD_IA",
    ServerSideEncryption: "aws:kms",
    SSEKMSKeyId: "kms",
    BucketKeyEnabled: true,
  };
  const s3 = client([
    head,
    { CopyObjectResult: { ETag: '"new"' }, VersionId: "new-version" },
  ]);
  const result = await tools.metadata(s3, {
    bucket: "b",
    key: "some key/世界",
    metadata: { Owner: "new" },
    contentType: "application/json",
  });
  const copy = s3.calls[1].input;
  for (const attribute of [
    "ContentEncoding",
    "CacheControl",
    "ContentDisposition",
    "ContentLanguage",
    "Expires",
    "WebsiteRedirectLocation",
    "StorageClass",
    "ServerSideEncryption",
    "SSEKMSKeyId",
    "BucketKeyEnabled",
  ])
    assert.equal(copy[attribute], head[attribute], attribute);
  assert.deepEqual({ ...copy.Metadata }, { owner: "new" });
  assert.equal(copy.ContentType, "application/json");
  assert.equal(
    copy.CopySource,
    "b/some%20key/%E4%B8%96%E7%95%8C?versionId=version%20%2F1",
  );
  assert.equal(copy.CopySourceIfMatch, '"source"');
  assert.equal(copy.IfMatch, '"source"');
  assert.equal(copy.MetadataDirective, "REPLACE");
  assert.equal(copy.TaggingDirective, "COPY");
  assert.equal(result.versionId, "new-version");
});

test("metadata editing uses bounded multipart copy for large objects", async () => {
  const size = 5 * 1024 ** 3 + 1;
  const head = {
    ContentLength: size,
    ETag: '"source"',
    ContentType: "text/plain",
    ContentLanguage: "en",
    Metadata: { old: "value" },
  };
  const replies = [
    head,
    { TagSet: [{ Key: "project", Value: "my project" }] },
    { UploadId: "upload" },
    ...Array.from({ length: 11 }, () => ({
      CopyPartResult: { ETag: '"part"' },
    })),
    { ETag: '"finished"' },
  ];
  const s3 = client(replies);
  await tools.metadata(s3, {
    bucket: "b",
    key: "large",
    metadata: { owner: "new" },
  });
  const create = s3.calls.find(
    (c) => c.constructor.name === "CreateMultipartUploadCommand",
  ).input;
  assert.equal(create.Tagging, "project=my%20project");
  assert.equal(create.ContentLanguage, "en");
  assert.deepEqual({ ...create.Metadata }, { owner: "new" });
  const parts = s3.calls.filter(
    (c) => c.constructor.name === "UploadPartCopyCommand",
  );
  assert.equal(parts.length, 11);
  assert.equal(
    parts.at(-1).input.CopySourceRange,
    `bytes=${size - 1}-${size - 1}`,
  );
  assert.ok(parts.every((c) => c.input.CopySourceIfMatch === '"source"'));
  assert.equal(s3.calls.at(-1).input.IfMatch, '"source"');
});

test("version restore reads selected version and conditionally creates a new current copy", async () => {
  const s3 = client([
    {
      ContentLength: 4,
      ETag: '"old"',
      VersionId: "old",
      ContentType: "text/plain",
    },
    { ContentLength: 9, ETag: '"current"' },
    { CopyObjectResult: { ETag: '"restored"' }, VersionId: "new" },
  ]);
  await tools.restore(s3, { bucket: "b", key: "a", versionId: "old" });
  assert.equal(s3.calls[0].input.VersionId, "old");
  assert.equal(s3.calls[2].input.CopySource, "b/a?versionId=old");
  assert.equal(s3.calls[2].input.CopySourceIfMatch, '"old"');
  assert.equal(s3.calls[2].input.IfMatch, '"current"');
  assert.ok(
    s3.calls.every((c) => c.constructor.name !== "DeleteObjectCommand"),
  );
});

test("version restore handles a currently deleted object with create-only guard", async () => {
  const missing = Object.assign(new Error("missing"), { name: "NotFound" });
  const s3 = client([
    { ContentLength: 4, ETag: '"old"' },
    missing,
    { CopyObjectResult: { ETag: '"restored"' } },
  ]);
  await tools.restore(s3, { bucket: "b", key: "a", versionId: "old" });
  assert.equal(s3.calls[2].input.IfNoneMatch, "*");
});

test("signed links contain requested expiry, sign GET, and validate lifetime", async () => {
  const s3 = new S3Client({
    endpoint: "https://storage.example.test",
    region: "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId: "test-access", secretAccessKey: "test-secret" },
  });
  try {
    const url = new URL(
      await tools.signedUrl(s3, {
        bucket: "b",
        key: "folder/a b",
        expiresIn: 600,
      }),
    );
    assert.equal(url.pathname, "/b/folder/a%20b");
    assert.equal(url.searchParams.get("X-Amz-Expires"), "600");
    assert.ok(url.searchParams.get("X-Amz-Signature"));
    for (const expiresIn of [0, 604801, 1.5, "100"])
      await assert.rejects(
        tools.signedUrl(s3, { bucket: "b", key: "a", expiresIn }),
        /Link lifetime/,
      );
  } finally {
    s3.destroy();
  }
});

test("multipart listing paginates paired markers and abort targets only selected upload", async () => {
  const s3 = client([
    {
      Uploads: [{ Key: "a", UploadId: "1", Initiated: new Date("2026-01-01") }],
      IsTruncated: true,
      NextKeyMarker: "a",
      NextUploadIdMarker: "1",
    },
    { Uploads: [{ Key: "a", UploadId: "2" }] },
    {},
  ]);
  const first = await tools.multipart(s3, { bucket: "b", prefix: "a" });
  assert.equal(first.uploads[0].initiated, "2026-01-01T00:00:00.000Z");
  const next = await tools.multipart(s3, {
    bucket: "b",
    keyMarker: first.keyMarker,
    uploadIdMarker: first.uploadIdMarker,
  });
  assert.equal(s3.calls[1].input.UploadIdMarker, "1");
  assert.equal(next.keyMarker, null);
  await tools.abortMultipart(s3, { bucket: "b", key: "a", uploadId: "2" });
  assert.deepEqual(s3.calls[2].input, { Bucket: "b", Key: "a", UploadId: "2" });
});

test("unsupported provider features and concurrent edits have actionable errors", async () => {
  const unsupported = Object.assign(new Error("unknown"), {
    name: "NotImplemented",
  });
  await assert.rejects(
    tools.versions(client([unsupported]), { bucket: "b", key: "a" }),
    /version history is not supported by this storage provider/,
  );
  const stale = Object.assign(new Error("stale"), {
    name: "PreconditionFailed",
  });
  await assert.rejects(
    tools.metadata(client([{ ContentLength: 1, ETag: '"a"' }, stale]), {
      bucket: "b",
      key: "a",
      metadata: {},
    }),
    /object changed/,
  );
  await assert.rejects(
    tools.metadata(client([]), {
      bucket: "b",
      key: "a",
      metadata: { Owner: "a", owner: "b" },
    }),
    /unique regardless of case/,
  );
});

test("multipart prefix filtering tolerates providers that omit nested prefix results", async () => {
  const s3 = client([
    {
      Uploads: [{ Key: "other/file", UploadId: "other" }],
      IsTruncated: true,
      NextKeyMarker: "other/file",
      NextUploadIdMarker: "other",
    },
    {
      Uploads: [
        { Key: "unfinished/upload.bin", UploadId: "wanted" },
        { Key: "unrelated", UploadId: "excluded" },
      ],
    },
  ]);
  const first = await tools.multipart(s3, {
    bucket: "b",
    prefix: "unfinished/",
  });
  assert.deepEqual(first.uploads, []);
  assert.equal(first.keyMarker, "other/file");
  const next = await tools.multipart(s3, {
    bucket: "b",
    prefix: "unfinished/",
    keyMarker: first.keyMarker,
    uploadIdMarker: first.uploadIdMarker,
  });
  assert.deepEqual(
    next.uploads.map((u) => u.uploadId),
    ["wanted"],
  );
  assert.ok(s3.calls.every((c) => c.input.Prefix === undefined));
});
