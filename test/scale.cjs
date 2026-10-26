// Local million-row polling benchmark, plus opt-in S3 workload when configured.
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { Queue } = require("../src/queue.cjs");
const { client, transfer } = require("../src/storage.cjs");
const {
  CreateBucketCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  DeleteBucketCommand,
} = require("@aws-sdk/client-s3");
async function benchmarkQueue() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "objectfilemanager-million-"),
  );
  const file = path.join(root, "queue.sqlite");
  let queue = new Queue(file, async () => {});
  try {
    const id = queue.createJob({
      profile: "benchmark",
      bucket: "local",
      kind: "download",
      entries: [],
    });
    console.time("Populate 1,000,000 durable queue rows");
    queue.db.exec("BEGIN");
    queue.db
      .prepare(
        `WITH RECURSIVE rows(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM rows WHERE n<999999)
      INSERT INTO entries(job,source,key,size,directory,state)
      SELECT ?, '', CAST(n AS TEXT), 10, 0,
        CASE n%5 WHEN 0 THEN 'done' WHEN 1 THEN 'skipped' WHEN 2 THEN 'failed' WHEN 3 THEN 'cancelled' ELSE 'pending' END
      FROM rows`,
      )
      .run(id);
    queue.db.exec("COMMIT");
    console.timeEnd("Populate 1,000,000 durable queue rows");
    queue.db.close();
    queue = new Queue(file, async () => {});
    const result = queue.list()[0];
    assert.equal(result.total, 1000000);
    assert.equal(result.bytes, 10000000);
    for (const state of ["done", "skipped", "failed", "cancelled", "pending"])
      assert.equal(result[state], 200000);
    assert.equal(result.transferring, 0);
    assert.equal(result.completedBytes, 4000000);
    const timings = [];
    let heartbeat = 0;
    for (let i = 0; i < 500; i++) {
      await new Promise((resolve) =>
        setImmediate(() => {
          heartbeat++;
          resolve();
        }),
      );
      const start = performance.now();
      assert.equal(queue.list()[0].total, 1000000);
      timings.push(performance.now() - start);
    }
    timings.sort((a, b) => a - b);
    const p95 = timings[Math.floor(timings.length * 0.95)];
    console.log(
      `1,000,000-row queue: 500 polls, p50=${timings[250].toFixed(3)} ms, p95=${p95.toFixed(3)} ms, max=${timings.at(-1).toFixed(3)} ms; ${heartbeat} event-loop turns.`,
    );
    assert.ok(p95 < 100, `Queue poll p95 exceeded 100 ms: ${p95}`);
  } finally {
    await queue.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
}
(async () => {
  await benchmarkQueue();
  if (process.argv.includes("--queue-only") || !process.env.S3_TEST_ENDPOINT) {
    console.log(
      "Set S3_TEST_ENDPOINT to additionally run the 50,000-object S3 workload.",
    );
    return;
  }
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "objectfilemanager-scale-"),
  );
  const source = path.join(root, "Archive");
  const s3 = client({
    endpoint: process.env.S3_TEST_ENDPOINT,
    region: "us-east-1",
    pathStyle: true,
    accessKeyId: process.env.S3_TEST_ACCESS_KEY || "objectfilemanager-test",
    secretAccessKey:
      process.env.S3_TEST_SECRET_KEY || "objectfilemanager-test-secret",
  });
  const bucket = `scale-${Date.now()}`;
  const q = new Queue(path.join(root, "queue.sqlite"), transfer);
  await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  try {
    await fs.mkdir(source);
    for (let i = 0; i < 499; i++) await fs.mkdir(path.join(source, String(i)));
    for (let i = 0; i < 49500; i += 100)
      await Promise.all(
        Array.from({ length: 100 }, (_, j) =>
          fs.writeFile(
            path.join(source, String((i + j) % 499), `${i + j}.txt`),
            `file ${i + j}\n`,
          ),
        ),
      );
    console.time("Scan 50,000 filesystem entries");
    const id = await q.scan({
      profile: "local",
      bucket,
      prefix: "backup/",
      sources: [source],
      concurrency: 8,
      overwrite: true,
    });
    console.timeEnd("Scan 50,000 filesystem entries");
    assert.equal(q.list()[0].total, 50000);
    console.time("Upload 50,000 objects");
    const timer = setInterval(() => {
      const j = q.list()[0];
      console.log(`${j.done}/50000 done; ${j.failed} failed`);
    }, 10000);
    try {
      await q.start(id, s3);
      await q.running.finished;
    } finally {
      clearInterval(timer);
    }
    console.timeEnd("Upload 50,000 objects");
    assert.equal(q.list()[0].failed, 0, JSON.stringify(q.entries(id)));
    assert.equal(q.list()[0].done, 50000);
    let token,
      count = 0;
    do {
      const r = await s3.send(
        new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }),
      );
      count += r.Contents?.length || 0;
      token = r.NextContinuationToken;
    } while (token);
    assert.equal(count, 50000);
    console.log(
      "Verified 50,000 objects in storage, including the original directory tree.",
    );
  } finally {
    await q.pause();
    q.db.close();
    let contents;
    do {
      contents =
        (await s3.send(new ListObjectsV2Command({ Bucket: bucket })))
          .Contents || [];
      if (contents.length)
        await s3.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: contents.map((o) => ({ Key: o.Key })) },
          }),
        );
    } while (contents.length);
    await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
    s3.destroy();
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
