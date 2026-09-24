const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Queue } = require("../src/queue.cjs");
const { Workspace } = require("../src/workspace.cjs");

function remote() {
  const objects = new Map();
  const requests = [];
  let deleteFailure = false;
  return {
    objects,
    requests,
    set deleteFailure(value) {
      deleteFailure = value;
    },
    put(key) {
      objects.set(key, { ContentLength: 3, ETag: `"${key}"` });
    },
    async send(command) {
      const { Key, Prefix = "", IfMatch } = command.input;
      const type = command.constructor.name;
      requests.push({ type, ...command.input });
      if (type === "ListObjectsV2Command") {
        return {
          Contents: [...objects]
            .filter(([key]) => key.startsWith(Prefix))
            .map(([key, value]) => ({
              Key: key,
              Size: value.ContentLength,
              ETag: value.ETag,
            })),
        };
      }
      const object = objects.get(Key);
      if (!object)
        throw Object.assign(new Error("Missing"), {
          name: "NotFound",
          $metadata: { httpStatusCode: 404 },
        });
      if (type === "HeadObjectCommand") return { ...object };
      if (type === "DeleteObjectCommand") {
        assert.equal(
          IfMatch,
          object.ETag,
          "cleanup retains its reviewed condition",
        );
        if (deleteFailure) throw new Error("Deletion temporarily unavailable");
        objects.delete(Key);
        return {};
      }
      throw new Error(`Unexpected S3 request: ${type}`);
    },
  };
}

async function fixture(t, transfer = async () => {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "s3-workspace-"));
  const source = path.join(root, "source");
  await fs.mkdir(source);
  const db = path.join(root, "queue.sqlite");
  const s3 = remote();
  const clients = [];
  const activity = [];
  let queue, workspace;
  const reopen = () => {
    queue = new Queue(db, transfer);
    workspace = new Workspace(
      queue,
      (profile) => {
        clients.push(profile);
        return s3;
      },
      (active) => activity.push(active),
    );
    return { queue, workspace };
  };
  reopen();
  t.after(async () => {
    await workspace.close();
    queue.db.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, source, db, s3, queue, workspace, reopen, clients, activity };
}

async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "workspace settled within the deadline");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function complete(workspace, id) {
  await workspace.start(id);
  await workspace.finishing;
}

function job(queue, key) {
  return queue.createJob({
    profile: "profile",
    bucket: "bucket",
    entries: [{ source: "", key: `${key}/`, size: 0, directory: true }],
  });
}

async function syncJob(f, { upload = true } = {}) {
  if (upload) await fs.writeFile(path.join(f.source, "new.txt"), "new");
  f.s3.put("backup/old.txt");
  const preview = await f.workspace.compare({
    profile: "profile",
    bucket: "bucket",
    prefix: "backup/",
    source: f.source,
    deleteRemote: true,
  });
  const id = await f.workspace.apply(preview.token);
  f.queue.configure(id, { retries: 0 });
  return id;
}

const deletes = (s3) =>
  s3.requests.filter((request) => request.type === "DeleteObjectCommand");

test("automatic progression requires opt-in and runs pending batches", async (t) => {
  const calls = [];
  const f = await fixture(t, async (_, batch) => {
    calls.push(batch.id);
  });
  const first = job(f.queue, "first");
  const second = job(f.queue, "second");
  await f.workspace.advance();
  assert.deepEqual(calls, []);
  await complete(f.workspace, first);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [first]);
  assert.equal(
    f.queue.list().find((batch) => batch.id === second).state,
    "paused",
  );
  f.workspace.auto = true;
  await f.workspace.advance();
  await until(
    () =>
      f.queue.list().every((batch) => batch.state === "complete") &&
      !f.workspace.finishing,
  );
  assert.deepEqual(calls, [first, second]);
  assert.deepEqual(f.activity, [true, false, true, false]);
});

test("pause aborts the current transfer and disables automatic progression", async (t) => {
  const calls = [];
  const f = await fixture(t, (_, batch, entry, signal) => {
    calls.push(batch.id);
    return new Promise((resolve, reject) =>
      signal.addEventListener("abort", () => reject(new Error("Aborted")), {
        once: true,
      }),
    );
  });
  const first = job(f.queue, "first");
  job(f.queue, "second");
  f.workspace.auto = true;
  await f.workspace.start(first);
  await until(() => calls.length === 1);
  await f.workspace.pause();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.workspace.auto, false);
  assert.deepEqual(calls, [first]);
  assert.ok(f.queue.list().every((batch) => batch.state === "paused"));
});

