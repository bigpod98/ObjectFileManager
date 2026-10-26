const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Queue } = require("../src/queue.cjs");
const { Workspace } = require("../src/workspace.cjs");

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function fixture(t, transfer = async () => {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "queue-runtime-"));
  const file = path.join(root, "queue.sqlite");
  const queue = new Queue(file, transfer);
  t.after(async () => {
    await queue.pause().catch(() => {});
    try {
      queue.db.close();
    } catch {}
    await fs.rm(root, { recursive: true, force: true });
  });
  const create = (count = 1) =>
    queue.createJob({
      profile: "p",
      bucket: "b",
      kind: "download",
      retries: 0,
      concurrency: 1,
      entries: Array.from({ length: count }, (_, i) => ({
        key: String(i),
        size: 10,
        source: path.join(root, String(i)),
        root,
      })),
    });
  return { queue, file, root, create };
}
function summary(queue) {
  const job = queue.list()[0];
  return Object.fromEntries(
    [
      "total",
      "bytes",
      "done",
      "skipped",
      "failed",
      "pending",
      "cancelled",
      "transferring",
      "completedBytes",
    ].map((key) => [key, job[key]]),
  );
}

test("maintained summaries follow insert/update/rollback/retry/cancel/remove and recovery", async (t) => {
  const { queue, file, create } = await fixture(t);
  const id = create(6);
  const update = queue.db.prepare(
    "UPDATE entries SET state=? WHERE job=? AND key=?",
  );
  ["done", "skipped", "failed", "uploading", "cancelled", "pending"].forEach(
    (state, i) => update.run(state, id, String(i)),
  );
  assert.deepEqual(summary(queue), {
    total: 6,
    bytes: 60,
    done: 1,
    skipped: 1,
    failed: 1,
    pending: 1,
    cancelled: 1,
    transferring: 1,
    completedBytes: 20,
  });
  queue.db.exec("BEGIN; UPDATE entries SET state='done',size=20; ROLLBACK;");
  assert.equal(summary(queue).completedBytes, 20);
  queue.db.close();
  const recovered = new Queue(file, async () => {});
  try {
    assert.equal(summary(recovered).pending, 2);
    assert.equal(summary(recovered).transferring, 0);
    recovered.retry(id);
    assert.equal(summary(recovered).pending, 4);
    await recovered.cancel(id);
    assert.equal(summary(recovered).cancelled, 4);
    assert.equal(summary(recovered).completedBytes, 20);
    recovered.retry(id);
    await recovered.start(id, {});
    await recovered.running.finished;
    assert.equal(summary(recovered).done, 5);
    assert.equal(summary(recovered).completedBytes, 60);
    await assert.rejects(recovered.cancel(id), /Completed/);
    assert.equal(recovered.list()[0].state, "complete");
    recovered.remove(id);
    assert.equal(
      recovered.db.prepare("SELECT COUNT(*) AS n FROM queue_summaries").get().n,
      0,
    );
  } finally {
    recovered.db.close();
  }
});

test("polling summaries reads jobs and summaries without querying entries", async (t) => {
  const { queue, create } = await fixture(t);
  create(20);
  const prepare = queue.db.prepare.bind(queue.db);
  const queries = [];
  queue.db.prepare = (sql) => {
    queries.push(sql);
    return prepare(sql);
  };
  for (let i = 0; i < 10; i++) assert.equal(queue.list()[0].total, 20);
  assert.ok(queries.length);
  assert.ok(queries.every((sql) => !/\bentries\b/i.test(sql)));
});

test("worker failure while recording an entry error settles and preserves both errors", async (t) => {
  const { queue, create } = await fixture(t, async () => {
    throw Error("remote unavailable");
  });
  const id = create(2);
  queue.db.exec(
    "CREATE TRIGGER reject_entry_failure BEFORE UPDATE OF state ON entries WHEN new.state='failed' BEGIN SELECT RAISE(FAIL,'disk failure recording entry'); END;",
  );
  await queue.start(id, {});
  const finished = queue.running.finished;
  await assert.rejects(
    finished,
    /remote unavailable.*disk failure recording entry/,
  );
  assert.equal(queue.running, null);
  assert.equal(queue.progress.size, 0);
  assert.match(
    queue.list()[0].error,
    /remote unavailable.*disk failure recording entry/,
  );
  assert.equal(queue.list()[0].pending, 1);
});

