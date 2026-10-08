const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const {
  CreateBucketCommand,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  DeleteBucketCommand,
  ListMultipartUploadsCommand,
} = require("@aws-sdk/client-s3");
const { client, browse, transfer } = require("../src/storage.cjs");
const downloads = require("../src/downloads.cjs");
const { Queue } = require("../src/queue.cjs");
test(
  "S3 integration: folder tree, multipart, skips, replacements, download and pagination",
  { skip: !process.env.S3_TEST_ENDPOINT },
  async (t) => {
    const s3 = client({
      endpoint: process.env.S3_TEST_ENDPOINT,
      region: "us-east-1",
      pathStyle: true,
      accessKeyId: process.env.S3_TEST_ACCESS_KEY || "objectfilemanager-test",
      secretAccessKey:
        process.env.S3_TEST_SECRET_KEY || "objectfilemanager-test-secret",
    });
    const bucket = `objectfilemanager-${Date.now()}`;
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "objectfilemanager-integration-"),
    );
    const q = new Queue(path.join(root, "queue.sqlite"), transfer);
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    t.after(async () => {
      await q.pause();
      q.db.close();
      let token;
      do {
        const r = await s3.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            ContinuationToken: token,
          }),
        );
        if (r.Contents?.length)
          await s3.send(
            new DeleteObjectsCommand({
              Bucket: bucket,
              Delete: { Objects: r.Contents.map((o) => ({ Key: o.Key })) },
            }),
          );
        token = r.NextContinuationToken;
      } while (token);
      await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
      s3.destroy();
      await fs.rm(root, { recursive: true, force: true });
    });
    const source = path.join(root, "Source");
    await fs.mkdir(path.join(source, "empty"), { recursive: true });
    await fs.mkdir(path.join(source, "nested"));
    await fs.writeFile(path.join(source, "nested", "世界.txt"), "hello world");
    await fs.writeFile(
      path.join(source, "large.bin"),
      Buffer.alloc(17 * 1024 * 1024, 42),
    );
    const options = {
      profile: "p",
      bucket,
      prefix: "backup/",
      sources: [source],
      concurrency: 4,
    };
    const id = await q.scan(options);
    await q.start(id, s3);
    await q.running.finished;
    assert.equal(
      q.list().find((j) => j.id === id).failed,
      0,
      JSON.stringify(q.entries(id)),
    );
    assert.equal(q.list().find((j) => j.id === id).done, 5);
    assert.deepEqual((await browse(s3, bucket, "backup/", null)).folders, [
      "backup/Source/",
    ]);
    assert.deepEqual(
      (await browse(s3, bucket, "backup/Source/", null)).folders.sort(),
      ["backup/Source/empty/", "backup/Source/nested/"],
    );
    const content = await s3.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: "backup/Source/nested/世界.txt",
      }),
    );
    assert.equal(await content.Body.transformToString(), "hello world");
    const destination = path.join(root, "download");
    await fs.mkdir(destination);
    const [downloadEntry] = await downloads.plan(s3, {
      bucket,
      prefix: "backup/Source/",
      selection: [{ key: "backup/Source/large.bin" }],
      destination,
    });
    await downloads.transfer(
      s3,
      { bucket, overwrite: false },
      downloadEntry,
      new AbortController().signal,
    );
    assert.deepEqual(
      await fs.readFile(downloadEntry.source),
      Buffer.alloc(17 * 1024 * 1024, 42),
    );
    const again = await q.scan(options);
    await q.start(again, s3);
    await q.running.finished;
    assert.equal(q.list().find((j) => j.id === again).skipped, 5);
    await fs.writeFile(path.join(source, "nested", "世界.txt"), "replacement");
    const replace = await q.scan({ ...options, overwrite: true });
    await q.start(replace, s3);
    await q.running.finished;
    assert.equal(q.list().find((j) => j.id === replace).done, 5);
    assert.equal(
      await (
        await s3.send(
          new GetObjectCommand({
            Bucket: bucket,
            Key: "backup/Source/nested/世界.txt",
          }),
        )
      ).Body.transformToString(),
      "replacement",
    );
    for (let i = 0; i < 505; i += 25)
      await Promise.all(
        Array.from({ length: Math.min(25, 505 - i) }, (_, n) =>
          s3.send(
            new PutObjectCommand({
              Bucket: bucket,
              Key: `pages/${String(i + n).padStart(4, "0")}`,
              Body: "x",
            }),
          ),
        ),
      );
    const page1 = await browse(s3, bucket, "pages/");
    assert.equal(page1.objects.length, 500);
    assert.ok(page1.token);
    const page2 = await browse(s3, bucket, "pages/", page1.token);
    assert.equal(page2.objects.length, 5);
    assert.equal(page2.token, null);
    const controller = new AbortController();
    await assert.rejects(
      transfer(
        s3,
        { bucket, overwrite: true },
        {
          source: path.join(source, "large.bin"),
          key: "cancelled.bin",
          size: 17 * 1024 * 1024,
          directory: false,
        },
        controller.signal,
        (loaded) => {
          if (loaded >= 8 * 1024 * 1024) controller.abort();
        },
      ),
    );
    const unfinished = await s3.send(
      new ListMultipartUploadsCommand({ Bucket: bucket }),
    );
    assert.equal(
      unfinished.Uploads?.length || 0,
      0,
      "Paused multipart upload should be cleaned up",
    );
    const cancelled = await browse(s3, bucket, "cancelled.bin");
    assert.equal(
      cancelled.objects.length,
      0,
      "Paused file must not be completed in the background",
    );
  },
);
