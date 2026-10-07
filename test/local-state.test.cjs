const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const local = require("../src/local-state.cjs");
const { restoreProfile, serializeProfile } = require("../src/profiles.cjs");
const safeStorage = {
  encryptString: (s) => Buffer.from(s),
  decryptString: (b) => b.toString(),
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => "test",
};
const stored = (id) => ({
  id,
  name: id,
  provider: "OpenStack Swift",
  endpoint: "https://swift.example/v1/account",
  remember: true,
  credentials: Buffer.from(
    JSON.stringify({ swiftToken: `token-${id}` }),
  ).toString("base64"),
});
async function directory(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "s3-local-state-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
for (const content of [
  '[{"credentials":"recover-me"}',
  '{"connections":[{"credentials":"recover-me"}]}',
  "null",
]) {
  test(`corrupt connections are preserved before replacement: ${content.slice(0, 20)}`, async (t) => {
    const dir = await directory(t),
      target = path.join(dir, "connections.json");
    await fs.writeFile(target, content);
    const file = new local.JsonFile(target);
    assert.deepEqual(
      await file.load([], (data) => local.decodeProfiles(data, safeStorage)),
      [],
    );
    await file.save([stored("new")]);
    const backup = (await fs.readdir(dir)).find((name) =>
      name.includes(".corrupt-"),
    );
    assert.equal(await fs.readFile(path.join(dir, backup), "utf8"), content);
    assert.equal((await fs.stat(path.join(dir, backup))).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await fs.readFile(target)), [stored("new")]);
  });
}
test("mixed malformed entries and duplicate IDs preserve all originals and retain valid locked profiles", async (t) => {
  const dir = await directory(t),
    target = path.join(dir, "connections.json");
  const entries = [
    stored("first"),
    null,
    42,
    { ...stored("bad"), bucket: [] },
    stored("first"),
    { ...stored("locked"), credentials: "opaque ciphertext" },
  ];
  const content = JSON.stringify(entries);
  await fs.writeFile(target, content);
  const file = new local.JsonFile(target);
  const loaded = await file.load([], (data) =>
    local.decodeProfiles(data, safeStorage),
  );
  assert.deepEqual(
    loaded.map((p) => p.id),
    ["first", "locked"],
  );
  assert.equal(loaded[1].locked, true);
  await file.save(local.encodeProfiles(loaded, safeStorage));
  assert.deepEqual(JSON.parse(await fs.readFile(target))[1], entries[5]);
  const backup = (await fs.readdir(dir)).find((name) =>
    name.includes(".corrupt-"),
  );
  assert.equal(await fs.readFile(path.join(dir, backup), "utf8"), content);
});
test("backup failure and unreadable input block all saving; restarting after repair recovers", async (t) => {
  const dir = await directory(t),
    target = path.join(dir, "connections.json");
  await fs.writeFile(target, "recover-me");
  const file = new local.JsonFile(target, {
    io: {
      ...fs,
      writeFile: async () => {
        throw new Error("disk full");
      },
    },
  });
  await file.load([], (data) => local.decodeProfiles(data, safeStorage));
  await assert.rejects(file.save([]), /backup/);
  assert.equal(await fs.readFile(target, "utf8"), "recover-me");
  const unreadable = new local.JsonFile(target, {
    io: {
      ...fs,
      readFile: async () => {
        throw new Error("denied");
      },
    },
  });
  await unreadable.load([], local.decodeLocations);
  await assert.rejects(unreadable.save([]), /could not be read/);
  const restarted = new local.JsonFile(target);
  await restarted.load([], (data) => local.decodeProfiles(data, safeStorage));
  await restarted.save([stored("recovered")]);
  assert.deepEqual(JSON.parse(await fs.readFile(target)), [
    stored("recovered"),
  ]);
});
test("malformed decrypted credentials remain locked and are never re-encrypted as empty credentials", () => {
  for (const data of [null, [], "secret", { swiftToken: 42 }]) {
    const entry = {
      ...stored("bad"),
      credentials: Buffer.from(JSON.stringify(data)).toString("base64"),
    };
    const profile = restoreProfile(entry, safeStorage);
    assert.equal(profile.locked, true);
    assert.deepEqual(serializeProfile(profile, safeStorage), entry);
  }
});
test("location schemas recover valid entries and reject malformed IPC input", () => {
  const valid = { profile: "p", bucket: "b", prefix: "" };
  for (const bad of [null, [], 2, { bookmarks: {}, recent: null }]) {
    assert.deepEqual(local.decodeLocations(bad), {
      value: { bookmarks: [], recent: [] },
      invalid: true,
    });
  }
  assert.deepEqual(
    local.decodeLocations({
      bookmarks: [null, valid, { ...valid, prefix: 7 }],
      recent: [valid],
    }),
    { value: { bookmarks: [valid], recent: [valid] }, invalid: true },
  );
  for (const bad of [
    null,
    [],
    {},
    { ...valid, bucket: 1 },
    { ...valid, prefix: false },
  ])
    assert.throws(() => local.cleanLocation(bad), /saved location/);
});