test("failed job finalization and failed error recording still release workspace activity", async (t) => {
  const { queue, create } = await fixture(t);
  const id = create();
  queue.db.exec(
    "CREATE TRIGGER reject_job_finish BEFORE UPDATE OF state ON jobs WHEN new.state IN ('complete','failed') BEGIN SELECT RAISE(FAIL,'database cannot record completion'); END;",
  );
  const activity = [];
  const workspace = new Workspace(
    queue,
    () => ({}),
    (active) => activity.push(active),
  );
  await workspace.start(id);
  const finishing = workspace.finishing;
  await finishing;
  assert.equal(queue.running, null);
  assert.equal(workspace.activeRun, null);
  assert.equal(workspace.finishing, null);
  assert.deepEqual(activity, [true, false]);
  assert.equal(queue.list()[0].state, "failed");
  assert.match(
    queue.list()[0].error,
    /database cannot record completion.*Could not save batch error/,
  );
  assert.match(
    queue.failureReport(id)[0].error,
    /database cannot record completion.*Could not save batch error/,
  );
  await workspace.close();
});

test("startup statement failures never leave a phantom active batch", async (t) => {
  const { queue, create } = await fixture(t);
  const id = create();
  queue.db.exec(
    "CREATE TRIGGER reject_job_start BEFORE UPDATE OF state ON jobs WHEN new.state='running' BEGIN SELECT RAISE(FAIL,'read only database'); END;",
  );
  const activity = [];
  const workspace = new Workspace(
    queue,
    () => ({}),
    (active) => activity.push(active),
  );
  await assert.rejects(workspace.start(id), /read only database/);
  assert.equal(queue.running, null);
  assert.equal(workspace.activeRun, null);
  assert.deepEqual(activity, [true, false]);
  queue.db.exec("DROP TRIGGER reject_job_start");
  await workspace.start(id);
  await workspace.finishing;
  assert.equal(workspace.list()[0].state, "complete");
  await assert.rejects(workspace.cancel(id), /Completed/);
});

test("shutdown closes database after a rejected pause and prevents new starts", async (t) => {
  const { queue, create } = await fixture(t);
  const id = create();
  queue.pause = async () => {
    throw Error("pause could not save state");
  };
  await assert.rejects(queue.shutdown(), /pause could not save state/);
  assert.throws(() => queue.db.prepare("SELECT 1"), /not open|closed/i);
  await assert.rejects(queue.start(id, {}), /closing/);
});

test("corrupt database startup preserves the original database bytes", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "queue-corrupt-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "transfers.sqlite");
  const bytes = Buffer.from("existing database with damaged header");
  await fs.writeFile(file, bytes);
  assert.throws(
    () => new Queue(file, async () => {}),
    /Could not open transfer database.*Existing files were preserved/,
  );
  assert.deepEqual(await fs.readFile(file), bytes);
});

test("fatal worker selection failures are observed and keep unprocessed rows recoverable", async (t) => {
  let queue;
  let injected = false;
  const f = await fixture(t, async () => {
    if (injected) return;
    injected = true;
    queue.db.exec(
      "CREATE TRIGGER reject_active BEFORE UPDATE OF state ON entries WHEN new.state='downloading' BEGIN SELECT RAISE(FAIL,'unable to reserve next entry'); END;",
    );
  });
  queue = f.queue;
  const id = f.create(3);
  await queue.start(id, {});
  await assert.rejects(queue.running.finished, /unable to reserve next entry/);
  await tick();
  assert.equal(queue.running, null);
  assert.equal(queue.progress.size, 0);
  assert.equal(summary(queue).done, 1);
  assert.equal(summary(queue).pending, 2);
  queue.db.exec("DROP TRIGGER reject_active");
  queue.retry(id);
  assert.equal(queue.list()[0].runtimeFailure, 0);
  assert.equal(queue.list()[0].error, null);
  await queue.start(id, {});
  await queue.running.finished;
  assert.equal(queue.list()[0].state, "complete");
  assert.equal(summary(queue).done, 3);
});

