const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { Readable } = require("node:stream");
const { plan, transfer } = require("../src/downloads.cjs");

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "s3-download-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
const item = (root, key = "file.txt", size = 5) => ({
  root,
  source: path.join(root, key),
  key,
  size,
  etag: '"first"',
  directory: false,
});
const object = (Key, Size = 5) => ({ Key, Size, ETag: '"first"' });
const signal = () => new AbortController().signal;

test("folder planning exhausts pagination, deduplicates overlaps and preserves relative paths", async (t) => {
  const root = await fixture(t);
  const requests = [];
  const s3 = {
    send: async (command) => {
      requests.push(command.input);
      if (command.constructor.name === "HeadObjectCommand")
        return { ContentLength: 5, ETag: '"first"' };
      return command.input.ContinuationToken
        ? { Contents: [object("base/dir/nested/b")], IsTruncated: false }
        : {
            Contents: [object("base/dir/", 0), object("base/dir/a")],
            IsTruncated: true,
            NextContinuationToken: "page2",
          };
    },
  };
  const entries = await plan(s3, {
    bucket: "bucket",
    prefix: "base/",
    destination: root,
    selection: [{ key: "base/dir/", folder: true }, { key: "base/dir/a" }],
  });
  assert.equal(entries.length, 3);
  assert.equal(entries[2].source, path.join(root, "dir/nested/b"));
  assert.equal(entries[0].directory, true);
  assert.equal(entries[1].etag, '"first"');
  assert.equal(requests[1].ContinuationToken, "page2");
});

test("unsafe and nonportable object names reject without creating paths", async (t) => {
  const root = await fixture(t);
  for (const key of [
    "../escape",
    "a/../../escape",
    "/absolute",
    "a\\b",
    "a//b",
    "C:bad",
    "nul.txt",
    "foo. ",
    "a/./b",
    "a\u0000b",
    ".objectfilemanager-stale.part",
  ]) {
    await assert.rejects(
      plan(
        { send: async () => ({ ContentLength: 5 }) },
        { bucket: "b", selection: [{ key }], destination: root },
      ),
      /unsafe|nonportable/,
    );
  }
  assert.deepEqual(await fs.readdir(root), []);
});

test("case, Unicode and file-directory collisions reject entire plans", async (t) => {
  const root = await fixture(t);
  for (const keys of [
    ["dir/A", "dir/a"],
    ["dir/A/x", "dir/a/y"],
    ["dir/file", "dir/file/child"],
    ["dir/é", "dir/e\u0301"],
  ]) {
    await assert.rejects(
      plan(
        { send: async () => ({ Contents: keys.map((key) => object(key)) }) },
        {
          bucket: "b",
          selection: [{ key: "dir/", folder: true }],
          destination: root,
        },
      ),
      /colliding/,
    );
  }
});

test("planning rejects malformed pagination and unexpected listing keys", async (t) => {
  const root = await fixture(t);
  await assert.rejects(
    plan(
      { send: async () => ({ IsTruncated: true }) },
      {
        bucket: "b",
        destination: root,
        selection: [{ key: "dir/", folder: true }],
      },
    ),
    /pagination/,
  );
  await assert.rejects(
    plan(
      { send: async () => ({ Contents: [object("elsewhere")] }) },
      {
        bucket: "b",
        destination: root,
        selection: [{ key: "dir/", folder: true }],
      },
    ),
    /outside/,
  );
});

test("symlink parents and destinations are rejected at planning and transfer", async (t) => {
  const root = await fixture(t);
  const outside = await fixture(t);
  await fs.symlink(outside, path.join(root, "dir"));
  const s3 = { send: async () => ({ ContentLength: 5 }) };
  await assert.rejects(
    plan(s3, {
      bucket: "b",
      destination: root,
      selection: [{ key: "dir/file" }],
    }),
    /symlink/,
  );
  await assert.rejects(
    transfer(s3, {}, item(root, "dir/file"), signal()),
    /symlink/,
  );
  await fs.symlink(path.join(outside, "file"), path.join(root, "file.txt"));
  await assert.rejects(
    transfer(s3, { overwrite: true }, item(root), signal()),
    /symlink/,
  );
  assert.deepEqual(await fs.readdir(outside), []);
});

