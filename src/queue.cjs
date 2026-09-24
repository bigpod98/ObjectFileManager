const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const { createReadStream } = require("node:fs");

function abortError() {
  return Object.assign(new Error("Transfer aborted."), { name: "AbortError" });
}
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const abort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
// A single FIFO budget is shared by all transfers in the running batch. Charging
// before each chunk prevents concurrency from multiplying the configured limit.
class RateLimiter {
  constructor(rate) {
    this.rate = rate;
    this.pending = [];
    this.last = performance.now();
    this.timer = null;
  }
  account() {
    const now = performance.now();
    let budget = ((now - this.last) * this.rate) / 1000;
    this.last = now;
    while (this.pending.length) {
      const item = this.pending[0];
      if (this.rate && item.remaining > budget) {
        item.remaining -= budget;
        break;
      }
      budget -= item.remaining;
      this.pending.shift();
      item.signal?.removeEventListener("abort", item.abort);
      item.resolve();
    }
  }
  schedule() {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.pending.length) {
      this.timer = setTimeout(
        () => {
          this.account();
          this.schedule();
        },
        Math.max(
          1,
          Math.min(100, (this.pending[0].remaining * 1000) / this.rate),
        ),
      );
    }
  }
  configure(rate) {
    this.account();
    this.rate = rate;
    this.account();
    this.schedule();
  }
  throttle(bytes, signal) {
    if (signal?.aborted) return Promise.reject(abortError());
    if (!Number.isFinite(bytes) || bytes < 0)
      return Promise.reject(new Error("Invalid transfer byte count."));
    this.account();
    if (!this.rate || !bytes) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const item = { remaining: bytes, signal, resolve, reject };
      item.abort = () => {
        const index = this.pending.indexOf(item);
        if (index !== -1) this.pending.splice(index, 1);
        reject(abortError());
        this.account();
        this.schedule();
      };
      signal?.addEventListener("abort", item.abort, { once: true });
      this.pending.push(item);
      this.schedule();
    });
  }
}
function settings(
  options = {},
  defaults = { concurrency: 6, retries: 2, bandwidth: 0 },
) {
  const result = { ...defaults };
  for (const [name, max] of [
    ["concurrency", 16],
    ["retries", 10],
    ["bandwidth", Number.MAX_SAFE_INTEGER],
  ]) {
    if (options[name] === undefined) continue;
    const value = Number(options[name]);
    if (
      !Number.isFinite(value) ||
      value < (name === "concurrency" ? 1 : 0) ||
      value > max ||
      !Number.isInteger(value)
    ) {
      throw new Error(`Invalid ${name} setting.`);
    }
    result[name] = value;
  }
  return result;
}