test("cleanup and failed cleanup-error recording preserve the primary error and release activity", async (t) => {
  const { queue, create } = await fixture(t);
  const id = create(0);
  const activity = [];
  const workspace = new Workspace(
    queue,
    () => ({}),
    (active) => activity.push(active),
  );
  queue.db
    .prepare("INSERT INTO sync_runs(job,plan,state) VALUES(?,?,'pending')")
    .run(id, "invalid JSON plan");
  queue.db.exec(
    "CREATE TRIGGER reject_cleanup_error BEFORE UPDATE ON sync_runs WHEN new.state='failed' BEGIN SELECT RAISE(FAIL,'cannot save cleanup error'); END;",
  );
  await workspace.start(id);
  await workspace.finishing;
  assert.equal(workspace.activeRun, null);
  assert.equal(workspace.finishing, null);
  assert.deepEqual(activity, [true, false]);
  assert.match(
    queue.list()[0].error,
    /Sync cleanup:.*JSON.*Could not save cleanup failure: cannot save cleanup error/,
  );
  assert.equal(workspace.list()[0].state, "failed");
  assert.equal(workspace.list()[0].cleanupState, "failed");
  queue.db.exec("DROP TRIGGER reject_cleanup_error");
  queue.db.prepare("UPDATE sync_runs SET plan=? WHERE job=?").run("{}", id);
  workspace.retry(id);
  assert.equal(workspace.list()[0].state, "paused");
  assert.equal(workspace.list()[0].cleanupState, "pending");
});

test("runtime retry survives restart and preserves completed entries and integrity evidence", async (t) => {
  const { queue, file, create } = await fixture(t);
  const id = create(3);
  queue.db.exec(
    "UPDATE entries SET state='done' WHERE key='0'; UPDATE entries SET state='downloading',integrityPending=1,integrityRevision='*' WHERE key='1'",
  );
  queue.recordError(id, new Error("disk was temporarily full"));
  queue.db.close();
  const recovered = new Queue(file, async () => {});
  try {
    assert.equal(recovered.list()[0].runtimeFailure, 1);
    recovered.retry(id);
    assert.equal(recovered.list()[0].runtimeFailure, 0);
    assert.equal(recovered.list()[0].done, 1);
    const evidence = recovered.db
      .prepare(
        "SELECT integrityPending,integrityRevision FROM entries WHERE key='1'",
      )
      .get();
    assert.equal(evidence.integrityPending, 1);
    assert.equal(evidence.integrityRevision, "*");
    await recovered.start(id, {});
    await recovered.running.finished;
    assert.equal(recovered.list()[0].done, 3);
  } finally {
    recovered.db.close();
  }
});

test("runtime recovery does not make interrupted scans retryable", async (t) => {
  const { queue, create } = await fixture(t);
  const id = create();
  queue.db
    .prepare(
      "UPDATE jobs SET state='failed',error='Folder scan was interrupted',runtimeFailure=0 WHERE id=?",
    )
    .run(id);
  assert.throws(() => queue.retry(id), /cannot be retried/);
  assert.match(queue.list()[0].error, /scan was interrupted/);
});

test("activity-release failures retain the original runtime failure in status and export", async (t) => {
  const { queue, create } = await fixture(t);
  const id = create();
  queue.db.exec(
    "CREATE TRIGGER reject_complete BEFORE UPDATE OF state ON jobs WHEN new.state='complete' BEGIN SELECT RAISE(FAIL,'original finalization failure'); END;",
  );
  const workspace = new Workspace(
    queue,
    () => ({}),
    (active) => {
      if (!active) throw new Error("activity release failed");
    },
  );
  await workspace.start(id);
  await workspace.finishing;
  assert.equal(workspace.activeRun, null);
  const expected =
    /original finalization failure.*Additional runtime failure: activity release failed/;
  assert.match(workspace.list()[0].error, expected);
  assert.match(queue.failureReport(id)[0].error, expected);
  assert.match(
    queue.db.prepare("SELECT error FROM jobs WHERE id=?").get(id).error,
    expected,
  );
});

test("completed sync cancellation leaves the completed cleanup record intact", async (t) => {
  const { queue, create } = await fixture(t);
  const id = create(0);
  const workspace = new Workspace(queue, () => ({}));
  queue.db
    .prepare("INSERT INTO sync_runs(job,plan,state) VALUES(?,?,'done')")
    .run(id, "{}");
  await workspace.start(id);
  await workspace.finishing;
  await assert.rejects(workspace.cancel(id), /Completed/);
  assert.equal(workspace.list()[0].state, "complete");
  assert.equal(
    queue.db.prepare("SELECT state FROM sync_runs WHERE job=?").get(id).state,
    "done",
  );
});
