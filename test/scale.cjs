// Opt-in end-to-end workload. Creates and removes a dedicated bucket.
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
(async () => {
  if (!process.env.S3_TEST_ENDPOINT)
    throw new Error("Set S3_TEST_ENDPOINT to a disposable local S3 service.");
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
