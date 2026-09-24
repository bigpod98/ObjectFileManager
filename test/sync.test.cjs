const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { compare, validate, executeDeletions } = require("../src/sync.cjs");

const md5 = (body) => `"${createHash("md5").update(body).digest("hex")}"`;
function remote(objects, pageSize = 2) {
  const state = new Map(
    Object.entries(objects).map(([key, value]) => [
      key,
      typeof value === "string"
        ? {
            ContentLength: Buffer.byteLength(value),
            ETag: md5(value),
            LastModified: new Date("2025-01-01"),
          }
        : value,
    ]),
  );
  const calls = [];
  const s3 = {
    state,
    calls,
    async send(command) {
      const type = command.constructor.name,
        input = command.input;
      calls.push({ type, input });
      if (type === "ListObjectsV2Command") {
        const keys = [...state.keys()]
          .filter((key) => key.startsWith(input.Prefix))
          .sort();
        const offset = Number(input.ContinuationToken || 0);
        return {
          Contents: keys.slice(offset, offset + pageSize).map((key) => ({
            Key: key,
            Size: state.get(key).ContentLength,
            ETag: state.get(key).ETag,
            LastModified: state.get(key).LastModified,
          })),
          IsTruncated: offset + pageSize < keys.length,
          NextContinuationToken:
            offset + pageSize < keys.length
              ? String(offset + pageSize)
              : undefined,
        };
      }
      if (type === "HeadObjectCommand") {
        if (!state.has(input.Key))
          throw Object.assign(new Error("missing"), { name: "NotFound" });
        return { ...state.get(input.Key) };
      }
      if (type === "DeleteObjectCommand") {
        if (state.has(input.Key) && state.get(input.Key).ETag !== input.IfMatch)
          throw new Error("PreconditionFailed");
        state.delete(input.Key);
        return {};
      }
      throw new Error(`Unexpected ${type}`);
    },
  };
  return s3;
}
async function source(t, files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "s3-sync-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    if (content === null)
      await fs.mkdir(path.join(root, name), { recursive: true });
    else await fs.writeFile(path.join(root, name), content);
  }
  return root;
}

test("compares complete paginated prefixes and maps folder contents, preserving remote extras by default", async (t) => {
  const root = await source(t, {
    "same.txt": "same",
    "changed.txt": "new",
    "nested/new.txt": "new",
    empty: null,
  });
  const s3 = remote(
    {
      "target/same.txt": "same",
      "target/changed.txt": "old",
      "target/extra.txt": "extra",
      "elsewhere/ignored": "ignored",
    },
    1,
  );
  const plan = await compare(s3, {
    profile: "p",
    bucket: "b",
    source: root,
    prefix: "target",
  });
  assert.equal(plan.prefix, "target/");
  assert.equal(
    plan.rows.find((r) => r.key === "target/same.txt").status,
    "unchanged",
  );
  assert.equal(
    plan.rows.find((r) => r.key === "target/changed.txt").status,
    "changed",
  );
  assert.equal(
    plan.rows.find((r) => r.key === "target/extra.txt").status,
    "remote-only",
  );
  assert.ok(
    plan.entries.some((entry) => entry.key === "target/nested/new.txt"),
  );
  assert.ok(
    plan.entries.some(
      (entry) => entry.key === "target/empty/" && entry.directory,
    ),
  );
  assert.equal(
    plan.entries.find((entry) => entry.key === "target/changed.txt").etag,
    md5("old"),
  );
  assert.equal(
    plan.entries.find((entry) => entry.key === "target/nested/new.txt")
      .expectedAbsent,
    true,
  );
  assert.equal(plan.deletions.length, 0);
  assert.equal(
    s3.calls.filter((call) => call.type === "ListObjectsV2Command").length,
    3,
  );
  assert.equal(await validate(plan, s3), true);
});

