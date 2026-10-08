const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { Readable } = require("node:stream");
const { Queue } = require("../src/queue.cjs");
const { client, transfer } = require("../src/storage.cjs");
const sha = (body) => createHash("sha256").update(body).digest("base64");
const error = (status, name) =>
  Object.assign(new Error(name), {
    name,
    $metadata: { httpStatusCode: status },
  });

async function fixture(
  t,
  { directory = false, multipart = false, absent = true, retries = 0 } = {},
) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "objectfilemanager-recovery-"),
  );
  const source = path.join(root, "source");
  const body = directory
    ? Buffer.alloc(0)
    : Buffer.alloc(multipart ? 9 * 1024 * 1024 : 7, 42);
  if (directory) await fs.mkdir(source);
  else await fs.writeFile(source, body);
  const dbFile = path.join(root, "queue.sqlite");
  let q = new Queue(dbFile, transfer);
  const id = q.createJob({
    profile: "profile-private",
    bucket: "bucket",
    overwrite: true,
    retries,
    entries: [
      {
        source,
        key: directory ? "folder/" : "file",
        size: body.length,
        mtime: (await fs.stat(source)).mtimeMs,
        directory,
        sha256: directory ? undefined : sha(body),
        expectedAbsent: absent,
        etag: absent ? null : '"original"',
        root,
      },
    ],
  });
  const s3 = client({
    endpoint: "http://localhost:1",
    accessKeyId: "private-access",
    secretAccessKey: "private-secret",
  });
  const state = {
    calls: [],
    object: absent
      ? null
      : { body: Buffer.from("old"), etag: '"original"', metadata: {} },
    writes: 0,
    readFailures: 0,
    loseReply: true,
  };
  let pending;
  s3.send = async (command, options) => {
    options?.abortSignal?.throwIfAborted();
    const name = command.constructor.name;
    const input = command.input;
    state.calls.push(name);
    if (name === "GetObjectCommand") {
      if (state.readFailures-- > 0) throw error(403, "AccessDenied");
      if (!state.object) throw error(404, "NoSuchKey");
      return {
        ContentLength: state.object.body.length,
        Metadata: state.object.metadata,
        Body: state.unreadable ? undefined : Readable.from([state.object.body]),
      };
    }
    if (name === "CreateMultipartUploadCommand") {
      pending = { input, parts: [] };
      return { UploadId: "multipart" };
    }
    if (name === "UploadPartCommand") {
      pending.parts[input.PartNumber - 1] = Buffer.from(input.Body);
      return { ETag: '"part"' };
    }
    if (name === "AbortMultipartUploadCommand") return {};
    if (
      name === "PutObjectCommand" ||
      name === "CompleteMultipartUploadCommand"
    ) {
      if (
        (input.IfNoneMatch && state.object) ||
        (input.IfMatch && input.IfMatch !== state.object?.etag)
      )
        throw error(412, "PreconditionFailed");
      const bytes =
        name === "PutObjectCommand"
          ? Buffer.from(input.Body)
          : Buffer.concat(pending.parts);
      const metadata =
        name === "PutObjectCommand" ? input.Metadata : pending.input.Metadata;
      const persisted = q.db
        .prepare("SELECT * FROM entries WHERE job=?")
        .get(id);
      assert.ok(persisted.uploadToken);
      assert.equal(persisted.sha256, sha(bytes));
      assert.ok(persisted.attempts > 0);
      assert.deepEqual(Object.keys(metadata).sort(), [
        "objectfilemanager-sha256",
        "objectfilemanager-upload-token",
      ]);
      state.object = { body: bytes, metadata, etag: '"uploaded"' };
      state.writes++;
      if (state.loseReply) throw new Error("Connection lost after commit");
      return { ETag: '"uploaded"' };
    }
    throw new Error(`Unexpected ${name}`);
  };
  const run = async () => {
    await q.start(id, s3);
    await q.running.finished;
    return q.list()[0];
  };
  const reopen = () => {
    q.db.close();
    q = new Queue(dbFile, transfer);
  };
  t.after(async () => {
    await q.pause();
    q.db.close();
    s3.destroy();
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    get q() {
      return q;
    },
    state,
    id,
    body,
    source,
    run,
    reopen,
  };
}

