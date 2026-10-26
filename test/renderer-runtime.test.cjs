const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const vm = require("node:vm");

async function rendererSource() {
  return fs.readFile(path.join(__dirname, "../src/renderer.js"), "utf8");
}

test("queue polling slows for browser/hidden views and refreshes immediately on visibility", async () => {
  const source = await rendererSource();
  const timers = new Map(),
    listeners = new Map();
  let timerId = 0,
    calls = 0;
  const state = { view: "queue" },
    document = {
      hidden: false,
      addEventListener: (name, listener) => listeners.set(name, listener),
    };
  const context = vm.createContext({
    state,
    document,
    refreshJobs: async () => {
      calls++;
    },
    toast: (message) => assert.fail(message),
    setTimeout: (callback, delay) => {
      timers.set(++timerId, { callback, delay });
      return timerId;
    },
    clearTimeout: (id) => timers.delete(id),
  });
  vm.runInContext(
    source.slice(source.indexOf("let polling = false;")),
    context,
  );
  const next = () => {
    assert.equal(timers.size, 1);
    return [...timers.values()][0];
  };
  assert.equal(next().delay, 1200);
  await next().callback();
  assert.equal(calls, 1);
  assert.equal(next().delay, 1200);
  state.view = "browser";
  await next().callback();
  assert.equal(next().delay, 5000);
  document.hidden = true;
  await next().callback();
  assert.equal(next().delay, 15000);
  const backgroundCalls = calls;
  await next().callback();
  assert.equal(
    calls,
    backgroundCalls + 1,
    "background status continues to refresh",
  );
  document.hidden = false;
  listeners.get("visibilitychange")();
  assert.equal(next().delay, 0);
  state.view = "queue";
  await next().callback();
  assert.equal(next().delay, 1200);
});

test("queue polls never overlap and use current visibility after a slow request settles", async () => {
  const source = await rendererSource();
  const timers = new Map();
  let timerId = 0,
    calls = 0,
    resolve;
  const document = { hidden: false, addEventListener() {} };
  const context = vm.createContext({
    state: { view: "queue" },
    document,
    refreshJobs: () => {
      calls++;
      return new Promise((done) => {
        resolve = done;
      });
    },
    toast: (message) => assert.fail(message),
    setTimeout: (callback, delay) => {
      timers.set(++timerId, { callback, delay });
      return timerId;
    },
    clearTimeout: (id) => timers.delete(id),
  });
  vm.runInContext(
    source.slice(source.indexOf("let polling = false;")),
    context,
  );
  const pending = [...timers.values()][0].callback();
  await vm.runInContext("pollJobs()", context);
  vm.runInContext("scheduleQueuePoll()", context);
  assert.equal(calls, 1);
  assert.equal(timers.size, 0);
  document.hidden = true;
  resolve();
  await pending;
  assert.equal([...timers.values()][0].delay, 15000);
});

test("connection capability results update the selected profile and ignore stale connections", async () => {
  const source = await rendererSource();
  const start = source.indexOf("async function selectConnection(");
  const end = source.indexOf("\nasync function listBuckets(", start);
  const nodes = new Map();
  const node = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, { setAttribute() {} });
    return nodes.get(selector);
  };
  const requests = new Map(),
    opened = [];
  const state = {
    navigation: 0,
    request: 0,
    selection: new Map(),
    profiles: [
      {
        id: "first",
        name: "First",
        provider: "Google Cloud Storage",
        capabilities: { signedUrl: false },
      },
      {
        id: "second",
        name: "Second",
        provider: "Google Cloud Storage",
        capabilities: { signedUrl: false },
      },
    ],
  };
  const context = vm.createContext({
    state,
    $: node,
    api: {
      "connection:capabilities": (id) =>
        new Promise((resolve) => requests.set(id, resolve)),
    },
    renderConnections() {},
    view() {},
    renderFiles() {},
    storageNoun: () => "bucket",
    listBuckets: async () => opened.push(state.profile.id),
    openBucket: async () => assert.fail("unexpected bucket"),
    toast: (message) => assert.fail(message),
  });
  vm.runInContext(source.slice(start, end), context);
  const first = vm.runInContext('selectConnection("first")', context);
  const second = vm.runInContext('selectConnection("second")', context);
  requests.get("second")({ signedUrl: true });
  await second;
  requests.get("first")({ signedUrl: false });
  await first;
  assert.equal(state.profile.id, "second");
  assert.equal(state.profile.capabilities.signedUrl, true);
  assert.deepEqual(opened, ["second"]);
  const sameConnection = vm.runInContext('selectConnection("first")', context);
  // A bucket opened manually while its signer resolves must keep its location
  // and still receive the capability update for that selected connection.
  state.navigation++;
  state.bucket = "manually-opened";
  requests.get("first")({ signedUrl: true });
  await sameConnection;
  assert.equal(state.profile.capabilities.signedUrl, true);
  assert.equal(state.bucket, "manually-opened");
  assert.deepEqual(opened, ["second"]);
});
