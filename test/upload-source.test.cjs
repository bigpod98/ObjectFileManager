const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Queue } = require("../src/queue.cjs");
const storage = require("../src/storage.cjs");

async function fixture(t, transfer = async () => {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "upload-source-"));
  const file = path.join(root, "queue.sqlite");
  const state = { root, file, q: new Queue(file, transfer) };
  t.after(async () => {
    await state.q.pause();
    state.q.db.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return state;
}

async function writeSource(source, contents = "safe") {
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(source, contents);
  // Integer timestamps survive utimes exactly, so unintended contents really
  // do match the saved size and mtime, rather than failing the old stat check.
  await fs.utimes(source, 1700000000, 1700000000);
}

async function replaceDirectory(directory, relativeFile) {
  const source = path.join(directory, relativeFile);
  const before = await fs.lstat(source);
  const target = `${directory}-unintended`;
  await writeSource(path.join(target, relativeFile), "evil");
  await fs.rename(directory, `${directory}-original`);
  await fs.symlink(target, directory, "dir");
  const after = await fs.lstat(source);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs);
}

const scan = (q, sources, options = {}) =>
  q.scan({ profile: "p", bucket: "bucket", sources, retries: 0, ...options });
async function run(q, id, client = {}) {
  await q.start(id, client);
  await q.running.finished;
}

for (const selection of [
  "folder root",
  "nested parent",
  "single-file parent",
]) {
  test(`ordinary upload rejects a replaced ${selection} with matching file metadata`, async (t) => {
    const sent = [];
    const { q, root } = await fixture(t, async (_, job, entry) => {
      sent.push(entry.key);
    });
    const folder = path.join(root, "selected");
    const source = path.join(folder, "nested", "file.txt");
    await writeSource(source);
    const id = await scan(q, [
      selection === "single-file parent" ? source : folder,
    ]);
    const saved = q.db.prepare("SELECT * FROM entries WHERE job=?").all(id);
    assert.ok(saved.every((entry) => path.isAbsolute(entry.root)));
    assert.ok(
      saved.every(
        (entry) =>
          entry.root ===
          (selection === "single-file parent" ? path.dirname(source) : folder),
      ),
    );
    await replaceDirectory(
      selection === "folder root" ? folder : path.dirname(source),
      selection === "folder root" ? "nested/file.txt" : "file.txt",
    );
    await run(q, id);
    assert.deepEqual(sent, selection === "nested parent" ? ["selected/"] : []);
    assert.ok(
      q.failureReport(id).some((entry) => entry.key.endsWith("file.txt")),
    );
    assert.ok(
      q
        .failureReport(id)
        .every((entry) => /Source (parent )?changed/.test(entry.error)),
    );
  });
}

for (const legacy of [false, true]) {
  test(`restart/resume rejects replaced ancestors in ${legacy ? "legacy rootless" : "persisted ordinary"} uploads`, async (t) => {
    let calls = 0;
    const state = await fixture(t);
    const source = path.join(state.root, "selected", "file.txt");
    await writeSource(source);
    const id = await scan(state.q, [source]);
    const root = state.q.db
      .prepare("SELECT root FROM entries WHERE job=?")
      .get(id).root;
    if (legacy)
      state.q.db.prepare("UPDATE entries SET root=NULL WHERE job=?").run(id);
    state.q.db
      .prepare("UPDATE entries SET state='uploading' WHERE job=?")
      .run(id);
    state.q.db.prepare("UPDATE jobs SET state='running' WHERE id=?").run(id);
    state.q.db.close();
    await replaceDirectory(path.dirname(source), "file.txt");
    state.q = new Queue(state.file, async () => {
      calls++;
    });
    assert.equal(state.q.list()[0].state, "paused");
    assert.equal(
      state.q.db.prepare("SELECT root FROM entries WHERE job=?").get(id).root,
      legacy ? null : root,
    );
    await run(state.q, id);
    assert.equal(calls, 0);
    assert.match(state.q.failureReport(id)[0].error, /symbolic link/);
  });
}