test("sync deletes reviewed remote objects only after uploads succeed", async (t) => {
  let fail = true;
  let s3;
  const f = await fixture(t, async () => {
    assert.equal(deletes(s3).length, 0);
    if (fail) throw new Error("Upload unavailable");
  });
  s3 = f.s3;
  const id = await syncJob(f);
  await complete(f.workspace, id);
  assert.equal(f.workspace.list()[0].state, "failed");
  assert.equal(f.workspace.list()[0].cleanupState, "pending");
  assert.equal(deletes(s3).length, 0);
  fail = false;
  f.workspace.retry(id);
  await complete(f.workspace, id);
  assert.equal(f.workspace.list()[0].cleanupState, "done");
  assert.deepEqual(
    deletes(s3).map((request) => request.Key),
    ["backup/old.txt"],
  );
});

test("failed sync cleanup can be retried without uploading successful files again", async (t) => {
  let uploads = 0;
  const f = await fixture(t, async () => {
    uploads++;
  });
  const id = await syncJob(f);
  f.s3.deleteFailure = true;
  await complete(f.workspace, id);
  assert.equal(uploads, 1);
  assert.equal(f.workspace.list()[0].state, "failed");
  assert.match(
    f.workspace.list()[0].error,
    /Sync cleanup:.*Deletion temporarily unavailable/,
  );
  f.s3.deleteFailure = false;
  f.workspace.retry(id);
  await complete(f.workspace, id);
  assert.equal(uploads, 1);
  assert.equal(f.workspace.list()[0].state, "complete");
  assert.equal(f.workspace.list()[0].cleanupState, "done");
});

test("restarted sync exposes interrupted cleanup for explicit resume without automatic deletion", async (t) => {
  let uploads = 0;
  const f = await fixture(t, async () => {
    uploads++;
  });
  const id = await syncJob(f);
  // Simulate a crash after upload persistence, before cleanup committed.
  await f.queue.start(id, f.s3);
  await f.queue.running.finished;
  f.queue.db
    .prepare("UPDATE sync_runs SET state='running' WHERE job=?")
    .run(id);
  await f.workspace.close();
  f.queue.db.close();
  const { queue, workspace } = f.reopen();
  assert.equal(workspace.auto, false);
  await workspace.advance();
  assert.equal(deletes(f.s3).length, 0);
  assert.equal(workspace.list()[0].cleanupState, "pending");
  assert.equal(workspace.list()[0].state, "paused");
  await complete(workspace, id);
  assert.equal(uploads, 1);
  assert.equal(queue.list()[0].state, "complete");
  assert.equal(workspace.list()[0].cleanupState, "done");
  assert.equal(deletes(f.s3).length, 1);
});

test("automatic progression includes deletion-only reviewed sync jobs", async (t) => {
  const f = await fixture(t);
  const id = await syncJob(f, { upload: false });
  f.workspace.auto = true;
  await f.workspace.advance();
  await until(
    () =>
      f.workspace.list().find((batch) => batch.id === id).cleanupState ===
      "done",
  );
  assert.equal(deletes(f.s3).length, 1);
});

test("cancelled sync never deletes remote objects and requires a fresh comparison", async (t) => {
  const f = await fixture(t);
  const id = await syncJob(f);
  await f.workspace.cancel(id);
  assert.equal(f.workspace.list()[0].state, "cancelled");
  await assert.rejects(f.workspace.start(id), /not ready/);
  assert.throws(() => f.workspace.retry(id), /compar|preview/i);
  assert.equal(deletes(f.s3).length, 0);
  assert.equal(f.workspace.list()[0].cleanupState, "cancelled");
});

test("cancelling an active sync aborts uploads without deleting reviewed objects", async (t) => {
  let started = false;
  const f = await fixture(t, (_, batch, entry, signal) => {
    started = true;
    return new Promise((resolve, reject) =>
      signal.addEventListener("abort", () => reject(new Error("Aborted")), {
        once: true,
      }),
    );
  });
  const id = await syncJob(f);
  f.workspace.auto = true;
  await f.workspace.start(id);
  await until(() => started);
  await f.workspace.cancel(id);
  assert.equal(f.workspace.auto, false);
  assert.equal(f.workspace.list()[0].state, "cancelled");
  assert.equal(f.workspace.list()[0].cleanupState, "cancelled");
  assert.equal(deletes(f.s3).length, 0);
});

test("sync cleanup rechecks local content after uploads before deleting", async (t) => {
  const f = await fixture(t, async (_, batch, entry) => {
    await fs.writeFile(entry.source, "changed while uploading");
  });
  const id = await syncJob(f);
  await complete(f.workspace, id);
  assert.equal(f.workspace.list()[0].state, "failed");
  assert.equal(f.workspace.list()[0].cleanupState, "failed");
  assert.match(f.workspace.list()[0].error, /Local folder contents changed/);
  assert.equal(deletes(f.s3).length, 0);
});

