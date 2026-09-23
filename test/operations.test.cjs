const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  preview,
  execute,
  createFolder,
  copyObject,
} = require("../src/operations.cjs");

const missing = () =>
  Object.assign(new Error("not found"), {
    name: "NotFound",
    $metadata: { httpStatusCode: 404 },
  });
const object = (extra = {}) => ({
  ETag: '"original"',
  ContentLength: 4,
  LastModified: new Date("2025-01-01"),
  ...extra,
});
function fixture(initial = { "source/a": object() }) {
  const objects = new Map(Object.entries(initial)),
    calls = [];
  let intercept;
  const s3 = {
    async send(command) {
      const type = command.constructor.name,
        input = command.input;
      calls.push({ type, input });
      if (intercept) {
        const override = await intercept(type, input);
        if (override !== undefined) return override;
      }
      const id = `${input.Bucket}/${input.Key}`;
      if (type === "HeadObjectCommand") {
        if (!objects.has(id)) throw missing();
        return { ...objects.get(id) };
      }
      if (type === "ListObjectsV2Command")
        return {
          Contents: [...objects.keys()]
            .filter((key) => key.startsWith(`${input.Bucket}/${input.Prefix}`))
            .map((key) => ({ Key: key.slice(input.Bucket.length + 1) })),
        };
      if (type === "CopyObjectCommand") {
        assert.equal(input.IfNoneMatch, "*");
        if (objects.has(id)) throw new Error("PreconditionFailed");
        const source = objects.get(
          decodeURIComponent(input.CopySource).split("?")[0],
        );
        if (source?.ETag !== input.CopySourceIfMatch)
          throw new Error("PreconditionFailed");
        objects.set(id, { ...source });
        return { CopyObjectResult: { ETag: source.ETag } };
      }
      if (type === "DeleteObjectCommand") {
        if (objects.get(id)?.ETag !== input.IfMatch)
          throw new Error("PreconditionFailed");
        objects.delete(id);
        return {};
      }
      if (type === "PutObjectCommand") {
        assert.equal(input.IfNoneMatch, "*");
        if (objects.has(id)) throw new Error("PreconditionFailed");
        objects.set(id, object({ ContentLength: 0 }));
        return {};
      }
      throw new Error(`Unhandled ${type}`);
    },
  };
  return {
    s3,
    objects,
    calls,
    intercept(fn) {
      intercept = fn;
    },
  };
}
const options = (action, extra = {}) => ({
  bucket: "source",
  selection: [{ key: "a", folder: false }],
  action,
  destinationBucket: "target",
  ...extra,
});

test("folder preview expands every page, snapshots objects and deduplicates overlapping selections", async () => {
  const f = fixture({
    "source/root/folder/a": object(),
    "source/root/folder/b": object({ ContentLength: 9 }),
  });
  f.intercept((type, input) => {
    if (type === "ListObjectsV2Command")
      return input.ContinuationToken
        ? { Contents: [{ Key: "root/folder/b" }] }
        : {
            Contents: [{ Key: "root/folder/a" }],
            IsTruncated: true,
            NextContinuationToken: "page2",
          };
  });
  const plan = await preview(
    f.s3,
    options("copy", {
      sourcePrefix: "root",
      destinationPrefix: "backup",
      selection: [
        { key: "root/folder/", folder: true },
        { key: "root/folder/a" },
      ],
    }),
  );
  assert.equal(plan.count, 2);
  assert.equal(plan.bytes, 13);
  assert.deepEqual(
    plan.items.map((item) => item.destinationKey),
    ["backup/folder/a", "backup/folder/b"],
  );
  assert.equal(plan.items[0].etag, '"original"');
  assert.equal(
    f.calls.filter((call) => call.type === "ListObjectsV2Command").length,
    2,
  );
});

