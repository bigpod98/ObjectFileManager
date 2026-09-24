const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const {
  CreateBucketCommand,
  DeleteBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  PutBucketVersioningCommand,
  ListObjectVersionsCommand,
  CreateMultipartUploadCommand,
  ListMultipartUploadsCommand,
  AbortMultipartUploadCommand,
} = require("@aws-sdk/client-s3");
const storage = require("../src/storage.cjs");
const { Queue } = require("../src/queue.cjs");

test(
  "S3 expansion integration: queued downloads, operations, object tools and sync",
  { skip: !process.env.S3_TEST_ENDPOINT, timeout: 180_000 },
  async (t) => {
    const downloads = require("../src/downloads.cjs");
    const operations = require("../src/operations.cjs");
    const objectTools = require("../src/object-tools.cjs");
    const sync = require("../src/sync.cjs");
    const s3 = storage.client({
      endpoint: process.env.S3_TEST_ENDPOINT,
      region: "us-east-1",
      pathStyle: true,
      accessKeyId: process.env.S3_TEST_ACCESS_KEY || "s3browser-test",
      secretAccessKey:
        process.env.S3_TEST_SECRET_KEY || "s3browser-test-secret",
    });
    const bucket = `s3browser-expansion-${Date.now()}-${process.pid}`;
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "s3browser-expansion-"),
    );
    const queue = new Queue(path.join(root, "queue.sqlite"), (...args) =>
      (args[1].kind === "download" ? downloads.transfer : storage.transfer)(
        ...args,
      ),
    );
    let versioned = false;
    let created = false;
    t.after(async () => {
      await queue.pause();
      queue.db.close();
      try {
        if (created) {
          const unfinished = await s3.send(
            new ListMultipartUploadsCommand({ Bucket: bucket }),
          );
          for (const upload of unfinished.Uploads || [])
            await s3.send(
              new AbortMultipartUploadCommand({
                Bucket: bucket,
                Key: upload.Key,
                UploadId: upload.UploadId,
              }),
            );
          // Re-list the first page after deletion so cleanup does not rely on
          // continuation markers for objects that have just been removed.
          while (true) {
            const result = await s3.send(
              versioned
                ? new ListObjectVersionsCommand({ Bucket: bucket })
                : new ListObjectsV2Command({ Bucket: bucket }),
            );
            const objects = versioned
              ? [
                  ...(result.Versions || []),
                  ...(result.DeleteMarkers || []),
                ].map((v) => ({ Key: v.Key, VersionId: v.VersionId }))
              : (result.Contents || []).map((o) => ({ Key: o.Key }));
            if (!objects.length) break;
            const deleted = await s3.send(
              new DeleteObjectsCommand({
                Bucket: bucket,
                Delete: { Objects: objects, Quiet: true },
              }),
            );
            assert.equal(deleted.Errors?.length || 0, 0);
          }
          await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
        }
      } finally {
        s3.destroy();
        await fs.rm(root, { recursive: true, force: true });
      }
    });
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    created = true;
    const put = (key, body, extra = {}) =>
      s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ...extra,
        }),
      );
    const read = async (key) =>
      (
        await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
      ).Body.transformToString();
    const missing = (key) =>
      assert.rejects(
        s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key })),
        (error) => error.$metadata?.httpStatusCode === 404,
      );
    const run = async (id) => {
      await queue.start(id, s3);
      await queue.running?.finished;
      const job = queue.list().find((item) => item.id === id);
      assert.equal(job.failed, 0, JSON.stringify(queue.entries(id)));
      assert.equal(job.state, "complete");
      return job;
    };

    await t.test(
      "queued folder downloads deduplicate, skip and replace",
      async () => {
        await put("download/tree/empty/", "");
        await put("download/tree/世界 +%.txt", "downloaded content");
        await put("download/tree/nested/child.txt", "nested content");
        const destination = path.join(root, "download");
        await fs.mkdir(destination);
        const options = {
          bucket,
          prefix: "download/",
          selection: [
            { key: "download/tree/", folder: true },
            { key: "download/tree/世界 +%.txt", folder: false },
          ],
          destination,
        };
        const entries = await downloads.plan(s3, options);
        assert.equal(
          new Set(entries.map((entry) => entry.key)).size,
          entries.length,
        );
        const create = (overwrite = false) =>
          queue.createJob({
            profile: "integration",
            bucket,
            prefix: options.prefix,
            kind: "download",
            entries,
            overwrite,
            concurrency: 3,
          });
        await run(await create());
        const target = path.join(destination, "tree", "世界 +%.txt");
        assert.equal(await fs.readFile(target, "utf8"), "downloaded content");
        assert.ok(
          (
            await fs.stat(path.join(destination, "tree", "empty"))
          ).isDirectory(),
        );
        assert.equal(
          await fs.readFile(
            path.join(destination, "tree", "nested", "child.txt"),
            "utf8",
          ),
          "nested content",
        );
        await fs.writeFile(target, "local replacement");
        const skipped = await run(await create());
        assert.ok(skipped.skipped >= 2);
        assert.equal(await fs.readFile(target, "utf8"), "local replacement");
        await run(await create(true));
        assert.equal(await fs.readFile(target, "utf8"), "downloaded content");
        await put("download/tree/世界 +%.txt", "remote changed after preview");
        const stale = await create(true);
        await queue.start(stale, s3);
        await queue.running?.finished;
        assert.equal(queue.list().find((job) => job.id === stale).failed, 1);
        assert.equal(await fs.readFile(target, "utf8"), "downloaded content");
        assert.equal(queue.failureReport(stale).length, 1);
      },
    );

    await t.test(
      "folder creation and reviewed recursive copy, move and delete",
      async () => {
        await operations.createFolder(s3, bucket, "operations/source/empty/");
        await put("operations/source/a +%.txt", "source content");
        await put("operations/source/nested/b.txt", "nested source");
        const execute = async (options) => {
          const plan = await operations.preview(s3, { bucket, ...options });
          assert.ok(plan.items.length > 0);
          const result = await operations.execute(s3, plan);
          assert.equal(result.failures?.length || 0, 0, JSON.stringify(result));
          return plan;
        };
        await execute({
          action: "copy",
          sourcePrefix: "operations/",
          destinationBucket: bucket,
          destinationPrefix: "copies/",
          selection: [{ key: "operations/source/", folder: true }],
        });
        assert.equal(await read("copies/source/a +%.txt"), "source content");
        assert.equal(
          await read("operations/source/a +%.txt"),
          "source content",
        );
        await execute({
          action: "move",
          sourcePrefix: "copies/",
          destinationBucket: bucket,
          destinationPrefix: "moved/",
          selection: [{ key: "copies/source/", folder: true }],
        });
        assert.equal(await read("moved/source/nested/b.txt"), "nested source");
        await missing("copies/source/a +%.txt");
        await execute({
          action: "delete",
          selection: [{ key: "moved/source/", folder: true }],
        });
        await missing("moved/source/nested/b.txt");
      },
    );

    await t.test(
      "metadata replacement preserves bytes and signed links fetch content",
      async () => {
        const key = "tools/世界 +%.txt";
        await put(key, "original bytes", {
          ContentType: "text/plain",
          Metadata: { original: "old" },
        });
        const reviewed = await objectTools.details(s3, { bucket, key });
        await objectTools.metadata(s3, {
          bucket,
          key,
          expectedSnapshot: reviewed.metadataSnapshot,
          metadata: { reviewed: "yes", owner: "integration" },
          contentType: "application/json",
        });
        const head = await s3.send(
          new HeadObjectCommand({ Bucket: bucket, Key: key }),
        );
        assert.deepEqual(head.Metadata, {
          reviewed: "yes",
          owner: "integration",
        });
        assert.equal(head.ContentType, "application/json");
        assert.equal(await read(key), "original bytes");
        assert.ok(await objectTools.details(s3, { bucket, key }));
        const signed = await objectTools.signedUrl(s3, {
          bucket,
          key,
          expiresIn: 60,
        });
        const response = await fetch(
          typeof signed === "string" ? signed : signed.url,
        );
        assert.equal(response.status, 200);
        assert.equal(await response.text(), "original bytes");
      },
    );

    await t.test(
      "recursive search returns every page without duplicates",
      async () => {
        const count = 2505;
        for (let start = 0; start < count; start += 25)
          await Promise.all(
            Array.from({ length: Math.min(25, count - start) }, (_, offset) =>
              put(
                `search/nested/match-${String(start + offset).padStart(4, "0")}.txt`,
                "x",
              ),
            ),
          );
        const keys = [];
        let token;
        let pages = 0;
        do {
          const page = await objectTools.search(s3, {
            bucket,
            prefix: "search/",
            query: "match-",
            token,
          });
          keys.push(...page.objects.map((object) => object.key));
          token = page.token;
          pages++;
          assert.ok(pages < 20, "Search cursor must make progress");
        } while (token);
        assert.ok(pages > 1);
        assert.equal(keys.length, count);
        assert.equal(new Set(keys).size, count);
      },
    );

    await t.test(
      "reviewed sync uploads changed files and deletes only stale remote keys",
      async () => {
        const source = path.join(root, "sync-source");
        await fs.mkdir(source);
        await fs.writeFile(path.join(source, "unchanged.txt"), "same");
        await fs.writeFile(path.join(source, "changed.txt"), "new content");
        await fs.writeFile(path.join(source, "new.txt"), "added");
        await put("sync/unchanged.txt", "same");
        await put("sync/changed.txt", "old content");
        await put("sync/stale.txt", "remove after successful upload");
        const options = {
          profile: "integration",
          bucket,
          prefix: "sync/",
          source,
        };
        const safe = await sync.compare(s3, options);
        assert.equal(safe.deletions.length, 0);
        const plan = await sync.compare(s3, { ...options, deleteRemote: true });
        assert.deepEqual(
          plan.deletions.map((item) => item.key),
          ["sync/stale.txt"],
        );
        assert.ok(plan.entries.some((item) => item.key === "sync/changed.txt"));
        assert.ok(plan.entries.some((item) => item.key === "sync/new.txt"));
        assert.ok(
          !plan.entries.some((item) => item.key === "sync/unchanged.txt"),
        );
        await sync.validate(plan, s3);
        await run(
          await queue.createJob({ ...plan, kind: "upload", overwrite: true }),
        );
        const result = await sync.executeDeletions(s3, plan);
        assert.equal(result.failures?.length || 0, 0);
        assert.equal(await read("sync/changed.txt"), "new content");
        assert.equal(await read("sync/new.txt"), "added");
        assert.equal(await read("sync/unchanged.txt"), "same");
        await missing("sync/stale.txt");
        const current = await sync.compare(s3, {
          ...options,
          deleteRemote: true,
        });
        assert.equal(current.entries.length, 0);
        assert.equal(current.deletions.length, 0);
        await put("sync/stale.txt", "reviewed for deletion");
        const stalePlan = await sync.compare(s3, {
          ...options,
          deleteRemote: true,
        });
        await put("sync/stale.txt", "changed after review");
        await assert.rejects(sync.executeDeletions(s3, stalePlan), /changed/i);
        assert.equal(await read("sync/stale.txt"), "changed after review");
        await fs.writeFile(
          path.join(source, "added-after-review.txt"),
          "new local file",
        );
        await assert.rejects(sync.validate(current), /changed/i);
      },
    );

    await t.test(
      "queued sync guards preserve concurrent remote writes for single and multipart uploads",
      async () => {
        const source = path.join(root, "guard-source");
        await fs.mkdir(source);
        for (const [name, content] of [
          ["small.txt", "local bytes"],
          ["large.bin", Buffer.alloc(17 * 1024 * 1024, 42)],
        ]) {
          await fs.writeFile(path.join(source, name), content);
          await put(`guards/${name}`, "original remote bytes");
        }
        await fs.writeFile(path.join(source, "new.txt"), "new local bytes");
        const plan = await sync.compare(s3, {
          profile: "integration",
          bucket,
          prefix: "guards/",
          source,
        });
        await sync.validate(plan, s3);
        const id = queue.createJob({
          ...plan,
          kind: "upload",
          overwrite: true,
          retries: 0,
        });
        for (const name of ["small.txt", "large.bin", "new.txt"])
          await put(`guards/${name}`, "concurrent remote bytes");
        await queue.start(id, s3);
        await queue.running.finished;
        assert.equal(queue.list().find((j) => j.id === id).failed, 3);
        for (const name of ["small.txt", "large.bin", "new.txt"])
          assert.equal(await read(`guards/${name}`), "concurrent remote bytes");
      },
    );

    await t.test(
      "incomplete multipart uploads can be listed and explicitly aborted",
      async () => {
        const key = "unfinished/upload.bin";
        const upload = await s3.send(
          new CreateMultipartUploadCommand({ Bucket: bucket, Key: key }),
        );
        const listed = await objectTools.multipart(s3, {
          bucket,
          prefix: "unfinished/",
        });
        assert.ok(
          listed.uploads.some(
            (item) => item.key === key && item.uploadId === upload.UploadId,
          ),
        );
        await objectTools.abortMultipart(s3, {
          bucket,
          key,
          uploadId: upload.UploadId,
        });
        const after = await objectTools.multipart(s3, {
          bucket,
          prefix: "unfinished/",
        });
        assert.equal(after.uploads.length, 0);
      },
    );

    await t.test(
      "version history restores prior bytes as the current version",
      async (versionTest) => {
        try {
          await s3.send(
            new PutBucketVersioningCommand({
              Bucket: bucket,
              VersioningConfiguration: { Status: "Enabled" },
            }),
          );
          versioned = true;
        } catch (error) {
          if (
            error.name === "NotImplemented" ||
            error.$metadata?.httpStatusCode === 501
          ) {
            versionTest.skip("Backend does not implement bucket versioning");
            return;
          }
          throw error;
        }
        const key = "versions/file +%.txt";
        const first = await put(key, "first revision");
        await put(key, "second revision");
        const history = await objectTools.versions(s3, { bucket, key });
        assert.ok(
          history.versions.some((item) => item.versionId === first.VersionId),
        );
        await objectTools.restore(s3, {
          bucket,
          key,
          versionId: first.VersionId,
        });
        assert.equal(await read(key), "first revision");
      },
    );
  },
);