test("each retry rechecks ordinary-upload ancestors", async (t) => {
  let calls = 0;
  const { q, root } = await fixture(t, async (_, job, entry) => {
    calls++;
    await replaceDirectory(path.dirname(entry.source), "file.txt");
    throw new Error("temporary network failure");
  });
  const source = path.join(root, "selected", "file.txt");
  await writeSource(source);
  const id = await scan(q, [source], { retries: 2 });
  await run(q, id);
  assert.equal(calls, 1);
  assert.match(q.failureReport(id)[0].error, /symbolic link/);
  assert.equal(q.failureReport(id)[0].attempts, 1);
});

test("scanning rejects selected files and folders beneath symlink ancestors", async (t) => {
  const { q, root } = await fixture(t);
  const folder = path.join(root, "selected");
  await writeSource(path.join(folder, "nested", "file.txt"));
  await replaceDirectory(folder, "nested/file.txt");
  await assert.rejects(scan(q, [path.join(folder, "nested")]), /symbolic link/);
  await assert.rejects(
    scan(q, [path.join(folder, "nested", "file.txt")]),
    /symbolic link/,
  );
  assert.ok(q.list().every((job) => job.state === "failed"));
});

test("scanning rechecks ancestors when a selected folder is replaced during traversal", async (t) => {
  const { q, root } = await fixture(t);
  const folder = path.join(root, "selected");
  await writeSource(path.join(folder, "nested", "file.txt"));
  const opendir = fs.opendir;
  fs.opendir = async (source, ...args) => {
    const dir = await opendir(source, ...args);
    if (source === folder) await replaceDirectory(folder, "nested/file.txt");
    return dir;
  };
  try {
    await assert.rejects(scan(q, [folder]), /symbolic link/);
  } finally {
    fs.opendir = opendir;
  }
  assert.equal(q.list()[0].state, "failed");
  await assert.rejects(q.start(q.list()[0].id, {}), /not ready/);
});

test("storage revalidates ancestors after remote HEAD and before opening a source", async (t) => {
  let uploaded = false;
  const { q, root } = await fixture(t, storage.transfer);
  const source = path.join(root, "selected", "file.txt");
  await writeSource(source);
  const id = await scan(q, [source]);
  await run(q, id, {
    async send(command) {
      assert.equal(command.constructor.name, "HeadObjectCommand");
      await replaceDirectory(path.dirname(source), "file.txt");
      throw Object.assign(new Error("missing"), {
        $metadata: { httpStatusCode: 404 },
      });
    },
    async upload() {
      uploaded = true;
    },
  });
  assert.equal(uploaded, false);
  assert.match(q.failureReport(id)[0].error, /symbolic link/);
});

test("the final source open does not follow a swapped leaf symlink", async (t) => {
  let uploaded = false;
  const { q, root } = await fixture(t, storage.transfer);
  const source = path.join(root, "file.txt");
  await writeSource(source);
  const id = await scan(q, [source], { overwrite: true });
  const open = fs.open;
  let swapped = false;
  fs.open = async (file, flags, ...args) => {
    if (file === source && !swapped) {
      swapped = true;
      assert.ok(flags & constants.O_NOFOLLOW);
      await fs.rename(source, `${source}-original`);
      await fs.symlink(`${source}-original`, source);
    }
    return open(file, flags, ...args);
  };
  try {
    await run(q, id, {
      async upload() {
        uploaded = true;
      },
    });
  } finally {
    fs.open = open;
  }
  assert.equal(swapped, true);
  assert.equal(uploaded, false);
  assert.match(q.failureReport(id)[0].error, /ELOOP|symbolic link/i);
});