test("move verifies its destination before guarded source deletion", async () => {
  const f = fixture();
  const plan = await preview(f.s3, options("move"));
  const result = await execute(f.s3, JSON.parse(JSON.stringify(plan)));
  assert.equal(result.succeeded, 1);
  assert.equal(result.copied, 1);
  assert.equal(result.deleted, 1);
  assert.equal(f.objects.has("source/a"), false);
  assert.equal(f.objects.has("target/a"), true);
  const removeIndex = f.calls.findIndex(
    (call) => call.type === "DeleteObjectCommand",
  );
  assert.equal(f.calls[removeIndex - 2].input.Bucket, "target");
  assert.equal(f.calls[removeIndex].input.IfMatch, '"original"');
});

test("changed source fails a reviewed deletion and new folder objects are retained", async () => {
  const f = fixture({ "source/f/a": object(), "source/f/b": object() });
  const plan = await preview(
    f.s3,
    options("delete", { selection: [{ key: "f/", folder: true }] }),
  );
  f.objects.set("source/f/a", object({ ETag: '"changed"' }));
  f.objects.set("source/f/new", object());
  const result = await execute(f.s3, plan);
  assert.equal(result.failed, 1);
  assert.equal(result.deleted, 1);
  assert.match(result.failures[0].error, /changed since preview/);
  assert.equal(f.objects.has("source/f/a"), true);
  assert.equal(f.objects.has("source/f/new"), true);
});

test("move retains source when verification fails or source changes during copy", async () => {
  for (const change of ["destination", "source"]) {
    const f = fixture();
    const plan = await preview(f.s3, options("move"));
    f.intercept((type, input) => {
      if (type !== "CopyObjectCommand") return;
      f.objects.set(
        "target/a",
        object({ ETag: change === "destination" ? '"corrupt"' : '"original"' }),
      );
      if (change === "source")
        f.objects.set("source/a", object({ ETag: '"new"' }));
      return { CopyObjectResult: { ETag: '"original"' } };
    });
    const result = await execute(f.s3, plan);
    assert.equal(result.failed, 1);
    assert.equal(result.deleted, 0);
    assert.equal(
      f.calls.some((call) => call.type === "DeleteObjectCommand"),
      false,
    );
    assert.equal(f.objects.has("source/a"), true);
  }
});

test("destination created during the copy race is not overwritten", async () => {
  const f = fixture();
  const plan = await preview(f.s3, options("move"));
  f.intercept((type) => {
    if (type === "CopyObjectCommand")
      f.objects.set("target/a", object({ ETag: '"someone-else"' }));
  });
  const result = await execute(f.s3, plan);
  assert.equal(result.failed, 1);
  assert.equal(result.deleted, 0);
  assert.equal(f.objects.get("target/a").ETag, '"someone-else"');
});

test("deletion uses an atomic ETag guard against changes after its final HEAD", async () => {
  const f = fixture();
  const plan = await preview(f.s3, options("delete"));
  f.intercept((type) => {
    if (type === "DeleteObjectCommand")
      f.objects.set("source/a", object({ ETag: '"raced"' }));
  });
  const result = await execute(f.s3, plan);
  assert.equal(result.failed, 1);
  assert.equal(f.objects.get("source/a").ETag, '"raced"');
});

test("preview rejects self copies, nested destinations, existing targets and source escapes", async () => {
  const f = fixture({
    "source/a": object(),
    "source/f/a": object(),
    "target/a": object(),
  });
  await assert.rejects(
    preview(f.s3, options("copy", { destinationBucket: "source" })),
    /overlap/,
  );
  await assert.rejects(
    preview(
      f.s3,
      options("move", {
        destinationBucket: "source",
        destinationPrefix: "f/nested",
        selection: [{ key: "f/", folder: true }],
      }),
    ),
    /overlap/,
  );
  await assert.rejects(preview(f.s3, options("copy")), /already exists/);
  await assert.rejects(
    preview(f.s3, options("delete", { sourcePrefix: "f/" })),
    /within the source/,
  );
});

test("folder creation conditionally creates a slash marker and never replaces an existing one", async () => {
  const f = fixture({});
  assert.deepEqual(await createFolder(f.s3, "source", "folder"), {
    bucket: "source",
    key: "folder/",
  });
  await assert.rejects(
    createFolder(f.s3, "source", "folder"),
    /PreconditionFailed/,
  );
});

