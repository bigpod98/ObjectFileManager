const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  CreateBucketCommand,
  DeleteBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} = require("@aws-sdk/client-s3");
const storage = require("../src/storage.cjs");
const objectTools = require("../src/object-tools.cjs");
const sync = require("../src/sync.cjs");
const { Queue } = require("../src/queue.cjs");
const { Workspace } = require("../src/workspace.cjs");

test(
  "review fixes against S3: stale metadata, interrupted sync uploads and pausable cleanup",
  {
    skip: !process.env.S3_TEST_ENDPOINT,
    timeout: 120000,
  },
  async (t) => {
    const s3 = storage.client({
      endpoint: process.env.S3_TEST_ENDPOINT,
      accessKeyId: process.env.S3_TEST_ACCESS_KEY || "s3browser-test",
      secretAccessKey:
        process.env.S3_TEST_SECRET_KEY || "s3browser-test-secret",
      region: "us-east-1",
      pathStyle: true,
    });
    const bucket = `s3-review-${Date.now()}-${process.pid}`;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "s3-review-live-"));
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    t.after(async () => {
      try {
        while (true) {
          const page = await s3.send(
            new ListObjectsV2Command({ Bucket: bucket }),
          );
          if (!page.Contents?.length) break;
          const result = await s3.send(
            new DeleteObjectsCommand({
              Bucket: bucket,
              Delete: { Objects: page.Contents.map((o) => ({ Key: o.Key })) },
            }),
          );
          assert.equal(result.Errors?.length || 0, 0);
        }
        await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
      } finally {
        s3.destroy();
        await fs.rm(root, { recursive: true, force: true });
      }
    });
    const put = (key, body, extra = {}) =>
      s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ...extra,
        }),
      );
    const head = (key) =>
      s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));

    await t.test(
      "stale metadata-only changes reject saving the old dialog",
      async () => {
        const key = "metadata.txt";
        await put(key, "unchanged bytes", {
          Metadata: { owner: "first" },
          ContentType: "text/plain",
        });
        const reviewed = await objectTools.details(s3, { bucket, key });
        await put(key, "unchanged bytes", {
          Metadata: { owner: "other", retained: "yes" },
          ContentType: "text/plain",
        });
        assert.equal((await head(key)).ETag, reviewed.etag);
        await assert.rejects(
          objectTools.metadata(s3, {
            bucket,
            key,
            expectedSnapshot: reviewed.metadataSnapshot,
            metadata: { owner: "stale editor" },
            contentType: "text/plain",
          }),
          /changed|refresh/i,
        );
        assert.deepEqual((await head(key)).Metadata, {
          owner: "other",
          retained: "yes",
        });
        const fresh = await objectTools.details(s3, { bucket, key });
        await objectTools.metadata(s3, {
          bucket,
          key,
          expectedSnapshot: fresh.metadataSnapshot,
          metadata: { owner: "reviewed editor" },
          contentType: "text/plain",
        });
        assert.deepEqual((await head(key)).Metadata, {
          owner: "reviewed editor",
        });
      },
    );

    await t.test(
      "lost single-part and multipart responses reconcile without overwriting again",
      async () => {
        const source = path.join(root, "lost-source");
        await fs.mkdir(source);
        await fs.writeFile(path.join(source, "new.txt"), "new content");
        await fs.writeFile(
          path.join(source, "replaced.txt"),
          "replacement content",
        );
        await fs.writeFile(
          path.join(source, "large.bin"),
          Buffer.alloc(17 * 1024 * 1024, 42),
        );
        await fs.mkdir(path.join(source, "empty"));
        await put("lost/replaced.txt", "old content");
        const plan = await sync.compare(s3, {
          profile: "test",
          bucket,
          prefix: "lost/",
          source,
        });
        const writes = new Map();
        const lost = new Set();
        const client = {
          config: s3.config,
          send: async (command, options) => {
            const result = await s3.send(command, options);
            if (
              ["PutObjectCommand", "CompleteMultipartUploadCommand"].includes(
                command.constructor.name,
              )
            ) {
              const key = command.input.Key;
              writes.set(key, (writes.get(key) || 0) + 1);
              if (!lost.has(key)) {
                lost.add(key);
                throw Object.assign(
                  new Error("Connection lost after remote commit"),
                  { name: "TimeoutError" },
                );
              }
            }
            return result;
          },
        };
        const queue = new Queue(
          path.join(root, "lost.sqlite"),
          storage.transfer,
        );
        try {
          const id = queue.createJob({
            ...plan,
            kind: "upload",
            overwrite: true,
            retries: 1,
          });
          await queue.start(id, client);
          await queue.running.finished;
          assert.equal(
            queue.list()[0].state,
            "complete",
            JSON.stringify(queue.entries(id)),
          );
          assert.equal(queue.list()[0].done, 4);
          assert.equal(lost.size, 4);
          assert.ok([...writes.values()].every((count) => count === 1));
        } finally {
          await queue.pause();
          queue.db.close();
        }
      },
    );

    await t.test(
      "restart reconciles unrecorded success but rejects an unrelated concurrent replacement",
      async () => {
        const source = path.join(root, "restart-source");
        await fs.mkdir(source);
        await fs.writeFile(path.join(source, "file.txt"), "intended content");
        const plan = await sync.compare(s3, {
          profile: "test",
          bucket,
          prefix: "restart/",
          source,
        });
        const file = path.join(root, "restart.sqlite");
        let queue = new Queue(file, storage.transfer);
        try {
          const id = queue.createJob({
            ...plan,
            kind: "upload",
            overwrite: true,
            retries: 0,
          });
          await queue.start(id, s3);
          await queue.running.finished;
          assert.equal(queue.list()[0].state, "complete");
          const before = await head("restart/file.txt");
          const simulateCrash = () => {
            queue.db
              .prepare("UPDATE entries SET state='uploading' WHERE job=?")
              .run(id);
            queue.db
              .prepare("UPDATE jobs SET state='running' WHERE id=?")
              .run(id);
            queue.db.close();
            queue = new Queue(file, storage.transfer);
          };
          simulateCrash();
          await queue.start(id, s3);
          await queue.running.finished;
          assert.equal(
            queue.list()[0].state,
            "complete",
            JSON.stringify(queue.entries(id)),
          );
          assert.equal((await head("restart/file.txt")).ETag, before.ETag);
          // Even copied recovery metadata cannot prove success if the bytes differ.
          await put("restart/file.txt", "different bytes!", {
            Metadata: before.Metadata,
          });
          simulateCrash();
          await queue.start(id, s3);
          await queue.running.finished;
          assert.equal(queue.list()[0].state, "failed");
          const remote = await s3.send(
            new GetObjectCommand({ Bucket: bucket, Key: "restart/file.txt" }),
          );
          assert.equal(
            await remote.Body.transformToString(),
            "different bytes!",
          );
        } finally {
          await queue.pause();
          queue.db.close();
        }
      },
    );

    await t.test(
      "pause during a committed deletion prevents subsequent deletes until resume",
      async () => {
        const source = path.join(root, "cleanup-source");
        await fs.mkdir(source);
        await put("cleanup/a", "a");
        await put("cleanup/b", "b");
        let entered,
          release,
          deleting = 0;
        const firstDelete = new Promise((resolve) => (entered = resolve));
        const gate = new Promise((resolve) => (release = resolve));
        const client = {
          config: s3.config,
          send: async (command, options) => {
            const result = await s3.send(command, options);
            if (
              command.constructor.name === "DeleteObjectCommand" &&
              ++deleting === 1
            ) {
              entered();
              await gate;
            }
            return result;
          },
        };
        const queue = new Queue(
          path.join(root, "cleanup.sqlite"),
          storage.transfer,
        );
        const workspace = new Workspace(queue, () => client);
        try {
          const preview = await workspace.compare({
            profile: "test",
            bucket,
            prefix: "cleanup/",
            source,
            deleteRemote: true,
          });
          const id = await workspace.apply(preview.token);
          await workspace.start(id);
          await firstDelete;
          const paused = workspace.pause();
          release();
          await paused;
          assert.equal(deleting, 1);
          assert.equal(workspace.list()[0].state, "paused");
          assert.equal((await head("cleanup/b")).ContentLength, 1);
          await workspace.start(id);
          await workspace.finishing;
          assert.equal(workspace.list()[0].state, "complete");
          assert.equal(deleting, 2);
        } finally {
          release();
          await workspace.close();
          queue.db.close();
        }
      },
    );
  },
);