test("opened-handle identity rejects a same-size same-mtime file substitution", async (t) => {
  let uploaded = false;
  const { q, root } = await fixture(t, storage.transfer);
  const source = path.join(root, "file.txt");
  await writeSource(source);
  const id = await scan(q, [source], { overwrite: true });
  const open = fs.open;
  let swapped = false;
  fs.open = async (file, flags, ...args) => {
    if (file === source && !swapped) {
      swapped = true;
      const stat = await fs.lstat(source);
      await fs.rename(source, `${source}-original`);
      await writeSource(source, "evil");
      const replacement = await fs.lstat(source);
      assert.equal(replacement.size, stat.size);
      assert.equal(replacement.mtimeMs, stat.mtimeMs);
    }
    return open(file, flags, ...args);
  };
  try {
    await run(q, id, {
      async upload() {
        uploaded = true;
      },
    });
  } finally {
    fs.open = open;
  }
  assert.equal(uploaded, false);
  assert.match(q.failureReport(id)[0].error, /Source changed while opening/);
});

test("storage rechecks ancestors after opening and closes a rejected handle", async (t) => {
  let uploaded = false;
  const { q, root } = await fixture(t, storage.transfer);
  const source = path.join(root, "selected", "file.txt");
  await writeSource(source);
  const id = await scan(q, [source], { overwrite: true });
  const open = fs.open;
  let handle;
  fs.open = async (file, flags, ...args) => {
    const opened = await open(file, flags, ...args);
    if (file === source && !handle) {
      handle = opened;
      await replaceDirectory(path.dirname(source), "file.txt");
    }
    return opened;
  };
  try {
    await run(q, id, {
      async upload() {
        uploaded = true;
      },
    });
  } finally {
    fs.open = open;
  }
  assert.equal(uploaded, false);
  assert.match(q.failureReport(id)[0].error, /symbolic link/);
  await assert.rejects(handle.stat(), { code: "EBADF" });
});

test("uploads read the validated handle after the pathname becomes a symlink", async (t) => {
  const { q, root } = await fixture(t, storage.transfer);
  const source = path.join(root, "file.txt");
  await writeSource(source);
  const id = await scan(q, [source], { overwrite: true });
  let uploaded;
  await run(q, id, {
    async upload(input) {
      await writeSource(`${source}-unintended`, "evil");
      await fs.rename(source, `${source}-original`);
      await fs.symlink(`${source}-unintended`, source);
      const chunks = [];
      for await (const chunk of input.Body) chunks.push(chunk);
      uploaded = Buffer.concat(chunks).toString();
    },
  });
  assert.equal(uploaded, "safe");
  assert.equal(q.list()[0].state, "complete");
});

test("legitimate folder markers, nested files and single-file selections upload after restart", async (t) => {
  const state = await fixture(t, storage.transfer);
  const folder = path.join(state.root, "selected");
  const single = path.join(state.root, "single.txt");
  await writeSource(path.join(folder, "nested", "file.txt"));
  await writeSource(single);
  await fs.mkdir(path.join(folder, "empty"));
  const id = await scan(state.q, [folder, single], { overwrite: true });
  state.q.db.close();
  state.q = new Queue(state.file, storage.transfer);
  const sent = new Map();
  await run(state.q, id, {
    async send(command) {
      assert.equal(command.constructor.name, "PutObjectCommand");
      sent.set(command.input.Key, command.input.Body.toString());
    },
    async upload(input) {
      const chunks = [];
      for await (const chunk of input.Body) chunks.push(chunk);
      sent.set(input.Key, Buffer.concat(chunks).toString());
    },
  });
  assert.deepEqual([...sent].sort(), [
    ["selected/", ""],
    ["selected/empty/", ""],
    ["selected/nested/", ""],
    ["selected/nested/file.txt", "safe"],
    ["single.txt", "safe"],
  ]);
  assert.equal(state.q.list()[0].done, 5);
  assert.equal(state.q.list()[0].failed, 0);
});