class Queue {
  constructor(file, transfer) {
    this.db = new DatabaseSync(file);
    this.transfer = transfer;
    this.running = null;
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, profile TEXT, bucket TEXT, prefix TEXT, state TEXT, created TEXT, concurrency INTEGER, overwrite INTEGER, warnings INTEGER DEFAULT 0, error TEXT);
      CREATE TABLE IF NOT EXISTS entries(id INTEGER PRIMARY KEY, job TEXT, source TEXT, key TEXT, size INTEGER, mtime REAL, directory INTEGER, state TEXT DEFAULT 'pending', error TEXT, UNIQUE(job,key));
      CREATE INDEX IF NOT EXISTS entries_job_state ON entries(job,state,id);`);
    const migrate = (table, columns) => {
      const existing = new Set(
        this.db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .map((column) => column.name),
      );
      for (const [name, type] of Object.entries(columns)) {
        if (!existing.has(name))
          this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
      }
    };
    migrate("jobs", {
      kind: "TEXT NOT NULL DEFAULT 'upload'",
      bandwidth: "INTEGER NOT NULL DEFAULT 0",
      retries: "INTEGER NOT NULL DEFAULT 2",
    });
    migrate("entries", {
      etag: "TEXT",
      root: "TEXT",
      attempts: "INTEGER NOT NULL DEFAULT 0",
      expectedAbsent: "INTEGER NOT NULL DEFAULT 0",
      sha256: "TEXT",
      uploadToken: "TEXT",
    });
    this.db.exec(
      "UPDATE entries SET state='pending' WHERE state IN ('uploading','downloading','transferring'); UPDATE jobs SET state='paused' WHERE state='running'; UPDATE jobs SET state='failed', error='Folder scan was interrupted. Remove this batch and select the source again.' WHERE state='scanning'",
    );
    this.progress = new Map();
  }
  async scan({
    profile,
    bucket,
    prefix = "",
    sources,
    concurrency = 6,
    overwrite = false,
    bandwidth = 0,
    retries = 2,
  }) {
    const options = settings({ concurrency, bandwidth, retries });
    if (!bucket || !sources?.length)
      throw new Error("Choose a bucket and source files.");
    if (prefix && !prefix.endsWith("/")) prefix += "/";
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO jobs(id,profile,bucket,prefix,state,created,concurrency,overwrite) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        profile,
        bucket,
        prefix,
        "scanning",
        new Date().toISOString(),
        Math.min(16, Math.max(1, Number(concurrency) || 6)),
        +overwrite,
      );
    this.configure(id, options);
    const insert = this.db.prepare(
      "INSERT INTO entries(job,source,key,size,mtime,directory) VALUES(?,?,?,?,?,?)",
    );
    let batch = [],
      warnings = 0;
    const flush = () => {
      this.db.exec("BEGIN");
      try {
        for (const row of batch) insert.run(...row);
        this.db.exec("COMMIT");
        batch = [];
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
    };
    const walk = async (source, key) => {
      const stat = await fs.lstat(source);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
        warnings++;
        return;
      }
      if (Buffer.byteLength(key + (stat.isDirectory() ? "/" : "")) > 1024)
        throw new Error(`S3 key exceeds 1,024 bytes: ${key}`);
      batch.push([
        id,
        source,
        key + (stat.isDirectory() ? "/" : ""),
        stat.isDirectory() ? 0 : stat.size,
        stat.mtimeMs,
        +stat.isDirectory(),
      ]);
      if (batch.length >= 250) flush();
      if (stat.isDirectory()) {
        const dir = await fs.opendir(source);
        for await (const entry of dir)
          await walk(path.join(source, entry.name), `${key}/${entry.name}`);
      }
    };
    try {
      for (const source of sources)
        await walk(source, prefix + path.basename(source));
      flush();
      this.db
        .prepare("UPDATE jobs SET state='paused',warnings=? WHERE id=?")
        .run(warnings, id);
      return id;
    } catch (e) {
      this.db
        .prepare("UPDATE jobs SET state='failed',error=? WHERE id=?")
        .run(
          e.message.includes("UNIQUE")
            ? "Selected sources have overlapping destination names. Select them as separate batches or choose a different folder."
            : e.message,
          id,
        );
      throw e;
    }
  }
  createJob({
    profile,
    bucket,
    prefix = "",
    kind = "upload",
    entries,
    overwrite = false,
    ...options
  }) {
    if (
      !bucket ||
      !profile ||
      !["upload", "download"].includes(kind) ||
      !Array.isArray(entries)
    ) {
      throw new Error("Invalid transfer batch.");
    }
    const config = settings(options);
    const id = randomUUID();
    const insert = this.db.prepare(
      "INSERT INTO entries(job,source,key,size,mtime,directory,etag,root,expectedAbsent,sha256,uploadToken) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    );
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          "INSERT INTO jobs(id,profile,bucket,prefix,state,created,concurrency,overwrite,kind,bandwidth,retries) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          id,
          profile,
          bucket,
          prefix,
          "paused",
          new Date().toISOString(),
          config.concurrency,
          +!!overwrite,
          kind,
          config.bandwidth,
          config.retries,
        );
      for (const entry of entries) {
        if (
          typeof entry.key !== "string" ||
          !entry.key ||
          Buffer.byteLength(entry.key) > 1024 ||
          typeof entry.source !== "string" ||
          !Number.isSafeInteger(entry.size) ||
          entry.size < 0 ||
          !Number.isFinite(entry.mtime ?? 0)
        ) {
          throw new Error("Invalid transfer entry.");
        }
        if (
          kind === "download" &&
          (!entry.root ||
            !path.isAbsolute(entry.root) ||
            !path.isAbsolute(entry.source))
        ) {
          throw new Error(
            "Download entries require an absolute destination and root.",
          );
        }
        insert.run(
          id,
          entry.source,
          entry.key,
          entry.size,
          entry.mtime ?? 0,
          +!!entry.directory,
          entry.etag ?? null,
          entry.root ?? null,
          +!!entry.expectedAbsent,
          entry.sha256 ?? null,
          kind === "upload" && (entry.expectedAbsent || entry.etag)
            ? randomUUID()
            : null,
        );
      }
      this.db.exec("COMMIT");
      return id;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  configure(id, options) {
    const job = this.db.prepare("SELECT * FROM jobs WHERE id=?").get(id);
    if (!job) throw new Error("Transfer batch not found.");
    const config = settings(options, {
      concurrency: job.concurrency,
      retries: job.retries,
      bandwidth: job.bandwidth,
    });
    this.db
      .prepare("UPDATE jobs SET concurrency=?,bandwidth=?,retries=? WHERE id=?")
      .run(config.concurrency, config.bandwidth, config.retries, id);
    if (this.running?.id === id) {
      Object.assign(this.running.job, config);
      this.running.limiter.configure(config.bandwidth);
      this.running.launch();
    }
    return config;
  }
  list() {
    return this.db
      .prepare(
        `SELECT j.*, COUNT(e.id) AS total,
      COALESCE(SUM(e.size),0) AS bytes,
      COALESCE(SUM(e.state='done'),0) AS done,
      COALESCE(SUM(e.state='skipped'),0) AS skipped,
      COALESCE(SUM(e.state='failed'),0) AS failed,
      COALESCE(SUM(CASE WHEN e.state IN ('done','skipped') THEN e.size ELSE 0 END),0) AS completedBytes
      FROM jobs j LEFT JOIN entries e ON e.job=j.id GROUP BY j.id ORDER BY j.created DESC`,
      )
      .all()
      .map((j) => {
        const active = [...this.progress.values()].filter(
          (p) => p.job === j.id,
        );
        const run = this.running?.id === j.id ? this.running : null;
        const now = performance.now();
        if (run)
          run.samples = run.samples.filter(
            (sample) => now - sample.time < 5000,
          );
        const speed = run
          ? run.samples.reduce((sum, sample) => sum + sample.bytes, 0) /
            Math.max(0.001, Math.min(5, (now - run.started) / 1000))
          : 0;
        const remaining = Math.max(
          0,
          j.bytes -
            j.completedBytes -
            active.reduce((sum, entry) => sum + entry.loaded, 0),
        );
        return {
          ...j,
          active,
          speed,
          eta: remaining === 0 ? 0 : speed > 0 ? remaining / speed : null,
        };
      });
  }
  entries(job, filter = "failed", offset = 0) {
    return this.db
      .prepare(
        "SELECT key,size,state,error FROM entries WHERE job=? AND (?='all' OR state=?) ORDER BY id LIMIT 100 OFFSET ?",
      )
      .all(job, filter, filter, Math.max(0, Number(offset) || 0));
  }
  async start(id, context) {
    if (this.running)
      throw new Error("Pause the current batch before starting another.");
    const job = this.db.prepare("SELECT * FROM jobs WHERE id=?").get(id);
    if (
      !job ||
      job.state === "scanning" ||
      job.state === "cancelled" ||
      job.error
    )
      throw new Error("This batch is not ready to transfer.");
    this.db.prepare("UPDATE jobs SET state='running' WHERE id=?").run(id);
    const limiter = new RateLimiter(job.bandwidth);
    job.throttle = (bytes, signal) => limiter.throttle(bytes, signal);
    const run = {
      id,
      job,
      limiter,
      paused: false,
      cancelled: false,
      workers: new Set(),
      controllers: new Set(),
      started: performance.now(),
      samples: [],
    };
    this.running = run;
    const next = this.db.prepare(
      "SELECT * FROM entries WHERE job=? AND state='pending' ORDER BY id LIMIT 1",
    );
    const setState = this.db.prepare(
      "UPDATE entries SET state=?,error=? WHERE id=?",
    );
    const attempt = this.db.prepare(
      "UPDATE entries SET attempts=attempts+1 WHERE id=?",
    );
    const worker = async () => {
      while (!run.paused && !run.cancelled) {
        if (run.workers.size > job.concurrency) break;
        const entry = next.get(id);
        if (!entry) break;
        setState.run(
          job.kind === "download" ? "downloading" : "uploading",
          null,
          entry.id,
        );
        const controller = new AbortController();
        run.controllers.add(controller);
        this.progress.set(entry.id, {
          job: id,
          key: entry.key,
          loaded: 0,
          size: entry.size,
        });
        try {
          let result;
          for (let retry = 0; ; retry++) {
            controller.signal.throwIfAborted();
            if (job.kind === "upload") {
              if (entry.root) {
                const relative = path.relative(entry.root, entry.source);
                if (
                  !path.isAbsolute(entry.root) ||
                  !path.isAbsolute(entry.source) ||
                  relative === ".." ||
                  relative.startsWith(`..${path.sep}`) ||
                  path.isAbsolute(relative)
                ) {
                  throw new Error(
                    "Source is outside its original folder. Create a new batch.",
                  );
                }
                for (
                  let parent = path.dirname(entry.source);
                  ;
                  parent = path.dirname(parent)
                ) {
                  const stat = await fs.lstat(parent);
                  if (!stat.isDirectory() || stat.isSymbolicLink())
                    throw new Error(
                      "Source parent changed or became a symbolic link. Create a new batch.",
                    );
                  if (parent === path.dirname(parent)) break;
                }
              }
              if (!entry.directory || entry.root) {
                const stat = await fs.lstat(entry.source);
                if (
                  entry.directory
                    ? !stat.isDirectory()
                    : !stat.isFile() ||
                      stat.size !== entry.size ||
                      stat.mtimeMs !== entry.mtime
                ) {
                  throw new Error(
                    "Source changed since scanning. Create a new batch for this file.",
                  );
                }
              }
            }
            if (
              job.kind === "upload" &&
              (entry.expectedAbsent || entry.etag) &&
              (!entry.sha256 || !entry.uploadToken)
            ) {
              // Older batches have no upload identity. Establish evidence before
              // this attempt; never infer that an older untagged write succeeded.
              if (!entry.sha256) {
                const hash = createHash("sha256");
                if (!entry.directory) {
                  for await (const chunk of createReadStream(entry.source, {
                    signal: controller.signal,
                  }))
                    hash.update(chunk);
                }
                entry.sha256 = hash.digest("base64");
              }
              entry.uploadToken ||= randomUUID();
              this.db
                .prepare("UPDATE entries SET sha256=?,uploadToken=? WHERE id=?")
                .run(entry.sha256, entry.uploadToken, entry.id);
            }
            attempt.run(entry.id);
            entry.attempts++;
            let previous = 0;
            this.progress.get(entry.id).loaded = 0;
            try {
              result = await this.transfer(
                context,
                job,
                entry,
                controller.signal,
                (loaded) => {
                  if (controller.signal.aborted) return;
                  loaded = Math.min(
                    entry.size,
                    Math.max(0, Number(loaded) || 0),
                  );
                  const bytes = Math.max(0, loaded - previous);
                  previous = loaded;
                  const now = performance.now();
                  const last = run.samples.at(-1);
                  if (last && now - last.time < 250) last.bytes += bytes;
                  else {
                    run.samples = run.samples.filter(
                      (sample) => now - sample.time < 5000,
                    );
                    run.samples.push({ time: now, bytes });
                  }
                  this.progress.set(entry.id, {
                    job: id,
                    key: entry.key,
                    loaded,
                    size: entry.size,
                  });
                },
              );
              break;
            } catch (error) {
              if (controller.signal.aborted || retry >= job.retries)
                throw error;
              await delay(Math.min(2000, 100 * 2 ** retry), controller.signal);
            }
          }
          controller.signal.throwIfAborted();
          setState.run(
            result === "skipped" ? "skipped" : "done",
            null,
            entry.id,
          );
        } catch (error) {
          setState.run(
            run.cancelled ? "cancelled" : run.paused ? "pending" : "failed",
            run.cancelled || run.paused ? null : error.message || String(error),
            entry.id,
          );
        } finally {
          run.controllers.delete(controller);
          this.progress.delete(entry.id);
        }
      }
    };
    let finish;
    run.finished = new Promise((resolve) => {
      finish = resolve;
    });
    const settle = () => {
      if (run.workers.size) return;
      const failed = this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM entries WHERE job=? AND state='failed'",
        )
        .get(id).n;
      this.db
        .prepare("UPDATE jobs SET state=? WHERE id=?")
        .run(
          run.cancelled
            ? "cancelled"
            : run.paused
              ? "paused"
              : failed
                ? "failed"
                : "complete",
          id,
        );
      this.running = null;
      finish();
    };
    run.launch = () => {
      while (
        !run.paused &&
        !run.cancelled &&
        run.workers.size < job.concurrency &&
        next.get(id)
      ) {
        // Defer worker execution until it is tracked, including synchronously failing transfers.
        const promise = Promise.resolve().then(worker);
        run.workers.add(promise);
        promise.finally(() => {
          run.workers.delete(promise);
          run.launch();
          settle();
        });
      }
    };
    run.launch();
    // Keep start()'s historical contract: callers can await queue.running.finished.
    if (!run.workers.size) setImmediate(settle);
    return { started: true };
  }
  async pause() {
    const run = this.running;
    if (!run) return;
    run.paused = true;
    for (const controller of run.controllers) controller.abort();
    await run.finished;
  }
  async cancel(id) {
    const job = this.db.prepare("SELECT * FROM jobs WHERE id=?").get(id);
    if (!job) throw new Error("Transfer batch not found.");
    if (job.state === "scanning")
      throw new Error("Wait for the scan to finish.");
    const run = this.running?.id === id ? this.running : null;
    if (run) {
      run.cancelled = true;
      for (const controller of run.controllers) controller.abort();
      await run.finished;
    }
    this.db
      .prepare(
        "UPDATE entries SET state='cancelled',error=NULL WHERE job=? AND state IN ('pending','failed','uploading','downloading','transferring')",
      )
      .run(id);
    this.db.prepare("UPDATE jobs SET state='cancelled' WHERE id=?").run(id);
  }
  retry(id) {
    if (this.running?.id === id) throw new Error("Pause this batch first.");
    const job = this.db.prepare("SELECT * FROM jobs WHERE id=?").get(id);
    if (!job || job.error || job.state === "scanning")
      throw new Error("This batch cannot be retried. Create a new batch.");
    this.db
      .prepare(
        "UPDATE entries SET state='pending',error=NULL WHERE job=? AND state IN ('failed','cancelled')",
      )
      .run(id);
    this.db.prepare("UPDATE jobs SET state='paused' WHERE id=?").run(id);
  }
  failureReport(id) {
    const job = this.db.prepare("SELECT * FROM jobs WHERE id=?").get(id);
    if (!job) throw new Error("Transfer batch not found.");
    const rows = this.db
      .prepare(
        "SELECT source,key,size,state,error,attempts FROM entries WHERE job=? AND state='failed' ORDER BY id",
      )
      .all(id);
    if (job.error) rows.unshift({ state: "failed", error: job.error });
    return rows;
  }
  remove(id) {
    if (this.running?.id === id) throw new Error("Pause this batch first.");
    if (
      this.db.prepare("SELECT state FROM jobs WHERE id=?").get(id)?.state ===
      "scanning"
    )
      throw new Error("Wait for the scan to finish.");
    this.db.prepare("DELETE FROM entries WHERE job=?").run(id);
    this.db.prepare("DELETE FROM jobs WHERE id=?").run(id);
  }
}
module.exports = { Queue, RateLimiter };