test("download writes conditionally, throttles and reports progress; existing file skip avoids GET", async (t) => {
  const root = await fixture(t);
  const progress = [],
    throttle = [];
  let gets = 0;
  const s3 = {
    send: async (command, options) => {
      gets++;
      assert.equal(command.input.IfMatch, '"first"');
      assert.ok(options.abortSignal);
      return { Body: Readable.from([Buffer.from("he"), Buffer.from("llo")]) };
    },
  };
  assert.equal(
    await transfer(
      s3,
      { bucket: "b", throttle: async (bytes) => throttle.push(bytes) },
      item(root),
      signal(),
      (loaded) => progress.push(loaded),
    ),
    "done",
  );
  assert.equal(await fs.readFile(path.join(root, "file.txt"), "utf8"), "hello");
  assert.deepEqual(progress, [2, 5]);
  assert.deepEqual(throttle, [2, 3]);
  assert.equal(
    await transfer(s3, { bucket: "b" }, item(root), signal()),
    "skipped",
  );
  assert.equal(gets, 1);
  assert.deepEqual(await fs.readdir(root), ["file.txt"]);
});

test("failed and canceled replacements preserve original bytes and remove partial files", async (t) => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, "file.txt"), "original");
  await assert.rejects(
    transfer(
      { send: async () => ({ Body: Readable.from([Buffer.from("bad")]) }) },
      { bucket: "b", overwrite: true },
      item(root),
      signal(),
    ),
    /expected object size/,
  );
  assert.equal(
    await fs.readFile(path.join(root, "file.txt"), "utf8"),
    "original",
  );
  const controller = new AbortController();
  await assert.rejects(
    transfer(
      { send: async () => ({ Body: Readable.from([Buffer.from("hello")]) }) },
      {
        bucket: "b",
        overwrite: true,
        throttle: async () => controller.abort(),
      },
      item(root),
      controller.signal,
    ),
    { name: "AbortError" },
  );
  assert.equal(
    await fs.readFile(path.join(root, "file.txt"), "utf8"),
    "original",
  );
  assert.deepEqual(await fs.readdir(root), ["file.txt"]);
  await transfer(
    { send: async () => ({ Body: Readable.from([Buffer.from("hello")]) }) },
    { bucket: "b", overwrite: true },
    item(root),
    signal(),
  );
  assert.equal(await fs.readFile(path.join(root, "file.txt"), "utf8"), "hello");
});

test("source precondition failure leaves existing destination intact", async (t) => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, "file.txt"), "original");
  await assert.rejects(
    transfer(
      {
        send: async () => {
          throw new Error("PreconditionFailed");
        },
      },
      { bucket: "b", overwrite: true },
      item(root),
      signal(),
    ),
    /PreconditionFailed/,
  );
  assert.deepEqual(await fs.readdir(root), ["file.txt"]);
  assert.equal(
    await fs.readFile(path.join(root, "file.txt"), "utf8"),
    "original",
  );
});

test("concurrent destination creation is skipped without overwriting", async (t) => {
  const root = await fixture(t);
  const s3 = {
    send: async () => {
      await fs.writeFile(path.join(root, "file.txt"), "concurrent");
      return { Body: Readable.from([Buffer.from("hello")]) };
    },
  };
  assert.equal(
    await transfer(s3, { bucket: "b" }, item(root), signal()),
    "skipped",
  );
  assert.equal(
    await fs.readFile(path.join(root, "file.txt"), "utf8"),
    "concurrent",
  );
});

test("directory markers create nested folders; malicious persisted paths reject", async (t) => {
  const root = await fixture(t);
  await transfer(
    {},
    {},
    { ...item(root, "a/b", 0), directory: true },
    signal(),
  );
  assert.ok((await fs.stat(path.join(root, "a/b"))).isDirectory());
  await assert.rejects(
    transfer(
      {},
      {},
      { ...item(root), source: path.resolve(root, "../escape") },
      signal(),
    ),
    /unsafe/,
  );
});

test("restart discards a stale partial file and downloads the full object", async (t) => {
  const root = await fixture(t);
  const { createHash } = require("node:crypto");
  const hash = createHash("sha256")
    .update(`${root}\0file.txt`)
    .digest("hex")
    .slice(0, 32);
  const temporary = path.join(root, `.objectfilemanager-${hash}.part`);
  await fs.writeFile(temporary, "stale partial from interrupted process");
  await transfer(
    { send: async () => ({ Body: Readable.from([Buffer.from("hello")]) }) },
    { bucket: "b" },
    item(root),
    signal(),
  );
  assert.equal(await fs.readFile(path.join(root, "file.txt"), "utf8"), "hello");
  assert.deepEqual(await fs.readdir(root), ["file.txt"]);
});

