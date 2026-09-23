const { randomUUID } = require("node:crypto");
const operations = require("./operations.cjs");
const sync = require("./sync.cjs");

// Coordinates durable transfers and the reviewed, post-upload sync cleanup.
class Workspace {
  constructor(queue, getClient, activity = () => {}) {
    this.queue = queue;
    this.getClient = getClient;
    this.activity = activity;
    this.auto = false;
    this.closed = false;
    this.finishing = null;
    this.plans = new Map();
    queue.db
      .exec(`CREATE TABLE IF NOT EXISTS sync_runs(job TEXT PRIMARY KEY, plan TEXT NOT NULL, state TEXT NOT NULL, error TEXT);
      UPDATE sync_runs SET state='pending' WHERE state='running';`);
  }
  remember(type, profile, plan) {
    const now = Date.now();
    for (const [token, item] of this.plans)
      if (now - item.created > 3600000) this.plans.delete(token);
    if (this.plans.size >= 30)
      this.plans.delete(this.plans.keys().next().value);
    const token = randomUUID();
    this.plans.set(token, { type, profile, plan, created: now });
    return { token, plan };
  }
  take(token, type) {
    const item = this.plans.get(token);
    if (!item || item.type !== type || Date.now() - item.created > 3600000)
      throw new Error("This preview expired. Generate a fresh preview.");
    this.plans.delete(token);
    return item;
  }
  async preview(options) {
    const plan = await operations.preview(
      this.getClient(options.profile),
      options,
    );
    return this.remember("operations", options.profile, plan);
  }
  async execute(token) {
    const item = this.take(token, "operations");
    return operations.execute(this.getClient(item.profile), item.plan);
  }
  async compare(options) {
    const plan = await sync.compare(this.getClient(options.profile), options);
    return this.remember("sync", options.profile, plan);
  }
  async apply(token) {
    const item = this.take(token, "sync");
    const plan = item.plan;
    await sync.validate(plan, this.getClient(item.profile));
    const id = this.queue.createJob({
      profile: item.profile,
      bucket: plan.bucket,
      prefix: plan.prefix,
      kind: "upload",
      entries: plan.entries,
      overwrite: true,
    });
    // The manifest and cleanup are durable before the user can start the batch.
    this.queue.db
      .prepare("INSERT INTO sync_runs(job,plan,state) VALUES(?,?,'pending')")
      .run(id, JSON.stringify(plan));
    return id;
  }
  list() {
    const runs = new Map(
      this.queue.db
        .prepare("SELECT job,state,error FROM sync_runs")
        .all()
        .map((r) => [r.job, r]),
    );
    return this.queue.list().map((j) => {
      const run = runs.get(j.id);
      return run
        ? {
            ...j,
            sync: true,
            cleanupState: run.state,
            state:
              run.state === "failed"
                ? "failed"
                : run.state === "running"
                  ? "running"
                  : run.state === "pending" && j.state === "complete"
                    ? "paused"
                    : j.state,
            error: run.error || j.error,
          }
        : j;
    });
  }
  async finishSync(id) {
    const run = this.queue.db
      .prepare("SELECT * FROM sync_runs WHERE job=?")
      .get(id);
    if (!run || ["done", "cancelled"].includes(run.state)) return;
    const job = this.queue.list().find((j) => j.id === id);
    if (job?.state !== "complete") return;
    this.queue.db
      .prepare("UPDATE sync_runs SET state='running',error=NULL WHERE job=?")
      .run(id);
    try {
      const result = await sync.executeDeletions(
        this.getClient(job.profile),
        JSON.parse(run.plan),
      );
      if (result?.failed || result?.failures?.length)
        throw new Error(
          result.failures.map((f) => `${f.key}: ${f.error}`).join("\n"),
        );
      this.queue.db
        .prepare("UPDATE sync_runs SET state='done',error=NULL WHERE job=?")
        .run(id);
    } catch (e) {
      this.queue.db
        .prepare("UPDATE sync_runs SET state='failed',error=? WHERE job=?")
        .run(`Sync cleanup: ${e.message}`, id);
    }
  }
  async start(id) {
    if (this.closed) throw new Error("The application is closing.");
    if (this.finishing || this.queue.running)
      throw new Error("Pause the current batch before starting another.");
    const job = this.queue.list().find((j) => j.id === id);
    if (!job) throw new Error("Batch not found.");
    const context = this.getClient(job.profile);
    this.activity(true);
    try {
      await this.queue.start(id, context);
      const finished = this.queue.running?.finished || Promise.resolve();
      this.finishing = finished
        .then(() => this.finishSync(id))
        .finally(() => {
          this.finishing = null;
          this.activity(false);
          const completed =
            this.list().find((job) => job.id === id)?.state === "complete";
          if (!completed) this.auto = false;
          if (this.auto && !this.closed) setImmediate(() => this.advance());
        });
      // Report asynchronous coordinator failures as batch errors, never unhandled rejections.
      this.finishing.catch((e) => {
        this.auto = false;
        this.queue.db
          .prepare("UPDATE jobs SET state='failed',error=? WHERE id=?")
          .run(e.message, id);
      });
      return { started: true };
    } catch (e) {
      this.activity(false);
      throw e;
    }
  }
  async advance() {
    if (!this.auto || this.closed || this.queue.running || this.finishing)
      return;
    const next = this.list()
      .reverse()
      .find(
        (j) =>
          j.state === "paused" &&
          !j.error &&
          (j.total > j.done + j.skipped ||
            (j.sync && j.cleanupState === "pending")),
      );
    if (!next) return;
    try {
      await this.start(next.id);
    } catch {
      this.auto = false;
    }
  }
  async pause() {
    this.auto = false;
    await this.queue.pause();
    await this.finishing;
  }
  async cancel(id) {
    if (this.finishing && !this.queue.running)
      throw new Error("Wait for sync cleanup to finish.");
    this.queue.db
      .prepare("UPDATE sync_runs SET state='cancelled',error=NULL WHERE job=?")
      .run(id);
    if (this.queue.running?.id === id) await this.pause();
    return this.queue.cancel(id);
  }
  retry(id) {
    const syncRun = this.queue.db
      .prepare("SELECT state FROM sync_runs WHERE job=?")
      .get(id);
    if (syncRun?.state === "cancelled")
      throw new Error(
        "This sync was cancelled. Compare the folder again to create a new reviewed batch.",
      );
    if (this.finishing && this.queue.running?.id !== id)
      throw new Error("Wait for the current batch to finish.");
    this.queue.retry(id);
    this.queue.db
      .prepare(
        "UPDATE sync_runs SET state='pending',error=NULL WHERE job=? AND state='failed'",
      )
      .run(id);
  }
  remove(id) {
    if (this.finishing)
      throw new Error("Wait for the current batch to finish.");
    this.queue.remove(id);
    this.queue.db.prepare("DELETE FROM sync_runs WHERE job=?").run(id);
  }
  async close() {
    this.closed = true;
    await this.pause();
  }
}
module.exports = { Workspace };