async function mainFixture(t, initial = [stored("swift")]) {
  const dir = await directory(t);
  await fs.writeFile(
    path.join(dir, "connections.json"),
    JSON.stringify(initial),
  );
  const handlers = new Map(),
    errors = [];
  let ready, window;
  let failures = [];
  const io = {
    ...fs,
    rename: async (from, to) => {
      if (path.basename(to) === failures[0]) {
        failures.shift();
        throw new Error("injected persistence failure");
      }
      return fs.rename(from, to);
    },
  };
  class TestFile extends local.JsonFile {
    constructor(target, options) {
      super(target, { ...options, io });
    }
  }
  const electron = {
    app: {
      setName() {},
      requestSingleInstanceLock: () => true,
      whenReady: () => ({
        then: (fn) => {
          ready = fn();
        },
      }),
      getPath: () => dir,
      on() {},
      getVersion: () => "test",
    },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    dialog: { showErrorBox: (...args) => errors.push(args) },
    safeStorage,
    BrowserWindow: class {
      constructor() {
        window = this;
        this.webContents = {
          mainFrame: {
            url: require("node:url").pathToFileURL(
              path.resolve("src/index.html"),
            ).href,
          },
          setWindowOpenHandler() {},
          on() {},
          session: { setPermissionRequestHandler() {} },
        };
      }
      async loadFile() {}
    },
  };
  const realRequire = createRequire(path.resolve("src/main.cjs"));
  const stubs = {
    electron,
    "./local-state.cjs": { ...local, JsonFile: TestFile },
    "./queue.cjs": { Queue: class {} },
    "./workspace.cjs": {
      Workspace: class {
        list() {
          return [];
        }
      },
    },
    "./storage.cjs": { client: () => ({ destroy() {} }) },
    "./downloads.cjs": {},
    "./operations.cjs": {},
    "./object-tools.cjs": {},
  };
  vm.runInNewContext(await fs.readFile(path.resolve("src/main.cjs"), "utf8"), {
    require: (name) =>
      Object.hasOwn(stubs, name) ? stubs[name] : realRequire(name),
    __dirname: path.resolve("src"),
    process,
    Buffer,
    console,
  });
  await ready;
  return {
    dir,
    errors,
    handlers,
    fail(target, count = 1) {
      failures = Array(count).fill(target);
    },
    failSequence(targets) {
      failures = [...targets];
    },
    async call(name, ...args) {
      const result = await handlers.get(name)(
        {
          sender: window.webContents,
          senderFrame: window.webContents.mainFrame,
        },
        ...args,
      );
      // Normalize objects from the VM realm for strict comparisons.
      return JSON.parse(JSON.stringify(result));
    },
    async disk(name = "connections.json") {
      return JSON.parse(await fs.readFile(path.join(dir, name), "utf8"));
    },
  };
}
const add = (name) => ({
  name,
  provider: "Amazon S3",
  accessKeyId: "key",
  secretAccessKey: "secret",
  remember: true,
});
test("main serializes concurrent add, refresh and remove, recovers after failed persistence", async (t) => {
  const app = await mainFixture(t);
  app.fail("connections.json");
  const results = await Promise.all([
    app.call("connection:add", add("failed")),
    app.call("connection:add", add("kept")),
    app.call("connection:refresh-swift", { id: "swift", token: "new-token" }),
    app.call("connection:remove", "swift"),
    app.call("connection:add", add("last")),
  ]);
  assert.deepEqual(
    results.map((r) => r.ok),
    [false, true, true, true, true],
  );
  assert.deepEqual(
    (await app.disk()).map((p) => p.name),
    ["kept", "last"],
  );
  assert.deepEqual(
    (await app.call("init")).value.profiles.map((p) => p.name),
    ["kept", "last"],
  );
  assert.equal(
    (await fs.readdir(app.dir)).some((name) => name.endsWith(".tmp")),
    false,
  );
  assert.equal(app.handlers.has("download"), false);
});
test("failed refresh and removal leave previous profiles intact and subsequent mutations succeed", async (t) => {
  const app = await mainFixture(t);
  app.fail("connections.json", 2);
  const results = await Promise.all([
    app.call("connection:refresh-swift", {
      id: "swift",
      token: "failed-token",
    }),
    app.call("connection:remove", "swift"),
    app.call("connection:add", add("kept")),
  ]);
  assert.deepEqual(
    results.map((r) => r.ok),
    [false, false, true],
  );
  const disk = await app.disk();
  assert.deepEqual(
    disk.map((p) => p.name),
    ["swift", "kept"],
  );
  assert.equal(restoreProfile(disk[0], safeStorage).swiftToken, "token-swift");
});
test("connection deletion removes saved locations and queued visits cannot resurrect them", async (t) => {
  const app = await mainFixture(t);
  const location = { profile: "swift", bucket: "bucket", prefix: "prefix/" };
  await app.call("locations:bookmark", location);
  await app.call("locations:visit", location);
  const results = await Promise.all([
    app.call("connection:remove", "swift"),
    app.call("locations:visit", location),
  ]);
  assert.deepEqual(
    results.map((r) => r.ok),
    [true, false],
  );
  assert.deepEqual((await app.call("locations:get")).value, {
    bookmarks: [],
    recent: [],
  });
  assert.deepEqual(await app.disk("locations.json"), {
    bookmarks: [],
    recent: [],
  });
});
test("failed location persistence keeps memory unchanged and prevents incomplete deletion", async (t) => {
  const app = await mainFixture(t);
  const location = { profile: "swift", bucket: "bucket" };
  app.fail("locations.json");
  assert.equal((await app.call("locations:bookmark", location)).ok, false);
  assert.deepEqual((await app.call("locations:get")).value.bookmarks, []);
  assert.equal((await app.call("locations:bookmark", location)).ok, true);
  app.fail("locations.json");
  assert.equal((await app.call("connection:remove", "swift")).ok, false);
  assert.equal((await app.disk()).length, 1);
  assert.equal((await app.call("locations:get")).value.bookmarks.length, 1);
});

