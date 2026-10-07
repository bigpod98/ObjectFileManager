const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Queue } = require("../src/queue.cjs");
async function fixture(t, transfer = async () => {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "s3browser-"));
  const db = path.join(root, "queue.sqlite");
  const q = new Queue(db, transfer);
  t.after(async () => {
    await q.pause();
    try {
      q.db.close();
    } catch {}
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, db, q };
}
const scan = (q, sources, extra = {}) =>
  q.scan({ sources, profile: "profile", bucket: "bucket", ...extra });
test("preserves Unicode, hidden files, nested and empty directories; skips symlinks", async (t) => {
  const { root, q } = await fixture(t);
  const source = path.join(root, "Photos");
  await fs.mkdir(path.join(source, "empty"), { recursive: true });
  await fs.mkdir(path.join(source, "日本語"));
  await fs.writeFile(path.join(source, "日本語", "a b.txt"), "hello");
  await fs.writeFile(path.join(source, ".hidden"), "hidden");
  await fs.symlink(source, path.join(source, "loop"));
  const id = await scan(q, [source], { prefix: "backup" });
  assert.deepEqual(
    q
      .entries(id, "all")
      .map((e) => e.key)
      .sort(),
    [
      "backup/Photos/",
      "backup/Photos/.hidden",
      "backup/Photos/empty/",
      "backup/Photos/日本語/",
      "backup/Photos/日本語/a b.txt",
    ].sort(),
  );
  assert.equal(q.list()[0].warnings, 1);
  assert.equal(q.list()[0].bytes, 11);
});
test("pause aborts active files, resumes pending only, and retry handles failures", async (t) => {
  let active = 0,
    maxActive = 0,
    fail = true,
    pausing = true,
    waiting = 0;
  const pausedTransfers = Promise.withResolvers();
  const completed = [];
  const { root, q } = await fixture(t, async (_, job, entry, signal) => {
    signal.throwIfAborted();
    active++;
    maxActive = Math.max(maxActive, active);
    try {
      if (pausing && Number(entry.key) >= 2) {
        await new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
          if (++waiting === 2) pausedTransfers.resolve();
        });
      }
      if (entry.key === "3" && fail) throw new Error("Temporary failure");
      completed.push(entry.key);
    } finally {
      active--;
    }
  });
  const sources = [];
  for (let i = 0; i < 12; i++) {
    const f = path.join(root, String(i));
    await fs.writeFile(f, "x");
    sources.push(f);
  }
  const id = await scan(q, sources, { concurrency: 2 });
  await q.start(id, {});
  await pausedTransfers.promise;
  await q.pause();
  assert.equal(q.list()[0].state, "paused");
  assert.equal(active, 0);
  assert.equal(q.list()[0].done, 2);
  assert.deepEqual(completed.slice().sort(), ["0", "1"]);
  pausing = false;
  await q.start(id, {});
  await q.running.finished;
  assert.equal(maxActive, 2);
  assert.equal(q.list()[0].failed, 1);
  fail = false;
  q.retry(id);
  await q.start(id, {});
  await q.running.finished;
  assert.equal(q.list()[0].done, 12);
  assert.equal(new Set(completed).size, 12);
  assert.equal(completed.length, 12);
});
test("restart recovers interrupted entries without redoing completed files", async (t) => {
  const { root, q, db } = await fixture(t);
  const f = path.join(root, "file");
  await fs.writeFile(f, "x");
  const id = await scan(q, [f]);
  q.db.prepare("UPDATE entries SET state='uploading' WHERE job=?").run(id);
  q.db.prepare("UPDATE jobs SET state='running' WHERE id=?").run(id);
  q.db.close();
  const restored = new Queue(db, async () => {});
  assert.equal(restored.list()[0].state, "paused");
  assert.equal(restored.entries(id, "all")[0].state, "pending");
  restored.db.close();
});
test("changed source fails before network transfer", async (t) => {
  let transfers = 0;
  const { root, q } = await fixture(t, async () => {
    transfers++;
  });
  const f = path.join(root, "file");
  await fs.writeFile(f, "old");
  const id = await scan(q, [f]);
  await fs.writeFile(f, "changed");
  await q.start(id, {});
  await q.running.finished;
  assert.equal(transfers, 0);
  assert.match(q.entries(id)[0].error, /Source changed/);
});
test("duplicate destination keys fail scan and cannot start partial batch", async (t) => {
  const { root, q } = await fixture(t);
  const f = path.join(root, "file");
  await fs.writeFile(f, "x");
  await assert.rejects(scan(q, [f, f]), /UNIQUE/);
  assert.equal(q.list()[0].state, "failed");
  await assert.rejects(q.start(q.list()[0].id, {}), /not ready/);
});
test("50,000-entry durable queue processes with bounded concurrency and paged details", async (t) => {
  let peak = 0,
    active = 0;
  const { q, root } = await fixture(t, async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setImmediate(r));
    active--;
  });
  q.db
    .prepare(
      "INSERT INTO jobs(id,profile,bucket,prefix,state,created,concurrency,overwrite) VALUES(?,?,?,?,?,?,?,?)",
    )
    .run("large", "p", "bucket", "", "paused", new Date().toISOString(), 8, 0);
  const insert = q.db.prepare(
    "INSERT INTO entries(job,source,key,size,mtime,directory) VALUES(?,?,?,?,?,?)",
  );
  const stat = await fs.lstat(root);
  q.db.exec("BEGIN");
  for (let i = 0; i < 50000; i++)
    insert.run("large", root, `tree/${i}/`, 0, stat.mtimeMs, 1);
  q.db.exec("COMMIT");
  assert.equal(q.list()[0].total, 50000);
  assert.equal(q.entries("large", "all", 49900).length, 100);
  await q.start("large", {});
  await q.running.finished;
  assert.equal(q.list()[0].done, 50000);
  assert.ok(peak > 0 && peak <= 8);
  assert.equal(q.list()[0].state, "complete");
});