test("missing list ETag is resolved with HEAD; missing source snapshots fail", async (t) => {
  const root = await fixture(t);
  const requests = [];
  const s3 = {
    send: async (command) => {
      requests.push(command.constructor.name);
      return command.constructor.name === "HeadObjectCommand"
        ? { ContentLength: 5, ETag: '"snapshot"' }
        : { Contents: [{ Key: "dir/a", Size: 5 }] };
    },
  };
  const entries = await plan(s3, {
    bucket: "b",
    destination: root,
    selection: [{ key: "dir/", folder: true }],
  });
  assert.equal(entries[0].etag, '"snapshot"');
  assert.deepEqual(requests, ["ListObjectsV2Command", "HeadObjectCommand"]);
  await assert.rejects(
    transfer(s3, {}, { ...item(root), etag: null }, signal()),
    /ETag/,
  );
});

const downloadable = () => ({
  send: async () => ({ Body: Readable.from([Buffer.from("hello")]) }),
});

test("unsupported hard links fall back to exclusive verified publication", async (t) => {
  for (const code of ["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV"]) {
    await t.test(code, async (t) => {
      const root = await fixture(t);
      t.mock.method(fs, "link", async () => {
        throw Object.assign(new Error("Unsupported"), { code });
      });
      assert.equal(
        await transfer(downloadable(), { bucket: "b" }, item(root), signal()),
        "done",
      );
      assert.equal(
        await fs.readFile(path.join(root, "file.txt"), "utf8"),
        "hello",
      );
      assert.deepEqual(await fs.readdir(root), ["file.txt"]);
    });
  }
});

test("fallback does not replace a concurrently created destination", async (t) => {
  const root = await fixture(t);
  t.mock.method(fs, "link", async () => {
    await fs.writeFile(path.join(root, "file.txt"), "concurrent");
    throw Object.assign(new Error("Unsupported"), { code: "ENOTSUP" });
  });
  assert.equal(
    await transfer(downloadable(), { bucket: "b" }, item(root), signal()),
    "skipped",
  );
  assert.equal(
    await fs.readFile(path.join(root, "file.txt"), "utf8"),
    "concurrent",
  );
  assert.deepEqual(await fs.readdir(root), ["file.txt"]);
});

test("fallback cancellation and write failure remove owned partial destinations", async (t) => {
  for (const mode of ["cancel", "failure", "replacement"]) {
    await t.test(mode, async (t) => {
      const root = await fixture(t);
      const destination = path.join(root, "file.txt");
      const controller = new AbortController();
      const open = fs.open;
      t.mock.method(fs, "link", async () => {
        throw Object.assign(new Error("Unsupported"), { code: "ENOTSUP" });
      });
      t.mock.method(fs, "open", async (filename, ...args) => {
        const handle = await open(filename, ...args);
        if (
          filename === destination &&
          args[0] & require("node:fs").constants.O_EXCL
        ) {
          const write = handle.writeFile.bind(handle);
          t.mock.method(handle, "writeFile", async (buffer) => {
            await write(buffer.subarray(0, 2));
            if (mode === "cancel") controller.abort();
            else {
              if (mode === "replacement") {
                await fs.rename(destination, destination + ".original-partial");
                await fs.writeFile(destination, "concurrent");
              }
              throw Object.assign(new Error("Disk write failed"), {
                code: "EIO",
              });
            }
          });
        }
        return handle;
      });
      await assert.rejects(
        transfer(
          downloadable(),
          { bucket: "b" },
          item(root),
          controller.signal,
        ),
        mode === "cancel" ? { name: "AbortError" } : /Disk write failed/,
      );
      if (mode === "replacement") {
        assert.equal(await fs.readFile(destination, "utf8"), "concurrent");
        assert.deepEqual((await fs.readdir(root)).sort(), [
          "file.txt",
          "file.txt.original-partial",
        ]);
      } else assert.deepEqual(await fs.readdir(root), []);
    });
  }
});