test("large copy copies all byte ranges with source guards and conditionally completes", async () => {
  const size = 5 * 1024 ** 3 + 17,
    calls = [];
  const s3 = {
    async send(command) {
      const input = command.input,
        type = command.constructor.name;
      calls.push({ type, input });
      if (type === "GetObjectTaggingCommand")
        return { TagSet: [{ Key: "tag space", Value: "a&b" }] };
      if (type === "CreateMultipartUploadCommand")
        return { UploadId: "upload" };
      if (type === "UploadPartCopyCommand")
        return { CopyPartResult: { ETag: `"part-${input.PartNumber}"` } };
      if (type === "CompleteMultipartUploadCommand")
        return { ETag: '"copied"', VersionId: "new-version" };
      throw new Error(type);
    },
  };
  const result = await copyObject(s3, {
    bucket: "source",
    key: "a #? 日本語",
    destinationBucket: "target",
    destinationKey: "a",
    size,
    etag: '"original"',
    versionId: "v/1",
    sourceHead: object({
      ContentLength: size,
      Metadata: { user: "value" },
      ContentType: "video/mp4",
    }),
  });
  assert.equal(result.etag, '"copied"');
  const parts = calls.filter((call) => call.type === "UploadPartCopyCommand");
  assert.equal(parts.length, 11);
  assert.equal(parts[0].input.CopySourceRange, "bytes=0-536870911");
  assert.equal(
    parts.at(-1).input.CopySourceRange,
    `bytes=${5 * 1024 ** 3}-${size - 1}`,
  );
  assert.ok(
    parts.every((part) => part.input.CopySourceIfMatch === '"original"'),
  );
  assert.match(parts[0].input.CopySource, /a%20%23%3F%20/);
  assert.match(parts[0].input.CopySource, /versionId=v%2F1/);
  const start = calls.find(
    (call) => call.type === "CreateMultipartUploadCommand",
  );
  assert.deepEqual(start.input.Metadata, { user: "value" });
  assert.equal(start.input.Tagging, "tag%20space=a%26b");
  assert.equal(calls.at(-1).input.IfNoneMatch, "*");
});

test("failed multipart copy aborts the incomplete upload and never deletes source", async () => {
  const calls = [],
    size = 6 * 1024 ** 3;
  const s3 = {
    async send(command) {
      calls.push(command.constructor.name);
      if (command.constructor.name === "GetObjectTaggingCommand") return {};
      if (command.constructor.name === "CreateMultipartUploadCommand")
        return { UploadId: "upload" };
      if (command.constructor.name === "UploadPartCopyCommand")
        throw new Error("Source precondition failed");
      if (command.constructor.name === "AbortMultipartUploadCommand") return {};
      throw new Error("unexpected");
    },
  };
  await assert.rejects(
    copyObject(s3, {
      bucket: "source",
      key: "a",
      destinationBucket: "target",
      destinationKey: "a",
      size,
      etag: '"original"',
      sourceHead: object({ ContentLength: size }),
    }),
    /precondition/,
  );
  assert.equal(calls.at(-1), "AbortMultipartUploadCommand");
  assert.equal(calls.includes("CompleteMultipartUploadCommand"), false);
});

test("metadata copies retain headers and conditionally replace the reviewed destination", async () => {
  let input;
  const s3 = {
    async send(command) {
      input = command.input;
      return { CopyObjectResult: { ETag: '"new"' } };
    },
  };
  await copyObject(s3, {
    bucket: "source",
    key: "a",
    size: 4,
    etag: '"original"',
    destinationEtag: '"current"',
    sourceHead: object({
      ContentType: "text/plain",
      CacheControl: "max-age=30",
      Metadata: { old: "value" },
    }),
    attributes: { Metadata: { new: "value" } },
  });
  assert.equal(input.IfMatch, '"current"');
  assert.equal(input.IfNoneMatch, undefined);
  assert.equal(input.CacheControl, "max-age=30");
  assert.deepEqual(input.Metadata, { new: "value" });
  assert.equal(input.MetadataDirective, "REPLACE");
});
