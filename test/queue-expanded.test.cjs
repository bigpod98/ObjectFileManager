const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { Queue, RateLimiter } = require("../src/queue.cjs");

async function fixture(t, transfer = async () => {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "s3browser-queue-"));
  const file = path.join(root, "queue.sqlite");
  const q = new Queue(file, transfer);
  t.after(async () => {
    await q.pause();
    try {
      q.db.close();
    } catch {}
    await fs.rm(root, { recursive: true, force: true });
  });
  const create = (entries, options = {}) =>
    q.createJob({
      profile: "p",
      bucket: "bucket",
      kind: "download",
      entries: entries.map((entry) => ({
        source: path.join(root, entry.key),
        root,
        size: 100,
        ...entry,
      })),
      ...options,
    });
  return { q, root, file, create };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("legacy database migrates without losing completed work and recovers both transfer kinds", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "s3browser-migration-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "queue.sqlite");
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE jobs(id TEXT PRIMARY KEY,profile TEXT,bucket TEXT,prefix TEXT,state TEXT,created TEXT,concurrency INTEGER,overwrite INTEGER,warnings INTEGER DEFAULT 0,error TEXT);
  CREATE TABLE entries(id INTEGER PRIMARY KEY,job TEXT,source TEXT,key TEXT,size INTEGER,mtime REAL,directory INTEGER,state TEXT DEFAULT 'pending',error TEXT,UNIQUE(job,key));
  INSERT INTO jobs VALUES('old','p','bucket','','running','2026',1,0,0,NULL);
  INSERT INTO entries VALUES(1,'old','','a',0,0,1,'done',NULL);
  INSERT INTO entries VALUES(2,'old','','b',0,0,1,'uploading',NULL);`);
  old.close();
  const q = new Queue(file, async () => {});
  assert.equal(q.list()[0].kind, "upload");
  assert.equal(q.list()[0].retries, 2);
  assert.equal(q.list()[0].state, "paused");
  assert.deepEqual(
    q.entries("old", "all").map((entry) => entry.state),
    ["done", "pending"],
  );
  q.db
    .prepare("UPDATE jobs SET kind='download',state='running' WHERE id='old'")
    .run();
  q.db.prepare("UPDATE entries SET state='downloading' WHERE id=2").run();
  q.db.close();
  const recovered = new Queue(file, async () => {});
  assert.equal(recovered.list()[0].state, "paused");
  assert.equal(recovered.entries("old", "all")[1].state, "pending");
  recovered.db.close();
});

test("download metadata survives restart and destinations do not require existing files", async (t) => {
  const { q, root, file, create } = await fixture(t);
  const id = create([{ key: "nested/object", etag: '"version"' }], {
    bandwidth: 1024,
    retries: 1,
  });
  q.db.close();
  let transferred;
  const recovered = new Queue(file, async (_, job, entry, signal, progress) => {
    transferred = { job, entry };
    progress(100);
  });
  await recovered.start(id, {});
  await recovered.running.finished;
  assert.equal(transferred.entry.root, root);
  assert.equal(transferred.entry.etag, '"version"');
  assert.equal(transferred.job.kind, "download");
  assert.equal(typeof transferred.job.throttle, "function");
  assert.equal(recovered.list()[0].done, 1);
  recovered.db.close();
});

test("generic batches are atomic, validate settings, and support deletion-only empty sync jobs", async (t) => {
  const { q, create } = await fixture(t);
  assert.throws(() => create([{ key: "a" }, { key: "a" }]), /UNIQUE/);
  assert.equal(q.list().length, 0);
  assert.throws(() => create([{ key: "a" }], { retries: -1 }), /retries/);
  const id = create([]);
  await q.start(id, {});
  await q.running.finished;
  assert.equal(q.list()[0].state, "complete");
  assert.equal(q.list()[0].eta, 0);
});

test("automatic retry count is durable and failure export is not paginated", async (t) => {
  let calls = 0;
  const { q, create } = await fixture(t, async () => {
    calls++;
    throw new Error("offline");
  });
  const id = create([{ key: "a" }], { retries: 1 });
  await q.start(id, {});
  await q.running.finished;
  assert.equal(calls, 2);
  assert.deepEqual(
    q
      .failureReport(id)
      .map(({ key, error, attempts }) => ({ key, error, attempts })),
    [{ key: "a", error: "offline", attempts: 2 }],
  );
  q.configure(id, { retries: 0 });
  q.retry(id);
  await q.start(id, {});
  await q.running.finished;
  assert.equal(calls, 3);
  const many = create(
    Array.from({ length: 125 }, (_, index) => ({ key: String(index) })),
    { retries: 0 },
  );
  await q.start(many, {});
  await q.running.finished;
  assert.equal(q.entries(many).length, 100);
  assert.equal(q.failureReport(many).length, 125);
});

test("cancel aborts throttle waits, persists terminal cancellation, and retry preserves done entries", async (t) => {
  const seen = [];
  const { q, create } = await fixture(t, async (_, job, entry, signal) => {
    seen.push(entry.key);
    if (entry.key !== "a") await job.throttle(100000, signal);
  });
  const id = create([{ key: "a" }, { key: "b" }, { key: "c" }], {
    concurrency: 1,
    bandwidth: 1,
  });
  await q.start(id, {});
  await tick();
  await q.cancel(id);
  assert.equal(q.list()[0].state, "cancelled");
  assert.deepEqual(
    q.entries(id, "all").map((entry) => entry.state),
    ["done", "cancelled", "cancelled"],
  );
  await assert.rejects(q.start(id, {}), /not ready/);
  q.configure(id, { bandwidth: 0 });
  q.retry(id);
  await q.start(id, {});
  await q.running.finished;
  assert.equal(q.list()[0].done, 3);
  assert.equal(seen.filter((key) => key === "a").length, 1);
});

test("shared bandwidth budget limits combined workers and responds to abort and live configuration", async () => {
  const limiter = new RateLimiter(1000);
  const start = performance.now();
  await Promise.all([limiter.throttle(100), limiter.throttle(100)]);
  assert.ok(
    performance.now() - start >= 180,
    "two callers must share the same 1000 byte/s budget",
  );
  const controller = new AbortController();
  const wait = limiter.throttle(100000, controller.signal);
  const rejected = assert.rejects(wait, { name: "AbortError" });
  controller.abort();
  await rejected;
  const unblocked = limiter.throttle(100000);
  limiter.configure(0);
  await unblocked;
  assert.equal(limiter.pending.length, 0);
});

test("live settings reduce worker concurrency and speed/ETA reflect progress", async (t) => {
  let active = 0,
    peakAfter = 0,
    reduced = false;
  const releases = [];
  const { q, create } = await fixture(
    t,
    async (_, job, entry, signal, progress) => {
      active++;
      if (reduced) peakAfter = Math.max(peakAfter, active);
      progress(50);
      await new Promise((resolve) => releases.push(resolve));
      active--;
    },
  );
  const id = create(
    Array.from({ length: 8 }, (_, i) => ({ key: String(i) })),
    { concurrency: 4 },
  );
  await q.start(id, {});
  await tick();
  const running = q.list()[0];
  assert.equal(running.active.length, 4);
  assert.ok(running.speed > 0);
  assert.ok(running.eta > 0);
  q.configure(id, { concurrency: 1 });
  releases.splice(0).forEach((release) => release());
  await tick();
  reduced = true;
  while (q.running) {
    releases.splice(0).forEach((release) => release());
    await tick();
  }
  assert.ok(peakAfter <= 1);
  assert.equal(q.list()[0].done, 8);
  assert.equal(q.list()[0].speed, 0);
});

test("sync upload roots reject replaced symlink ancestors before reading any source", async (t) => {
  let calls = 0;
  const { q, root } = await fixture(t, async () => {
    calls++;
  });
  const sourceRoot = path.join(root, "source");
  await fs.mkdir(path.join(sourceRoot, "nested"), { recursive: true });
  const source = path.join(sourceRoot, "nested", "file");
  await fs.writeFile(source, "data");
  const stat = await fs.stat(source);
  const id = q.createJob({
    profile: "p",
    bucket: "bucket",
    entries: [
      {
        source,
        root: sourceRoot,
        key: "nested/file",
        size: stat.size,
        mtime: stat.mtimeMs,
      },
    ],
  });
  await fs.rename(
    path.join(sourceRoot, "nested"),
    path.join(root, "elsewhere"),
  );
  await fs.symlink(
    path.join(root, "elsewhere"),
    path.join(sourceRoot, "nested"),
  );
  await q.start(id, {});
  await q.running.finished;
  assert.equal(calls, 0);
  assert.match(q.failureReport(id)[0].error, /symbolic link/);
});

test("retry revalidates local source after a failed transfer", async (t) => {
  let calls = 0;
  const { q, root } = await fixture(t, async (_, job, entry) => {
    calls++;
    await fs.writeFile(entry.source, "changed contents");
    throw new Error("network failure");
  });
  const source = path.join(root, "source");
  await fs.writeFile(source, "data");
  const stat = await fs.stat(source);
  const id = q.createJob({
    profile: "p",
    bucket: "bucket",
    entries: [{ source, key: "file", size: stat.size, mtime: stat.mtimeMs }],
  });
  await q.start(id, {});
  await q.running.finished;
  assert.equal(calls, 1);
  assert.match(q.failureReport(id)[0].error, /Source changed/);
});

test("sync conditional upload metadata survives database reopening", async (t) => {
  const { q, root, file } = await fixture(t);
  const source = path.join(root, "source");
  await fs.writeFile(source, "data");
  const stat = await fs.stat(source);
  const id = q.createJob({
    profile: "p",
    bucket: "bucket",
    entries: [
      {
        source,
        root,
        key: "new",
        size: stat.size,
        mtime: stat.mtimeMs,
        expectedAbsent: true,
      },
      {
        source,
        root,
        key: "changed",
        size: stat.size,
        mtime: stat.mtimeMs,
        etag: '"previous"',
      },
    ],
  });
  q.db.close();
  const seen = [];
  const recovered = new Queue(file, async (_, job, entry) => {
    seen.push(entry);
  });
  await recovered.start(id, {});
  await recovered.running.finished;
  assert.equal(seen.find((entry) => entry.key === "new").expectedAbsent, 1);
  assert.equal(
    seen.find((entry) => entry.key === "changed").etag,
    '"previous"',
  );
  recovered.db.close();
});