test("multipart and encrypted ETags are uncertain while full-object checksums can establish equality", async (t) => {
  const root = await source(t, {
    multipart: "abc",
    kms: "abc",
    composite: "abc",
    sha256: "abc",
  });
  const digest = createHash("sha256").update("abc").digest("base64");
  const s3 = remote({
    multipart: { ContentLength: 3, ETag: `${md5("abc").slice(0, -1)}-2"` },
    kms: {
      ContentLength: 3,
      ETag: md5("abc"),
      ServerSideEncryption: "aws:kms",
    },
    composite: {
      ContentLength: 3,
      ETag: '"opaque"',
      ChecksumSHA256: digest,
      ChecksumType: "COMPOSITE",
    },
    sha256: {
      ContentLength: 3,
      ETag: '"opaque"',
      ChecksumSHA256: digest,
      ChecksumType: "FULL_OBJECT",
    },
  });
  const plan = await compare(s3, { bucket: "b", source: root });
  for (const key of ["multipart", "kms", "composite"]) {
    assert.equal(plan.rows.find((r) => r.key === key).status, "changed");
    assert.match(plan.rows.find((r) => r.key === key).reason, /uncertain/);
  }
  assert.equal(plan.rows.find((r) => r.key === "sha256").status, "unchanged");
});

test("symlinks and file/folder conflicts protect overlapping remote paths from uploads and deletion", async (t) => {
  const root = await source(t, { file: "local", "folder/child": "local" });
  await fs.symlink("/no/such/target", path.join(root, "link"));
  const s3 = remote({
    "base/link/keep": "safe",
    "base/file/child": "conflict",
    "base/folder": "conflict",
    "base/remove": "gone",
    "base/": "",
  });
  const plan = await compare(s3, {
    bucket: "b",
    source: root,
    prefix: "base/",
    deleteRemote: true,
  });
  assert.equal(plan.entries.length, 0);
  assert.ok(plan.counts.conflict >= 2);
  assert.equal(plan.counts.skipped, 1);
  assert.deepEqual(
    plan.deletions.map((item) => item.key),
    ["base/remove"],
  );
  assert.equal(
    plan.rows.find((row) => row.key === "base/link/keep").protected,
    true,
  );
});

test("validation detects additions and changes to unchanged local files before applying", async (t) => {
  const root = await source(t, { same: "abc" });
  const s3 = remote({ same: "abc" });
  const plan = await compare(s3, { bucket: "b", source: root });
  await fs.writeFile(path.join(root, "same"), "xyz");
  await assert.rejects(validate(plan), /Local folder contents changed/);
  const second = await compare(s3, { bucket: "b", source: root });
  await fs.writeFile(path.join(root, "added"), "x");
  await assert.rejects(validate(second), /Local folder contents changed/);
});

test("validation rejects replaced symlinks and remote changes before apply", async (t) => {
  const root = await source(t, { file: "abc" });
  const s3 = remote({ file: "old" });
  const plan = await compare(s3, { bucket: "b", source: root });
  s3.state.set("file", { ContentLength: 3, ETag: md5("new") });
  await assert.rejects(validate(plan, s3), /Remote object changed/);
  await fs.unlink(path.join(root, "file"));
  await fs.symlink("/etc/hosts", path.join(root, "file"));
  await assert.rejects(validate(plan), /Local folder contents changed/);
});

test("deletions preflight every target before deleting and retry safely after partial completion", async (t) => {
  const root = await source(t, {});
  const s3 = remote({ first: "a", second: "b" });
  const plan = await compare(s3, {
    bucket: "b",
    source: root,
    deleteRemote: true,
  });
  const original = s3.state.get("second");
  s3.state.set("second", { ContentLength: 1, ETag: md5("c") });
  await assert.rejects(executeDeletions(s3, plan), /deletion target changed/);
  assert.equal(
    s3.calls.filter((c) => c.type === "DeleteObjectCommand").length,
    0,
  );
  s3.state.set("second", original);
  s3.state.delete("first");
  const result = await executeDeletions(s3, plan);
  assert.deepEqual(result, { deleted: 2, failures: [] });
  assert.equal(
    s3.calls.find((c) => c.type === "DeleteObjectCommand").input.IfMatch,
    md5("b"),
  );
  assert.deepEqual(await executeDeletions(s3, plan), {
    deleted: 2,
    failures: [],
  });
});

