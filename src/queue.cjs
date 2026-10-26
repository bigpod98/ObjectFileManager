const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const { constants } = require("node:fs");

const {
  selectRoot,
  validateParents: validateSourceParents,
} = require("./local-roots.cjs");

async function validateUploadSource(entry) {
  if (!entry.source) throw new Error("Source is missing. Create a new batch.");
  await validateSourceParents(entry.source, entry.root, entry.rootIdentity);
  const stat = await fs.lstat(entry.source);
  if (
    stat.isSymbolicLink() ||
    (entry.directory
      ? !stat.isDirectory()
      : !stat.isFile() ||
        stat.size !== entry.size ||
        (entry.mtime != null && stat.mtimeMs !== entry.mtime))
  )
    throw new Error(
      "Source changed since scanning. Create a new batch for this file.",
    );
  return stat;
}

const sameSource = (a, b) =>
  ["dev", "ino", "size", "mtimeMs", "ctimeMs"].every(
    (key) => a[key] === b[key],
  );

async function openUploadSource(entry) {
  const before = await validateUploadSource(entry);
  const handle = await fs.open(
    entry.source,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const opened = await handle.stat();
    // O_NOFOLLOW guards the final component. Checking again after open also
    // catches ancestor replacements, and all reads use this validated handle.
    const after = await validateUploadSource(entry);
    if (
      !opened.isFile() ||
      !sameSource(before, opened) ||
      !sameSource(opened, after)
    )
      throw new Error(
        "Source changed while opening. Create a new batch for this file.",
      );
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

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
    try {
      this.db = new DatabaseSync(file);
    } catch (error) {
      throw new Error(
        `Could not open transfer database ${file}: ${error.message}. Existing files were preserved.`,
        { cause: error },
      );
    }
    this.transfer = transfer;
    this.running = null;
    this.runtimeErrors = new Map();
    try {
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
        runtimeFailure: "INTEGER NOT NULL DEFAULT 0",
      });
      migrate("entries", {
        etag: "TEXT",
        root: "TEXT",
        attempts: "INTEGER NOT NULL DEFAULT 0",
        expectedAbsent: "INTEGER NOT NULL DEFAULT 0",
        sha256: "TEXT",
        uploadToken: "TEXT",
        integrityPending: "INTEGER NOT NULL DEFAULT 0",
        integrityRevision: "TEXT",
        rootIdentity: "TEXT",
      });
      this.db.exec(
        "UPDATE entries SET state='pending' WHERE state IN ('uploading','downloading','transferring'); UPDATE jobs SET state='paused' WHERE state='running'; UPDATE jobs SET state='failed', error='Folder scan was interrupted. Remove this batch and select the source again.' WHERE state='scanning'",
      );
      this.initializeSummaries();
    } catch (error) {
      try {
        this.db.close();
      } catch {}
      throw new Error(
        `Could not open transfer database ${file}: ${error.message}. Existing files were preserved.`,
        { cause: error },
      );
    }
    this.progress = new Map();
    this.closed = false;
  }
  initializeSummaries() {
    if (
      this.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='queue_summaries'",
        )
        .get()
    )
      return;
    // One initial backfill for existing queues. Thereafter triggers update only
    // the affected job, in the same transaction as every entry mutation.
    const fields = {
      total: "1",
      bytes: "COALESCE(size,0)",
      done: "state='done'",
      skipped: "state='skipped'",
      failed: "state='failed'",
      pending: "state='pending'",
      cancelled: "state='cancelled'",
      transferring: "state IN ('uploading','downloading','transferring')",
      completedBytes:
        "CASE WHEN state IN ('done','skipped') THEN COALESCE(size,0) ELSE 0 END",
    };
    const names = Object.keys(fields);
    const values = (row) =>
      Object.values(fields).map((value) =>
        value.replace(/\b(size|state)\b/g, `${row}.$1`),
      );
    const add = (row) =>
      `INSERT INTO queue_summaries(job,${names.join(",")}) VALUES(${row}.job,${values(row).join(",")}) ON CONFLICT(job) DO UPDATE SET ${names.map((name) => `${name}=${name}+excluded.${name}`).join(",")};`;
    const subtract = `UPDATE queue_summaries SET ${names.map((name, i) => `${name}=${name}-(${values("old")[i]})`).join(",")} WHERE job=old.job;`;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .exec(`CREATE TABLE queue_summaries(job TEXT PRIMARY KEY, ${names.map((name) => `${name} INTEGER NOT NULL DEFAULT 0`).join(",")});
        INSERT INTO queue_summaries SELECT job,${Object.values(fields)
          .map((value) => `COALESCE(SUM(${value}),0)`)
          .join(",")} FROM entries GROUP BY job;
        CREATE TRIGGER queue_summary_insert AFTER INSERT ON entries BEGIN ${add("new")} END;
        CREATE TRIGGER queue_summary_delete AFTER DELETE ON entries BEGIN ${subtract} END;
        CREATE TRIGGER queue_summary_update AFTER UPDATE OF job,size,state ON entries
          WHEN old.job IS NOT new.job OR old.size IS NOT new.size OR old.state IS NOT new.state
          BEGIN ${subtract} ${add("new")} END;
        CREATE TRIGGER queue_summary_remove AFTER DELETE ON jobs BEGIN DELETE FROM queue_summaries WHERE job=old.id; END;`);
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }
  recordError(id, error) {
    const previous = this.runtimeErrors.get(id);
    if (previous === error) return error;
    let message = previous
      ? `${previous.message}; Additional runtime failure: ${error.message || error}`
      : error.message || String(error);
    try {
      this.db
        .prepare(
          "UPDATE jobs SET state='failed',error=?,runtimeFailure=1 WHERE id=?",
        )
        .run(message, id);
    } catch (recordingError) {
      message += ` (Could not save batch error: ${recordingError.message})`;
    }
    const failure = previous
      ? new AggregateError([previous, error], message)
      : new Error(message, { cause: error });
    this.runtimeErrors.set(id, failure);
    return failure;
  }
  async shutdown() {
    this.closed = true;
    let failure;
    try {
      await this.pause();
    } catch (error) {
      failure = error;
    }
    try {
      this.db.close();
    } catch (error) {
      failure = failure
        ? new AggregateError(
            [failure, error],
            `${failure.message}; Could not close transfer database: ${error.message}`,
          )
        : error;
    }
    if (failure) throw failure;
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
      "INSERT INTO entries(job,source,key,size,mtime,directory,root,rootIdentity) VALUES(?,?,?,?,?,?,?,?)",
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
    const walk = async (source, key, root, rootIdentity) => {
      await validateSourceParents(source, root, rootIdentity);
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
        root,
        rootIdentity,
      ]);
      if (batch.length >= 250) flush();
      if (stat.isDirectory()) {
        const dir = await fs.opendir(source);
        for await (const entry of dir)
          await walk(
            path.join(source, entry.name),
            `${key}/${entry.name}`,
            root,
            rootIdentity,
          );
        await validateSourceParents(source, root, rootIdentity);
        const after = await fs.lstat(source);
        if (
          !after.isDirectory() ||
          stat.dev !== after.dev ||
          stat.ino !== after.ino
        )
          throw new Error("Source changed while scanning. Create a new batch.");
      }
    };
    try {
      for (const selected of sources) {
        const original = path.resolve(selected);
        const stat = await fs.lstat(original);
        if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
          warnings++;
          continue;
        }
        const selectedRoot = await selectRoot(
          stat.isDirectory() ? original : path.dirname(original),
          stat.isFile(),
        );
        const source = stat.isDirectory()
          ? selectedRoot.root
          : path.join(selectedRoot.root, path.basename(original));
        await walk(
          source,
          prefix + path.basename(original),
          selectedRoot.root,
          selectedRoot.rootIdentity,
        );
      }
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
      "INSERT INTO entries(job,source,key,size,mtime,directory,etag,root,rootIdentity,expectedAbsent,sha256,uploadToken) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
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
          entry.rootIdentity ?? null,
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
        `SELECT j.*, ${["total", "bytes", "done", "skipped", "failed", "pending", "cancelled", "transferring", "completedBytes"].map((name) => `COALESCE(s.${name},0) AS ${name}`).join(",")}
        FROM jobs j LEFT JOIN queue_summaries s ON s.job=j.id ORDER BY j.created DESC`,
      )
      .all()
      .map((j) => {
        if (this.runtimeErrors.has(j.id)) {
          j.state = "failed";
          j.error = this.runtimeErrors.get(j.id).message;
          j.runtimeFailure = 1;
        }
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
    if (this.closed) throw new Error("The transfer queue is closing.");
    if (this.running)
      throw new Error("Pause the current batch before starting another.");
    const job = this.db.prepare("SELECT * FROM jobs WHERE id=?").get(id);
    if (
      !job ||
      job.state === "scanning" ||
      job.state === "cancelled" ||
      job.error ||
      this.runtimeErrors.has(id)
    )
      throw new Error("This batch is not ready to transfer.");
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
        // Storage calls this before a write whose post-commit verification can
        // fail. Persist first so a crash cannot turn the object into a skip.
        entry.markIntegrityPending = (revision) => {
          this.db
            .prepare(
              "UPDATE entries SET integrityPending=1,integrityRevision=? WHERE id=?",
            )
            .run(revision, entry.id);
          entry.integrityPending = 1;
          entry.integrityRevision = revision;
        };
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
              await validateUploadSource(entry);
            }
            if (
              job.kind === "upload" &&
              (entry.expectedAbsent ||
                entry.etag ||
                context?.provider === "Google Cloud Storage") &&
              (!entry.sha256 || !entry.uploadToken)
            ) {
              // Older batches have no upload identity. Establish evidence before
              // this attempt; never infer that an older untagged write succeeded.
              if (!entry.sha256) {
                const hash = createHash("sha256");
                if (!entry.directory) {
                  const handle = await openUploadSource(entry);
                  try {
                    for await (const chunk of handle.createReadStream({
                      autoClose: false,
                      signal: controller.signal,
                    }))
                      hash.update(chunk);
                  } finally {
                    await handle.close();
                  }
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
          this.db
            .prepare(
              "UPDATE entries SET state=?,error=NULL,integrityPending=0 WHERE id=?",
            )
            .run(result === "skipped" ? "skipped" : "done", entry.id);
        } catch (error) {
          try {
            setState.run(
              run.cancelled ? "cancelled" : run.paused ? "pending" : "failed",
              run.cancelled || run.paused
                ? null
                : error.message || String(error),
              entry.id,
            );
          } catch (recordingError) {
            throw new AggregateError(
              [error, recordingError],
              `${error.message || error}; Could not save transfer failure: ${recordingError.message}`,
            );
          }
        } finally {
          run.controllers.delete(controller);
          this.progress.delete(entry.id);
        }
      }
    };
    let finish, reject;
    run.finished = new Promise((resolve, fail) => {
      finish = resolve;
      reject = fail;
    });
    // Observe failures even when a caller only uses fire-and-forget start().
    run.finished.catch(() => {});
    const fail = (error) => {
      if (!run.error) run.error = this.recordError(id, error);
      run.paused = true;
      for (const controller of run.controllers) controller.abort();
    };
    const settle = () => {
      if (run.workers.size || run.settled) return;
      run.settled = true;
      try {
        if (!run.error) {
          const failed =
            this.db
              .prepare("SELECT failed FROM queue_summaries WHERE job=?")
              .get(id)?.failed || 0;
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
        }
      } catch (error) {
        fail(error);
      } finally {
        if (this.running === run) this.running = null;
        if (run.error) reject(run.error);
        else finish();
      }
    };
    run.launch = () => {
      if (run.settled) return;
      try {
        while (
          !run.paused &&
          !run.cancelled &&
          run.workers.size < job.concurrency &&
          next.get(id)
        ) {
          // Track workers before executing even synchronously failing transfers.
          const promise = Promise.resolve().then(worker);
          run.workers.add(promise);
          const completed = (error) => {
            if (error) fail(error);
            run.workers.delete(promise);
            run.launch();
            settle();
          };
          promise.then(() => completed(), completed);
        }
      } catch (error) {
        fail(error);
      }
    };
    this.db.prepare("UPDATE jobs SET state='running' WHERE id=?").run(id);
    this.running = run;
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
  async cancel(id, { cleanupPending = false } = {}) {
    const job = this.db.prepare("SELECT * FROM jobs WHERE id=?").get(id);
    if (!job) throw new Error("Transfer batch not found.");
    if (job.state === "complete" && !cleanupPending)
      throw new Error("Completed batches cannot be cancelled.");
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
    const runtimeFailure = !!(
      job?.runtimeFailure || this.runtimeErrors.has(id)
    );
    if (!job || (job.error && !runtimeFailure) || job.state === "scanning")
      throw new Error("This batch cannot be retried. Create a new batch.");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `UPDATE entries SET state='pending',error=NULL WHERE job=? AND state IN ('failed','cancelled'${runtimeFailure ? ",'uploading','downloading','transferring'" : ""})`,
        )
        .run(id);
      this.db
        .prepare(
          "UPDATE jobs SET state='paused',error=NULL,runtimeFailure=0 WHERE id=?",
        )
        .run(id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.runtimeErrors.delete(id);
  }
  failureReport(id) {
    const job = this.db.prepare("SELECT * FROM jobs WHERE id=?").get(id);
    if (!job) throw new Error("Transfer batch not found.");
    const rows = this.db
      .prepare(
        "SELECT source,key,size,state,error,attempts FROM entries WHERE job=? AND state='failed' ORDER BY id",
      )
      .all(id);
    const error = this.runtimeErrors.get(id)?.message || job.error;
    if (error) rows.unshift({ state: "failed", error });
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
    this.runtimeErrors.delete(id);
  }
}
module.exports = {
  Queue,
  RateLimiter,
  validateUploadSource,
  openUploadSource,
};
