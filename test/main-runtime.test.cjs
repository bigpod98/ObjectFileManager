const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { createRequire } = require("node:module");
const { Queue } = require("../src/queue.cjs");
const source = path.resolve(__dirname, "../src/main.cjs");
const requireMain = createRequire(source);

async function boot(
  t,
  { QueueClass, WorkspaceClass, loadError, profiles = [], clientFactory } = {},
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "main-runtime-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const errors = [],
    events = [],
    handlers = new Map();
  const app = new EventEmitter();
  Object.assign(app, {
    setName() {},
    getPath: () => root,
    getVersion: () => "test",
    requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(),
    quit: () => events.push("quit"),
  });
  let window;
  class BrowserWindow {
    constructor() {
      window = this;
      this.webContents = new EventEmitter();
      this.webContents.mainFrame = {
        url: require("node:url").pathToFileURL(
          path.resolve(__dirname, "../src/index.html"),
        ).href,
      };
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.session = { setPermissionRequestHandler() {} };
    }
    async loadFile() {
      if (loadError) throw Error(loadError);
      events.push("ready");
    }
  }
  const fakeQueue = class {
    async shutdown() {
      events.push("queue closed");
    }
    list() {
      return [];
    }
  };
  const fakeWorkspace = class {
    async close() {
      events.push("workspace closed");
    }
    list() {
      return [];
    }
  };
  class JsonFile {
    constructor(file) {
      this.file = file;
    }
    async load(fallback) {
      return this.file.endsWith("connections.json") ? profiles : fallback;
    }
    async save() {}
  }
  const mocks = {
    electron: {
      app,
      BrowserWindow,
      ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
      dialog: {
        showErrorBox: (title, message) => errors.push({ title, message }),
      },
      safeStorage: { isEncryptionAvailable: () => false },
      powerSaveBlocker: {
        start: () => 1,
        stop: () => events.push("blocker stopped"),
      },
    },
    "./queue.cjs": { Queue: QueueClass || fakeQueue },
    "./workspace.cjs": { Workspace: WorkspaceClass || fakeWorkspace },
    "./local-state.cjs": { ...requireMain("./local-state.cjs"), JsonFile },
    "./storage.cjs": { client: clientFactory || (() => ({})) },
  };
  const code = await fs.readFile(source, "utf8");
  const context = vm.createContext({
    require: (name) => mocks[name] || requireMain(name),
    __dirname: path.dirname(source),
    process,
    console,
  });
  const start = () => vm.runInContext(code, context, { filename: source });
  const waitFor = async (predicate) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail(
      `application did not settle: ${events}, ${JSON.stringify(errors)}`,
    );
  };
  const invoke = (name, ...args) =>
    handlers.get(name)(
      { sender: window.webContents, senderFrame: window.webContents.mainFrame },
      ...args,
    );
  return { root, start, waitFor, invoke, errors, events, app };
}

test("corrupt transfer DB produces an actionable startup error and preserves bytes", async (t) => {
  const f = await boot(t, { QueueClass: Queue });
  const file = path.join(f.root, "transfers.sqlite");
  const bytes = Buffer.from(
    "damaged database header with recoverable original data",
  );
  await fs.writeFile(file, bytes);
  f.start();
  await f.waitFor(() => f.events.includes("quit"));
  assert.match(f.errors[0].message, /Could not open transfer database/);
  assert.ok(f.errors[0].message.includes(file));
  assert.deepEqual(await fs.readFile(file), bytes);
});

test("startup window failure closes initialized workspace and database before quitting", async (t) => {
  const f = await boot(t, { loadError: "renderer failed to load" });
  f.start();
  await f.waitFor(() => f.events.includes("quit"));
  assert.match(f.errors[0].message, /renderer failed to load/);
  assert.deepEqual(f.events, ["workspace closed", "queue closed", "quit"]);
});

test("rejected workspace, database, and client closes do not interrupt remaining cleanup", async (t) => {
  const closed = [];
  const f = await boot(t, {
    QueueClass: class {
      async shutdown() {
        closed.push("database");
        throw Error("database close rejected");
      }
    },
    WorkspaceClass: class {
      constructor(queue, getClient, activity) {
        this.activity = activity;
      }
      async close() {
        closed.push("workspace");
        this.activity(true);
        throw Error("workspace close rejected");
      }
    },
    profiles: [{ id: "a" }, { id: "b" }],
    clientFactory: (profile) => ({
      capabilities: {},
      async destroy() {
        closed.push(profile.id);
        throw Error(`client ${profile.id} close rejected`);
      },
    }),
  });
  f.start();
  await f.waitFor(() => f.events.includes("ready"));
  assert.equal((await f.invoke("connection:capabilities", "a")).ok, true);
  assert.equal((await f.invoke("connection:capabilities", "b")).ok, true);
  let prevented = false;
  f.app.emit("before-quit", {
    preventDefault() {
      prevented = true;
    },
  });
  await f.waitFor(() => f.events.includes("quit"));
  assert.equal(prevented, true);
  assert.deepEqual(closed, ["workspace", "database", "a", "b"]);
  assert.ok(f.events.includes("blocker stopped"));
  assert.match(
    f.errors[0].message,
    /workspace close rejected[\s\S]*database close rejected[\s\S]*client a close rejected[\s\S]*client b close rejected/,
  );
});

test("capabilities resolve only for the selected connection and IPC exposes booleans", async (t) => {
  const resolved = [];
  const f = await boot(t, {
    profiles: [{ id: "adc" }, { id: "missing" }],
    clientFactory: (profile) => ({
      async resolveCapabilities() {
        resolved.push(profile.id);
        if (profile.id === "missing") throw Error("ADC missing");
        return {
          signedUrl: false,
          copy: true,
          private_key: "must never be sent",
        };
      },
    }),
  });
  f.start();
  await f.waitFor(() => f.events.includes("ready"));
  assert.deepEqual(resolved, []);
  const result = await f.invoke("connection:capabilities", "adc");
  assert.equal(result.ok, true);
  assert.equal(result.value.signedUrl, false);
  assert.equal(result.value.copy, true);
  assert.ok(
    Object.values(result.value).every((value) => typeof value === "boolean"),
  );
  assert.equal(Object.hasOwn(result.value, "private_key"), false);
  assert.deepEqual(resolved, ["adc"]);
  const missing = await f.invoke("connection:capabilities", "missing");
  assert.equal(missing.ok, false);
  assert.match(missing.error, /ADC missing/);
  assert.equal(f.events.includes("quit"), false);
});

test("a pending signing probe cannot block another connection or a location save", async (t) => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const resolved = [];
  const f = await boot(t, {
    profiles: [{ id: "slow" }, { id: "fast" }],
    clientFactory: (profile) => ({
      async resolveCapabilities() {
        resolved.push(profile.id);
        if (profile.id === "slow") await pending;
        return { signedUrl: true };
      },
    }),
  });
  f.start();
  await f.waitFor(() => f.events.includes("ready"));
  const slow = f.invoke("connection:capabilities", "slow");
  await f.waitFor(() => resolved.includes("slow"));
  let fast, location;
  const fastResult = f
    .invoke("connection:capabilities", "fast")
    .then((result) => {
      fast = result;
    });
  const savedLocation = f
    .invoke("locations:visit", { profile: "fast", bucket: "b", prefix: "" })
    .then((result) => {
      location = result;
    });
  try {
    await f.waitFor(() => fast && location);
    assert.equal(fast.ok, true);
    assert.equal(location.ok, true);
  } finally {
    release();
    await Promise.all([slow, fastResult, savedLocation]);
  }
});