test("lost success replies reconcile guarded creates, replacements, folders and multipart writes", async (t) => {
  for (const options of [
    {},
    { absent: false },
    { directory: true },
    { multipart: true },
  ]) {
    await t.test(JSON.stringify(options), async (t) => {
      const f = await fixture(t, options);
      assert.equal((await f.run()).state, "complete");
      assert.equal(f.state.writes, 1);
      assert.deepEqual(f.state.object.body, f.body);
    });
  }
});

test("automatic retry recovers after both upload reply and reconciliation read fail", async (t) => {
  const f = await fixture(t, { retries: 1 });
  f.state.readFailures = 1;
  assert.equal((await f.run()).state, "complete");
  assert.equal(f.state.writes, 1);
  assert.equal(
    f.q.db.prepare("SELECT attempts FROM entries").get().attempts,
    2,
  );
});

test("reopen recovers interrupted and explicitly retried failed jobs without replacing the remote again", async (t) => {
  for (const interrupted of [true, false])
    await t.test(String(interrupted), async (t) => {
      const f = await fixture(t, { absent: false });
      f.state.readFailures = 1;
      assert.equal((await f.run()).state, "failed");
      const evidence = f.q.db
        .prepare("SELECT sha256,uploadToken FROM entries")
        .get();
      if (interrupted) {
        f.q.db.exec(
          "UPDATE entries SET state='uploading'; UPDATE jobs SET state='running'",
        );
      }
      f.reopen();
      assert.deepEqual(
        f.q.db.prepare("SELECT sha256,uploadToken FROM entries").get(),
        evidence,
      );
      if (!interrupted) f.q.retry(f.id);
      assert.equal((await f.run()).state, "complete");
      assert.equal(f.state.writes, 1);
    });
});

test("same-size concurrent objects and copied metadata with wrong contents cannot establish success", async (t) => {
  for (const change of ["token", "checksum", "content", "legacy"])
    await t.test(change, async (t) => {
      const f = await fixture(t);
      f.state.readFailures = 1;
      assert.equal((await f.run()).state, "failed");
      if (change === "token")
        f.state.object.metadata["objectfilemanager-upload-token"] =
          "another-operation";
      if (change === "checksum")
        f.state.object.metadata["objectfilemanager-sha256"] = sha("changed");
      if (change === "content")
        f.state.object.body = Buffer.alloc(f.body.length, 1);
      if (change === "legacy")
        f.q.db.exec("UPDATE entries SET sha256=NULL,uploadToken=NULL");
      f.q.retry(f.id);
      assert.equal((await f.run()).state, "failed");
      assert.equal(f.state.writes, 1);
      assert.match(f.q.entries(f.id)[0].error, /PreconditionFailed/);
    });
});

test("recovery permission failures and unavailable bodies fail closed", async (t) => {
  for (const unreadable of [false, true])
    await t.test(String(unreadable), async (t) => {
      const f = await fixture(t);
      f.state.readFailures = 1;
      assert.equal((await f.run()).state, "failed");
      f.state.unreadable = unreadable;
      if (!unreadable) f.state.readFailures = 1;
      f.q.retry(f.id);
      assert.equal((await f.run()).state, "failed");
      assert.equal(f.state.writes, 1);
      assert.match(f.q.entries(f.id)[0].error, /AccessDenied|body unavailable/);
    });
});

test("planned SHA-256 is preserved and changed content cannot be committed", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.source, Buffer.alloc(f.body.length, 9));
  f.q.db
    .prepare("UPDATE entries SET mtime=?")
    .run((await fs.stat(f.source)).mtimeMs);
  assert.equal((await f.run()).state, "failed");
  assert.equal(f.state.writes, 0);
  assert.match(f.q.entries(f.id)[0].error, /Source content changed/);
  assert.equal(
    f.q.db.prepare("SELECT sha256 FROM entries").get().sha256,
    sha(f.body),
  );
});
