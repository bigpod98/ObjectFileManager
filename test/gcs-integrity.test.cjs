const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Readable, Writable } = require("node:stream");
const sdk = require("@google-cloud/storage");
const { Queue } = require("../src/queue.cjs");
const storage = require("../src/storage.cjs");

const payload = Buffer.from("payload");
const crc = new sdk.CRC32C();
crc.update(payload);

async function fixture(t, checksum, { directory = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gcs-integrity-"));
  const source = path.join(root, "file.txt");
  if (directory) await fs.mkdir(source);
  else await fs.writeFile(source, payload);
  const bytes = directory ? Buffer.alloc(0) : payload;
  const validChecksum = new sdk.CRC32C();
  validChecksum.update(bytes);
  const db = path.join(root, "queue.sqlite");
  const state = {
    remote: null,
    writes: 0,
    deletes: 0,
    failBeforeCommit: false,
  };
  let queue;
  class Storage {
    constructor() {
      this.authClient = {
        request: async (request) => {
          assert.equal(request.method, "GET");
          if (!state.remote)
            throw Object.assign(new Error("Not found"), { code: 404 });
          return {
            data:
              request.responseType === "stream"
                ? Readable.from([state.remote.body])
                : state.remote.metadata,
          };
        },
      };
    }
    bucket() {
      return {
        file() {
          const file = {
            metadata: {},
            createWriteStream(options) {
              // Recovery evidence must be durable before the remote commit.
              const entry = queue.db.prepare("SELECT * FROM entries").get();
              assert.equal(entry.integrityPending, 1);
              assert.ok(entry.sha256);
              assert.ok(entry.uploadToken);
              const chunks = [];
              return new Writable({
                write(chunk, encoding, done) {
                  chunks.push(Buffer.from(chunk));
                  done();
                },
                final(done) {
                  state.writes++;
                  if (state.failBeforeCommit) {
                    state.failBeforeCommit = false;
                    done(new Error("Connection failed before commit"));
                    return;
                  }
                  if (state.raceOnWrite) {
                    state.raceOnWrite = false;
                    state.remote = {
                      body: payload,
                      metadata: {
                        generation: "2",
                        metageneration: "1",
                        size: String(payload.length),
                        metadata: {},
                      },
                    };
                    done(
                      Object.assign(new Error("Precondition failed"), {
                        code: 412,
                      }),
                    );
                    return;
                  }
                  file.metadata = {
                    name: "file.txt",
                    generation: "1",
                    metageneration: "1",
                    size: String(bytes.length),
                    crc32c: checksum,
                    metadata: options.metadata.metadata,
                  };
                  state.remote = {
                    metadata: file.metadata,
                    body:
                      checksum === validChecksum.toString()
                        ? Buffer.concat(chunks)
                        : Buffer.from("corrupt"),
                  };
                  done();
                },
              });
            },
            delete() {
              state.deletes++;
              throw new Error("Must not delete the live object");
            },
          };
          return file;
        },
      };
    }
  }
  t.mock.getter(sdk, "Storage", () => Storage);
  const adapter = storage.client({
    provider: "Google Cloud Storage",
    serviceAccountJson: JSON.stringify({
      type: "service_account",
      project_id: "test-project",
      client_email: "test@example.test",
      private_key: "test-key",
    }),
  });
  queue = new Queue(db, storage.transfer);
  const id = await queue.scan({
    profile: "test",
    bucket: "bucket",
    sources: [source],
  });
  t.after(async () => {
    queue.db.close();
    adapter.destroy();
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    state,
    get queue() {
      return queue;
    },
    async run() {
      await queue.start(id, adapter);
      await queue.running.finished;
      return queue.list()[0];
    },
    retry() {
      queue.retry(id);
    },
    reopen(interrupted = false) {
      if (interrupted)
        queue.db.exec(
          "UPDATE entries SET state='uploading',error=NULL; UPDATE jobs SET state='running'",
        );
      queue.db.close();
      queue = new Queue(db, storage.transfer);
    },
    entry() {
      return queue.db.prepare("SELECT * FROM entries").get();
    },
  };
}

for (const checksum of [undefined, "AAAAAA=="])
  test(`GCS ${checksum ? "mismatched" : "missing"} checksum cannot become a skip across retries or restart`, async (t) => {
    const f = await fixture(t, checksum);
    let result = await f.run();
    assert.equal(result.state, "failed");
    assert.equal(result.skipped, 0);
    assert.equal(f.state.writes, 1);
    assert.equal(f.entry().attempts, 3);
    assert.equal(f.entry().integrityPending, 1);
    assert.match(f.entry().error, /integrity verification/);

    f.reopen();
    f.retry();
    result = await f.run();
    assert.equal(result.state, "failed");
    assert.equal(result.skipped, 0);
    assert.equal(f.state.writes, 1);

    // Even a concurrent writer copying identical bytes is not this upload.
    const metadata = { ...f.state.remote.metadata.metadata };
    f.state.remote.body = payload;
    f.state.remote.metadata.metadata["objectfilemanager-upload-token"] =
      "other-writer";
    f.reopen(true);
    result = await f.run();
    assert.equal(result.state, "failed");
    assert.equal(result.skipped, 0);
    assert.equal(f.entry().integrityPending, 1);

    // A generation-pinned read of our tagged, matching bytes is sufficient
    // recovery evidence even if the upload response omitted its checksum.
    f.state.remote.metadata.metadata = metadata;
    f.retry();
    result = await f.run();
    assert.equal(result.state, "complete");
    assert.equal(result.done, 1);
    assert.equal(result.skipped, 0);
    assert.equal(f.entry().integrityPending, 0);
    assert.equal(f.state.writes, 1);
    assert.equal(f.state.deletes, 0);
  });

test("GCS unrelated existing objects still skip without integrity recovery", async (t) => {
  const f = await fixture(t, crc.toString());
  f.state.remote = {
    body: payload,
    metadata: {
      generation: "1",
      metageneration: "1",
      size: String(payload.length),
    },
  };
  const result = await f.run();
  assert.equal(result.state, "complete");
  assert.equal(result.skipped, 1);
  assert.equal(f.state.writes, 0);
  assert.equal(f.entry().integrityPending, 0);
});

test("GCS pending integrity can retry a write that never committed", async (t) => {
  const f = await fixture(t, crc.toString());
  f.state.failBeforeCommit = true;
  const result = await f.run();
  assert.equal(result.state, "complete");
  assert.equal(result.done, 1);
  assert.equal(result.skipped, 0);
  assert.equal(f.state.writes, 2);
  assert.equal(f.entry().integrityPending, 0);
});

test("GCS recovery does not skip a concurrent 412 after the rejected object disappears", async (t) => {
  const f = await fixture(t, undefined);
  assert.equal((await f.run()).state, "failed");
  f.state.remote = null;
  f.state.raceOnWrite = true;
  f.retry();
  const result = await f.run();
  assert.equal(result.state, "failed");
  assert.equal(result.skipped, 0);
  assert.equal(f.entry().integrityPending, 1);
  assert.equal(f.state.remote.metadata.generation, "2");
  assert.equal(f.state.deletes, 0);
});

test("GCS directory integrity recovery also requires verified empty bytes", async (t) => {
  const f = await fixture(t, undefined, { directory: true });
  assert.equal((await f.run()).state, "failed");
  assert.equal(f.entry().integrityPending, 1);
  f.reopen(true);
  assert.equal((await f.run()).state, "failed");
  f.state.remote.body = Buffer.alloc(0);
  f.retry();
  const result = await f.run();
  assert.equal(result.state, "complete");
  assert.equal(result.done, 1);
  assert.equal(result.skipped, 0);
  assert.equal(f.state.writes, 1);
});