test("a process crash cannot turn a partial fallback publication into a successful skip", async (t) => {
  const { execFile } = require("node:child_process");
  const execute = require("node:util").promisify(execFile);
  for (const phase of ["partial", "complete", "different-profile"]) {
    await t.test(phase, async (t) => {
      const root = await fixture(t);
      const entry = item(root);
      const job = { profile: "original-connection", bucket: "b" };
      const script = `
        const fs = require('node:fs/promises');
        const { Readable } = require('node:stream');
        const { transfer } = require(${JSON.stringify(require.resolve("../src/downloads.cjs"))});
        const entry = ${JSON.stringify(entry)};
        fs.link = async () => { throw Object.assign(new Error('Unsupported'), {code: 'ENOTSUP'}); };
        const open = fs.open;
        const unlink = fs.unlink;
        if (${JSON.stringify(phase)} === 'partial') fs.open = async (filename, ...args) => {
          const handle = await open(filename, ...args);
          if (filename === entry.source && args[0] & require('node:fs').constants.O_EXCL) {
            const write = handle.writeFile.bind(handle);
            handle.writeFile = async buffer => { await write(buffer.subarray(0, 2)); process.exit(77); };
          }
          return handle;
        };
        else fs.unlink = async filename => { if (filename.endsWith('.publish')) process.exit(77); return unlink(filename); };
        transfer({send: async () => ({Body: Readable.from([Buffer.from('hello')])})}, ${JSON.stringify(job)}, entry, new AbortController().signal).catch(error => { console.error(error); process.exit(1); });
      `;
      await assert.rejects(execute(process.execPath, ["-e", script]), {
        code: 77,
      });
      assert.ok(
        (await fs.readdir(root)).some((name) => name.endsWith(".publish")),
      );
      if (phase === "partial") {
        await assert.rejects(
          transfer(downloadable(), job, entry, signal()),
          /Unfinished download publication/,
        );
        assert.equal(await fs.readFile(entry.source, "utf8"), "he");
        // Removing the ambiguous partial file explicitly permits a fresh retry.
        await fs.unlink(entry.source);
        assert.equal(
          await transfer(downloadable(), job, entry, signal()),
          "done",
        );
      } else {
        if (phase === "different-profile") {
          // The same bucket/key/opaque ETag on another connection is not the
          // same remote object, even when the completed local bytes match.
          await assert.rejects(
            transfer(
              downloadable(),
              { ...job, profile: "other-connection" },
              entry,
              signal(),
            ),
            /Unfinished download publication/,
          );
          assert.ok(
            (await fs.readdir(root)).some((name) => name.endsWith(".publish")),
          );
          assert.equal(await fs.readFile(entry.source, "utf8"), "hello");
        }
        assert.equal(
          await transfer(
            {
              send: async () => {
                throw new Error("No GET needed");
              },
            },
            job,
            entry,
            signal(),
          ),
          "done",
        );
      }
      assert.equal(await fs.readFile(entry.source, "utf8"), "hello");
      assert.ok(
        !(await fs.readdir(root)).some((name) => name.endsWith(".publish")),
      );
      assert.deepEqual(await fs.readdir(root), ["file.txt"]);
    });
  }
});

test("fallback rejects temporary content changes and destination symlink races", async (t) => {
  for (const mode of ["temporary", "symlink"]) {
    await t.test(mode, async (t) => {
      const root = await fixture(t);
      const outside = await fixture(t);
      const destination = path.join(root, "file.txt");
      const external = path.join(outside, "external");
      await fs.writeFile(external, "keep me");
      const open = fs.open;
      let temporary;
      t.mock.method(fs, "link", async (source) => {
        temporary = source;
        if (mode === "symlink") await fs.symlink(external, destination);
        throw Object.assign(new Error("Unsupported"), { code: "ENOTSUP" });
      });
      t.mock.method(fs, "open", async (filename, ...args) => {
        const handle = await open(filename, ...args);
        if (
          filename === destination &&
          args[0] & require("node:fs").constants.O_EXCL
        )
          await fs.writeFile(temporary, "other");
        return handle;
      });
      await assert.rejects(
        transfer(downloadable(), { bucket: "b" }, item(root), signal()),
        mode === "temporary" ? /changed during publication/ : /symlink/,
      );
      assert.equal(await fs.readFile(external, "utf8"), "keep me");
      if (mode === "temporary") assert.deepEqual(await fs.readdir(root), []);
      else assert.ok((await fs.lstat(destination)).isSymbolicLink());
    });
  }
});
