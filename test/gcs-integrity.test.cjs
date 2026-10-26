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

async function fixture(
  t,
  checksum,
  { directory = false, overwrite = false, retries = 2 } = {},
) {
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
    conditions: [],
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
              state.conditions.push(options.preconditionOpts);
              assert.equal(
                entry.integrityRevision,
                options.preconditionOpts.ifGenerationMatch === 0
                  ? "*"
                  : `"gcs:${options.preconditionOpts.ifGenerationMatch}:${options.preconditionOpts.ifMetagenerationMatch}"`,
              );
              const chunks = [];
              return new Writable({
                write(chunk, encoding, done) {
                  chunks.push(Buffer.from(chunk));
                  done();
                },
                final(done) {
                  state.writes++;
                  if (state.pauseBeforeCommit) {
                    state.pauseBeforeCommit = false;
                    void queue.pause();
                    done(new Error("Paused before commit"));
                    return;
                  }
                  if (state.failBeforeCommit) {
                    state.failBeforeCommit = false;
                    done(new Error("Connection failed before commit"));
                    return;
                  }
                  const condition = options.preconditionOpts;
                  if (
                    (condition.ifGenerationMatch === 0 && state.remote) ||
                    (condition.ifGenerationMatch !== 0 &&
                      (state.remote?.metadata.generation !==
                        condition.ifGenerationMatch ||
                        state.remote?.metadata.metageneration !==
                          condition.ifMetagenerationMatch))
                  ) {
                    done(
                      Object.assign(new Error("Precondition failed"), {
                        code: 412,
                      }),
                    );
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
                    generation: String(
                      Number(state.remote?.metadata.generation || 0) + 1,
                    ),
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
                  if (state.lostReply) {
                    state.lostReply = false;
                    done(
                      Object.assign(new Error("Retry after lost reply"), {
                        code: 412,
                      }),
                    );
                  } else done();
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
    overwrite,
    retries,
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

function originalObject() {
  return {
    body: Buffer.from("original"),
    metadata: {
      generation: "9",
      metageneration: "2",
      size: "8",
      metadata: {},
    },
  };
}

for (const recovery of ["automatic retry", "restart", "manual retry", "pause"])
  test(`GCS interrupted replacement retries its durable original revision after ${recovery}`, async (t) => {
    const f = await fixture(t, crc.toString(), {
      overwrite: true,
      retries: recovery === "automatic retry" ? 1 : 0,
    });
    f.state.remote = originalObject();
    if (recovery === "pause") f.state.pauseBeforeCommit = true;
    else f.state.failBeforeCommit = true;
    const first = await f.run();
    if (recovery !== "automatic retry") {
      assert.equal(first.state, recovery === "pause" ? "paused" : "failed");
      assert.equal(f.entry().integrityPending, 1);
      assert.equal(f.entry().integrityRevision, '"gcs:9:2"');
      if (recovery === "restart") f.reopen(true);
      else if (recovery !== "pause") f.retry();
      assert.equal((await f.run()).state, "complete");
    } else assert.equal(first.state, "complete");
    assert.equal(f.state.writes, 2);
    assert.equal(f.entry().state, "done");
    assert.equal(f.entry().integrityPending, 0);
    assert.deepEqual(
      f.state.conditions,
      Array(2).fill({ ifGenerationMatch: "9", ifMetagenerationMatch: "2" }),
    );
  });

for (const mutation of ["generation", "metageneration", "deletion"])
  test(`GCS interrupted replacement fails closed after concurrent ${mutation}`, async (t) => {
    const f = await fixture(t, crc.toString(), { overwrite: true, retries: 0 });
    f.state.remote = originalObject();
    f.state.failBeforeCommit = true;
    assert.equal((await f.run()).state, "failed");
    if (mutation === "deletion") f.state.remote = null;
    else f.state.remote.metadata[mutation] = "10";
    f.reopen(true);
    const result = await f.run();
    assert.equal(result.state, "failed");
    assert.equal(result.done, 0);
    assert.equal(result.skipped, 0);
    assert.equal(f.state.writes, 1);
    assert.equal(f.entry().integrityPending, 1);
  });

for (const overwrite of [false, true])
  test(`GCS lost upload reply followed by SDK 412 records uploaded bytes with overwrite=${overwrite}`, async (t) => {
    const f = await fixture(t, crc.toString(), { overwrite, retries: 0 });
    if (overwrite) f.state.remote = originalObject();
    f.state.lostReply = true;
    const result = await f.run();
    assert.equal(result.state, "complete");
    assert.equal(result.done, 1);
    assert.equal(result.skipped, 0);
    assert.equal(f.state.writes, 1);
  });

for (const overwrite of [false, true])
  test(`GCS prior committed operation is reconciled on restart with overwrite=${overwrite}`, async (t) => {
    const f = await fixture(t, crc.toString(), { overwrite, retries: 0 });
    assert.equal((await f.run()).done, 1);
    f.reopen(true);
    // Simulate an older queue that lost its pending bit after a remote commit.
    f.queue.db.exec("UPDATE entries SET integrityPending=0");
    const result = await f.run();
    assert.equal(result.done, 1);
    assert.equal(result.skipped, 0);
    assert.equal(f.state.writes, 1);
  });

test("GCS legacy pending replacement without a durable revision requires review", async (t) => {
  const f = await fixture(t, crc.toString(), { overwrite: true, retries: 0 });
  f.state.remote = originalObject();
  f.queue.db.exec(
    "UPDATE entries SET integrityPending=1,integrityRevision=NULL",
  );
  assert.equal((await f.run()).state, "failed");
  assert.equal(f.state.writes, 0);
});

test("GCS prior committed operation with corrupted bytes cannot become skipped", async (t) => {
  const f = await fixture(t, crc.toString(), { retries: 0 });
  assert.equal((await f.run()).done, 1);
  f.state.remote.body = Buffer.from("corrupt");
  f.reopen(true);
  f.queue.db.exec("UPDATE entries SET integrityPending=0");
  const result = await f.run();
  assert.equal(result.state, "failed");
  assert.equal(result.done, 0);
  assert.equal(result.skipped, 0);
  assert.equal(f.state.writes, 1);
});

test("GCS verified-absent retry still rejects a writer appearing at commit", async (t) => {
  const f = await fixture(t, crc.toString(), { retries: 0 });
  f.state.failBeforeCommit = true;
  assert.equal((await f.run()).state, "failed");
  assert.equal(f.entry().integrityRevision, "*");
  f.state.raceOnWrite = true;
  f.reopen(true);
  const result = await f.run();
  assert.equal(result.state, "failed");
  assert.equal(result.done, 0);
  assert.equal(result.skipped, 0);
  assert.equal(f.state.writes, 2);
  assert.equal(f.entry().integrityPending, 1);
});

test("GCS first-attempt create race records a foreign winner as skipped", async (t) => {
  const f = await fixture(t, crc.toString(), { retries: 0 });
  f.state.raceOnWrite = true;
  const result = await f.run();
  assert.equal(result.state, "complete");
  assert.equal(result.done, 0);
  assert.equal(result.skipped, 1);
  assert.equal(f.state.writes, 1);
});

for (const retries of [0, 2])
  test(`GCS first-attempt 412 after a corrupt owned commit remains failed with retries=${retries}`, async (t) => {
    const f = await fixture(t, "AAAAAA==", { retries });
    f.state.lostReply = true;
    for (const attempt of ["initial", "manual", "restart"]) {
      if (attempt === "manual") f.retry();
      if (attempt === "restart") f.reopen(true);
      const result = await f.run();
      assert.equal(result.state, "failed", attempt);
      assert.equal(result.done, 0, attempt);
      assert.equal(result.skipped, 0, attempt);
      assert.equal(f.entry().integrityPending, 1, attempt);
      assert.equal(f.entry().integrityRevision, "*", attempt);
      assert.equal(f.state.writes, 1, attempt);
      assert.equal(f.state.deletes, 0, attempt);
      assert.deepEqual(f.state.remote.body, Buffer.from("corrupt"));
    }
  });

for (const overwrite of [false, true])
  test(`GCS durable revision still protects a prior commit after its pending flag clears, overwrite=${overwrite}`, async (t) => {
    const f = await fixture(t, crc.toString(), { overwrite, retries: 0 });
    assert.equal((await f.run()).done, 1);
    assert.equal(f.entry().integrityPending, 0);
    f.state.remote = originalObject();
    f.reopen(true);
    const result = await f.run();
    assert.equal(result.state, "failed");
    assert.equal(result.done, 0);
    assert.equal(result.skipped, 0);
    assert.equal(f.state.writes, 1);
    assert.equal(f.state.remote.metadata.generation, "9");
  });