test("cleanup holds the workspace busy until its remote requests settle", async (t) => {
  const f = await fixture(t);
  const id = await syncJob(f);
  const another = job(f.queue, "another");
  let release,
    deleting = false;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const send = f.s3.send.bind(f.s3);
  f.s3.send = async (command) => {
    if (command.constructor.name === "DeleteObjectCommand") {
      deleting = true;
      await gate;
    }
    return send(command);
  };
  await f.workspace.start(id);
  await until(() => deleting);
  try {
    assert.equal(f.queue.running, null);
    assert.equal(
      f.workspace.list().find((batch) => batch.id === id).state,
      "running",
    );
    await assert.rejects(f.workspace.start(another), /current batch/);
    assert.throws(() => f.workspace.remove(id), /finish/);
    assert.throws(() => f.workspace.retry(id), /finish/);
  } finally {
    release();
    await f.workspace.finishing;
  }
  assert.equal(
    f.workspace.list().find((batch) => batch.id === id).cleanupState,
    "done",
  );
});

test("changed local contents reject sync application before creating a durable batch", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.source, "new.txt"), "new");
  const { token } = await f.workspace.compare({
    profile: "profile",
    bucket: "bucket",
    source: f.source,
  });
  await fs.writeFile(path.join(f.source, "new.txt"), "changed");
  await assert.rejects(f.workspace.apply(token), /changed/);
  assert.equal(f.queue.list().length, 0);
  await assert.rejects(f.workspace.apply(token), /expired/);
});

test("operation tokens select authoritative plans and are single-use", async (t) => {
  const f = await fixture(t);
  f.s3.put("reviewed");
  f.s3.put("unreviewed");
  const preview = await f.workspace.preview({
    profile: "profile",
    bucket: "bucket",
    action: "delete",
    selection: [{ key: "reviewed" }],
  });
  // IPC gives the renderer a structured clone, never the stored plan object.
  const rendererCopy = structuredClone(preview);
  rendererCopy.plan.items[0].key = "unreviewed";
  await assert.rejects(
    f.workspace.execute({ token: preview.token, plan: rendererCopy.plan }),
    /expired/,
  );
  const result = await f.workspace.execute(preview.token);
  assert.equal(result.deleted, 1);
  assert.equal(f.s3.objects.has("reviewed"), false);
  assert.equal(f.s3.objects.has("unreviewed"), true);
  await assert.rejects(f.workspace.execute(preview.token), /expired/);
  assert.ok(f.clients.every((profile) => profile === "profile"));
});