test("a failed profile deletion restores bookmarks and recent locations", async (t) => {
  const app = await mainFixture(t);
  const location = { profile: "swift", bucket: "bucket", prefix: "" };
  await app.call("locations:bookmark", location);
  await app.call("locations:visit", location);
  app.fail("connections.json");
  assert.equal((await app.call("connection:remove", "swift")).ok, false);
  const expected = { bookmarks: [location], recent: [location] };
  assert.deepEqual(await app.disk("locations.json"), expected);
  assert.deepEqual((await app.call("locations:get")).value, expected);
  assert.equal((await app.disk()).length, 1);
  assert.equal(
    (await fs.readdir(app.dir)).some((name) => name.includes(".recovery-")),
    false,
  );
});

test("failed bookmark rollback preserves a recovery file and later requests still work", async (t) => {
  const app = await mainFixture(t);
  const location = { profile: "swift", bucket: "bucket", prefix: "" };
  await app.call("locations:bookmark", location);
  app.failSequence(["connections.json", "locations.json"]);
  const result = await app.call("connection:remove", "swift");
  assert.equal(result.ok, false);
  assert.match(result.error, /recover them from/);
  const backup = (await fs.readdir(app.dir)).find((name) =>
    name.includes(".recovery-"),
  );
  assert.ok(backup);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(app.dir, backup))), {
    bookmarks: [location],
    recent: [],
  });
  assert.equal((await app.disk()).length, 1);
  assert.equal(
    (await app.call("connection:add", add("after failure"))).ok,
    true,
  );
});

test("invalid saved locations are preserved byte-for-byte before writing valid entries", async (t) => {
  const dir = await directory(t),
    target = path.join(dir, "locations.json");
  const original =
    '{"bookmarks":[null,{"profile":"p","bucket":"b"}],"recent":42}';
  await fs.writeFile(target, original);
  const file = new local.JsonFile(target);
  const loaded = await file.load(
    { bookmarks: [], recent: [] },
    local.decodeLocations,
  );
  await file.save(loaded);
  assert.deepEqual(loaded, {
    bookmarks: [{ profile: "p", bucket: "b", prefix: "" }],
    recent: [],
  });
  const backup = (await fs.readdir(dir)).find((name) =>
    name.includes(".corrupt-"),
  );
  assert.equal(await fs.readFile(path.join(dir, backup), "utf8"), original);
});