test("conditional deletion refuses a target changed after preflight and never falls back", async (t) => {
  const root = await source(t, {});
  const s3 = remote({ extra: "a" });
  const plan = await compare(s3, {
    bucket: "b",
    source: root,
    deleteRemote: true,
  });
  const send = s3.send.bind(s3);
  s3.send = async (command) => {
    if (command.constructor.name === "DeleteObjectCommand")
      s3.state.set("extra", { ContentLength: 1, ETag: md5("b") });
    return send(command);
  };
  const result = await executeDeletions(s3, plan);
  assert.equal(result.deleted, 0);
  assert.equal(result.failures.length, 1);
  assert.ok(s3.state.has("extra"));
  assert.equal(
    s3.calls.filter((c) => c.type === "DeleteObjectCommand").length,
    1,
  );
});

test("incomplete remote listings and linked source folders are rejected", async (t) => {
  const root = await source(t, { actual: null });
  await fs.symlink(path.join(root, "actual"), path.join(root, "alias"));
  await assert.rejects(
    compare(remote({}), { bucket: "b", source: path.join(root, "alias") }),
    /symbolic links/,
  );
  const s3 = {
    async send() {
      return { IsTruncated: true, Contents: [] };
    },
  };
  await assert.rejects(
    compare(s3, { bucket: "b", source: root }),
    /incomplete/,
  );
});

test("cleanup stops if new local content appears after uploads", async (t) => {
  const root = await source(t, {});
  const s3 = remote({ extra: "remote" });
  const plan = await compare(s3, {
    bucket: "b",
    source: root,
    deleteRemote: true,
  });
  await fs.writeFile(path.join(root, "extra"), "local");
  await assert.rejects(
    executeDeletions(s3, plan),
    /Local folder contents changed/,
  );
  assert.ok(s3.state.has("extra"));
  assert.equal(
    s3.calls.filter((call) => call.type === "DeleteObjectCommand").length,
    0,
  );
});

test("apply refuses a newly created remote destination and retains objects without ETags", async (t) => {
  const root = await source(t, { fresh: "local" });
  const s3 = remote({ unguarded: { ContentLength: 5 } });
  const plan = await compare(s3, {
    bucket: "b",
    source: root,
    deleteRemote: true,
  });
  assert.deepEqual(plan.deletions, []);
  assert.match(
    plan.rows.find((row) => row.key === "unguarded").reason,
    /did not provide an ETag/,
  );
  s3.state.set("fresh", { ContentLength: 5, ETag: md5("other") });
  await assert.rejects(validate(plan, s3), /Remote object changed/);
});

test("an already aborted cleanup performs no local validation or remote requests", async () => {
  const controller = new AbortController();
  controller.abort();
  const s3 = remote({ extra: "remote" });
  await assert.rejects(
    executeDeletions(s3, { source: "/does-not-exist" }, controller.signal),
    { name: "AbortError" },
  );
  assert.deepEqual(s3.calls, []);
});

test("cleanup can be interrupted while hashing local files before preflight", async (t) => {
  const root = await source(t, { large: Buffer.alloc(1024 * 1024, "a") });
  const s3 = remote({ extra: "remote" });
  const plan = await compare(s3, {
    bucket: "b",
    source: root,
    deleteRemote: true,
  });
  s3.calls.length = 0;
  const controller = new AbortController();
  const open = fs.open.bind(fs);
  let interrupted = false;
  t.mock.method(fs, "open", async (...args) => {
    const handle = await open(...args);
    const createReadStream = handle.createReadStream.bind(handle);
    handle.createReadStream = (options) => {
      assert.equal(options.signal, controller.signal);
      const stream = createReadStream(options);
      stream.once("data", () => {
        interrupted = true;
        controller.abort();
      });
      return stream;
    };
    return handle;
  });
  await assert.rejects(executeDeletions(s3, plan, controller.signal), {
    name: "AbortError",
  });
  assert.equal(interrupted, true);
  assert.deepEqual(s3.calls, []);
  assert.ok(s3.state.has("extra"));
});