test("preview types cannot be interchanged and expired tokens cannot execute", async (t) => {
  const f = await fixture(t);
  f.s3.put("reviewed");
  const { token } = await f.workspace.preview({
    profile: "profile",
    bucket: "bucket",
    action: "delete",
    selection: [{ key: "reviewed" }],
  });
  await assert.rejects(f.workspace.apply(token), /expired/);
  assert.equal(f.queue.list().length, 0);
  f.workspace.plans.get(token).created = Date.now() - 3600001;
  await assert.rejects(f.workspace.execute(token), /expired/);
  assert.equal(deletes(f.s3).length, 0);
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

for (const action of ["pause", "close"]) {
  test(`${action} stops after an in-flight delete and restart resumes remaining cleanup`, async (t) => {
    const f = await fixture(t);
    f.s3.put("backup/second.txt");
    const id = await syncJob(f, { upload: false });
    const entered = deferred(),
      release = deferred();
    const send = f.s3.send.bind(f.s3);
    let requestSignal;
    f.s3.send = async (command, options) => {
      if (command.constructor.name === "DeleteObjectCommand") {
        requestSignal = options.abortSignal;
        entered.resolve();
        // Model a service that already accepted the delete before abort arrived.
        await release.promise;
      }
      return send(command);
    };
    await f.workspace.start(id);
    await entered.promise;
    const stopping = f.workspace[action]();
    assert.equal(requestSignal.aborted, true);
    release.resolve();
    await stopping;
    assert.equal(deletes(f.s3).length, 1);
    assert.equal(f.s3.objects.size, 1);
    assert.equal(f.workspace.list()[0].state, "paused");
    assert.equal(f.workspace.list()[0].cleanupState, "pending");
    assert.equal(f.workspace.list()[0].error, null);
    await f.workspace.close();
    f.queue.db.close();
    const { workspace } = f.reopen();
    assert.equal(workspace.list()[0].state, "paused");
    assert.equal(deletes(f.s3).length, 1);
    f.s3.send = send;
    await complete(workspace, id);
    assert.equal(workspace.list()[0].cleanupState, "done");
    assert.equal(deletes(f.s3).length, 2);
    assert.equal(new Set(deletes(f.s3).map((r) => r.Key)).size, 2);
    assert.equal(f.s3.objects.size, 0);
  });
}

test("cancel aborts cleanup requests and persists cancellation across restart", async (t) => {
  const f = await fixture(t);
  f.s3.put("backup/second.txt");
  const id = await syncJob(f, { upload: false });
  const entered = deferred();
  const send = f.s3.send.bind(f.s3);
  let requestSignal,
    attempted = 0;
  f.s3.send = async (command, options) => {
    if (command.constructor.name !== "DeleteObjectCommand")
      return send(command);
    attempted++;
    requestSignal = options.abortSignal;
    entered.resolve();
    await new Promise((resolve, reject) =>
      requestSignal.addEventListener(
        "abort",
        () => reject(requestSignal.reason),
        { once: true },
      ),
    );
  };
  f.workspace.auto = true;
  await f.workspace.start(id);
  await entered.promise;
  await f.workspace.cancel(id);
  assert.equal(requestSignal.aborted, true);
  assert.equal(attempted, 1);
  assert.equal(f.s3.objects.size, 2);
  assert.equal(f.workspace.auto, false);
  assert.equal(f.workspace.list()[0].state, "cancelled");
  assert.equal(f.workspace.list()[0].cleanupState, "cancelled");
  await f.workspace.close();
  f.queue.db.close();
  const { workspace } = f.reopen();
  assert.equal(workspace.list()[0].state, "cancelled");
  assert.throws(() => workspace.retry(id), /cancelled/);
  await assert.rejects(workspace.start(id), /not ready/);
  assert.equal(attempted, 1);
});

test("pause aborts cleanup HEAD preflight before any deletion", async (t) => {
  const f = await fixture(t);
  f.s3.put("backup/second.txt");
  const id = await syncJob(f, { upload: false });
  const entered = deferred();
  const send = f.s3.send.bind(f.s3);
  let heads = 0,
    requestSignal;
  f.s3.send = async (command, options) => {
    if (command.constructor.name !== "HeadObjectCommand") return send(command);
    heads++;
    requestSignal = options.abortSignal;
    entered.resolve();
    await new Promise((resolve, reject) =>
      requestSignal.addEventListener(
        "abort",
        () => reject(requestSignal.reason),
        { once: true },
      ),
    );
  };
  await f.workspace.start(id);
  await entered.promise;
  await f.workspace.pause();
  assert.equal(requestSignal.aborted, true);
  assert.equal(heads, 1);
  assert.equal(deletes(f.s3).length, 0);
  assert.equal(f.workspace.list()[0].cleanupState, "pending");
  assert.equal(f.workspace.list()[0].state, "paused");
  f.s3.send = send;
  await complete(f.workspace, id);
  assert.equal(deletes(f.s3).length, 2);
});

test("pause at upload completion prevents cleanup from starting", async (t) => {
  const f = await fixture(t);
  const id = await syncJob(f);
  const start = f.queue.start.bind(f.queue);
  let paused;
  f.queue.start = async (...args) => {
    await start(...args);
    f.queue.running.finished.then(() => {
      paused = f.workspace.pause();
    });
  };
  await f.workspace.start(id);
  await f.workspace.finishing;
  await paused;
  assert.equal(f.queue.list()[0].state, "complete");
  assert.equal(f.workspace.list()[0].state, "paused");
  assert.equal(f.workspace.list()[0].cleanupState, "pending");
  assert.equal(deletes(f.s3).length, 0);
});

test("cancelling another queued batch leaves active cleanup running", async (t) => {
  const f = await fixture(t);
  const id = await syncJob(f, { upload: false });
  const another = job(f.queue, "another");
  const entered = deferred(),
    release = deferred();
  const send = f.s3.send.bind(f.s3);
  let requestSignal;
  f.s3.send = async (command, options) => {
    if (command.constructor.name === "DeleteObjectCommand") {
      requestSignal = options.abortSignal;
      entered.resolve();
      await release.promise;
    }
    return send(command);
  };
  await f.workspace.start(id);
  await entered.promise;
  try {
    await f.workspace.cancel(another);
    assert.equal(requestSignal.aborted, false);
    assert.equal(
      f.workspace.list().find((j) => j.id === another).state,
      "cancelled",
    );
    assert.equal(
      f.workspace.list().find((j) => j.id === id).cleanupState,
      "running",
    );
  } finally {
    release.resolve();
    await f.workspace.finishing;
  }
  assert.equal(
    f.workspace.list().find((j) => j.id === id).cleanupState,
    "done",
  );
});
