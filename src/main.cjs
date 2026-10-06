const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  safeStorage,
  powerSaveBlocker,
  clipboard,
} = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { randomUUID } = require("node:crypto");
const { Queue } = require("./queue.cjs");
const storage = require("./storage.cjs");
const downloads = require("./downloads.cjs");
const operations = require("./operations.cjs");
const objectTools = require("./object-tools.cjs");
const { Workspace } = require("./workspace.cjs");
const {
  normalizeProfile,
  publicProfile,
  serializeProfile,
  restoreProfile,
  refreshSwiftToken,
} = require("./profiles.cjs");
const refreshingProfiles = new Set();
let win,
  queue,
  workspace,
  profiles = [],
  clients = new Map(),
  blocker,
  quitting = false;
const page = pathToFileURL(path.join(__dirname, "index.html")).href;
const profilePath = () =>
  path.join(app.getPath("userData"), "connections.json");
const secure = () =>
  safeStorage.isEncryptionAvailable() &&
  (process.platform !== "linux" ||
    safeStorage.getSelectedStorageBackend() !== "basic_text");
function publicProfiles() {
  return profiles.map(publicProfile);
}
function getClient(id) {
  if (refreshingProfiles.has(id))
    throw new Error("Wait for this connection’s token refresh to finish.");
  if (clients.has(id)) return clients.get(id);
  const p = profiles.find((p) => p.id === id);
  if (!p) throw new Error("Connection not found.");
  if (p.locked)
    throw new Error(
      "Unlock your operating system keyring and restart S3 Browser to use this saved connection.",
    );
  const c = storage.client(p);
  clients.set(id, c);
  return c;
}
async function persistProfiles() {
  const data = profiles
    .filter((p) => p.remember)
    .map((p) => serializeProfile(p, safeStorage));
  const target = profilePath();
  await fs.writeFile(`${target}.tmp`, JSON.stringify(data), { mode: 0o600 });
  await fs.rename(`${target}.tmp`, target);
}
function handle(name, fn) {
  ipcMain.handle(name, async (event, ...args) => {
    if (
      event.sender !== win.webContents ||
      event.senderFrame !== win.webContents.mainFrame ||
      event.senderFrame.url !== page
    )
      throw new Error("Unauthorized request");
    try {
      return { ok: true, value: await fn(...args) };
    } catch (e) {
      return { ok: false, error: e.message || "Operation failed" };
    }
  });
}
if (!app.requestSingleInstanceLock()) app.quit();
else
  app.whenReady().then(async () => {
    await fs.mkdir(app.getPath("userData"), { recursive: true, mode: 0o700 });
    try {
      profiles = JSON.parse(await fs.readFile(profilePath(), "utf8")).map((p) =>
        restoreProfile(p, safeStorage),
      );
    } catch (e) {
      if (e.code !== "ENOENT")
        dialog.showErrorBox("Could not read connections", e.message);
    }
    queue = new Queue(
      path.join(app.getPath("userData"), "transfers.sqlite"),
      (client, job, entry, signal, progress) =>
        (job.kind === "download" ? downloads.transfer : storage.transfer)(
          client,
          job,
          entry,
          signal,
          progress,
        ),
    );
    workspace = new Workspace(queue, getClient, (active) => {
      if (active && blocker === undefined)
        blocker = powerSaveBlocker.start("prevent-app-suspension");
      if (!active && blocker !== undefined) {
        powerSaveBlocker.stop(blocker);
        blocker = undefined;
      }
    });
    const locationsPath = path.join(app.getPath("userData"), "locations.json");
    let locations = { bookmarks: [], recent: [] };
    try {
      locations = JSON.parse(await fs.readFile(locationsPath, "utf8"));
    } catch (e) {
      if (e.code !== "ENOENT")
        dialog.showErrorBox("Could not read saved locations", e.message);
    }
    const locationKey = (l) =>
      JSON.stringify([l.profile, l.bucket, l.prefix || ""]);
    let locationsWrite = Promise.resolve();
    const saveLocations = () => {
      const data = JSON.stringify(locations);
      locationsWrite = locationsWrite
        .catch(() => {})
        .then(async () => {
          await fs.writeFile(`${locationsPath}.tmp`, data, { mode: 0o600 });
          await fs.rename(`${locationsPath}.tmp`, locationsPath);
        });
      return locationsWrite;
    };
    handle("locations:get", () => locations);
    handle("locations:bookmark", async (location) => {
      getClient(location.profile);
      const clean = {
        profile: location.profile,
        bucket: location.bucket,
        prefix: location.prefix || "",
      };
      const key = locationKey(clean);
      if (locations.bookmarks.some((l) => locationKey(l) === key))
        locations.bookmarks = locations.bookmarks.filter(
          (l) => locationKey(l) !== key,
        );
      else locations.bookmarks.push(clean);
      await saveLocations();
      return locations;
    });
    handle("locations:visit", async (location) => {
      getClient(location.profile);
      const clean = {
        profile: location.profile,
        bucket: location.bucket,
        prefix: location.prefix || "",
      };
      locations.recent = [
        clean,
        ...locations.recent.filter(
          (l) => locationKey(l) !== locationKey(clean),
        ),
      ].slice(0, 20);
      await saveLocations();
      return locations;
    });
    handle("init", () => ({
      profiles: publicProfiles(),
      secure: secure(),
      version: app.getVersion(),
    }));
    handle("connection:add", async (p) => {
      const profile = { ...normalizeProfile(p), id: randomUUID() };
      if (p.remember && !secure())
        throw new Error(
          "A secure OS keyring is unavailable. Uncheck “Remember credentials” to connect for this session.",
        );
      profiles.push(profile);
      try {
        await persistProfiles();
      } catch (e) {
        profiles.pop();
        throw e;
      }
      return publicProfiles();
    });
    handle("connection:refresh-swift", async ({ id, token } = {}) => {
      if (refreshingProfiles.has(id))
        throw new Error("Wait for this connection’s token refresh to finish.");
      const previous = profiles.find((p) => p.id === id);
      const updated = refreshSwiftToken(previous, token);
      if (updated.remember && !secure())
        throw new Error(
          "Unlock your operating system keyring before saving a refreshed token.",
        );
      if (
        workspace
          .list()
          .some(
            (job) =>
              job.profile === id &&
              (job.state === "running" ||
                job.id === workspace.activeRun?.id ||
                job.id === queue.running?.id),
          )
      )
        throw new Error(
          "Pause this connection’s active transfer batch before refreshing its token.",
        );
      refreshingProfiles.add(id);
      profiles = profiles.map((p) => (p.id === id ? updated : p));
      try {
        await persistProfiles();
      } catch (error) {
        profiles = profiles.map((p) => (p.id === id ? previous : p));
        throw error;
      } finally {
        refreshingProfiles.delete(id);
      }
      clients.get(id)?.destroy();
      clients.delete(id);
      return publicProfiles();
    });
    handle("connection:remove", async (id) => {
      if (refreshingProfiles.has(id))
        throw new Error("Wait for this connection’s token refresh to finish.");
      if (
        workspace
          .list()
          .some((j) => j.profile === id && !["complete"].includes(j.state))
      )
        throw new Error("Remove unfinished batches for this connection first.");
      const previous = profiles;
      profiles = profiles.filter((p) => p.id !== id);
      try {
        await persistProfiles();
      } catch (e) {
        profiles = previous;
        throw e;
      }
      clients.get(id)?.destroy();
      clients.delete(id);
      return publicProfiles();
    });
    handle(
      "buckets",
      async (id) =>
        (
          await getClient(id).send(new storage.ListBucketsCommand({}))
        ).Buckets?.map((b) => b.Name) || [],
    );
    handle("browse", (id, bucket, prefix, token) =>
      storage.browse(getClient(id), bucket, prefix, token),
    );
    handle("scan", async (options) => {
      getClient(options.profile);
      const result = await dialog.showOpenDialog(win, {
        title: options.folder
          ? "Choose a folder to upload, including its name"
          : "Choose files to upload",
        properties: options.folder
          ? ["openDirectory"]
          : ["openFile", "multiSelections"],
      });
      if (result.canceled) return null;
      return queue.scan({ ...options, sources: result.filePaths });
    });
    handle("jobs", () => workspace.list());
    handle("entries", (id, filter, offset) =>
      queue.entries(id, filter, offset),
    );
    handle("start", (id) => workspace.start(id));
    handle("pause", () => workspace.pause());
    handle("retry", (id) => workspace.retry(id));
    handle("remove", (id) => workspace.remove(id));
    handle("queue:configure", (id, options) => queue.configure(id, options));
    handle("queue:cancel", (id) => workspace.cancel(id));
    handle("queue:auto", (enabled) => {
      workspace.auto = !!enabled;
      return workspace.auto;
    });
    handle("queue:status", () => ({ auto: workspace.auto }));
    handle("queue:export", async (id) => {
      const report = queue.failureReport(id);
      const cleanup = queue.db
        .prepare("SELECT error FROM sync_runs WHERE job=? AND state='failed'")
        .get(id);
      if (cleanup)
        report.push({
          state: "failed",
          stage: "sync cleanup",
          error: cleanup.error,
        });
      const result = await dialog.showSaveDialog(win, {
        defaultPath: `s3-browser-failures-${id}.json`,
        filters: [{ name: "JSON report", extensions: ["json"] }],
      });
      if (result.canceled) return false;
      await fs.writeFile(result.filePath, JSON.stringify(report, null, 2), {
        mode: 0o600,
      });
      return true;
    });
    handle("download:queue", async (options) => {
      const client = getClient(options.profile);
      const result = await dialog.showOpenDialog(win, {
        title: "Choose download destination",
        properties: ["openDirectory", "createDirectory"],
      });
      if (result.canceled) return null;
      const entries = await downloads.plan(client, {
        ...options,
        destination: result.filePaths[0],
      });
      return queue.createJob({ ...options, entries, kind: "download" });
    });
    handle("folder:create", (options) =>
      operations.createFolder(
        getClient(options.profile),
        options.bucket,
        options.prefix,
      ),
    );
    handle("operations:preview", (options) => workspace.preview(options));
    handle("operations:execute", (token) => workspace.execute(token));
    const generatedUrls = new Set();
    handle("objects:url", async (options) => {
      const url = await objectTools.signedUrl(
        getClient(options.profile),
        options,
      );
      if (generatedUrls.size >= 100)
        generatedUrls.delete(generatedUrls.values().next().value);
      generatedUrls.add(url);
      return url;
    });
    handle("objects:copy-url", ({ url }) => {
      if (!generatedUrls.has(url))
        throw new Error("Generate a download link before copying it.");
      clipboard.writeText(url);
      return true;
    });
    const objectMethods = {
      search: "search",
      details: "details",
      versions: "versions",
      restore: "restore",
      metadata: "metadata",
      multipart: "multipart",
      abort: "abortMultipart",
    };
    for (const [channel, method] of Object.entries(objectMethods))
      handle(`objects:${channel}`, (options) =>
        objectTools[method](getClient(options.profile), options),
      );
    handle("sync:compare", async (options) => {
      getClient(options.profile);
      const result = await dialog.showOpenDialog(win, {
        title: "Choose folder to compare with this remote prefix",
        properties: ["openDirectory"],
      });
      if (result.canceled) return null;
      return workspace.compare({ ...options, source: result.filePaths[0] });
    });
    handle("sync:apply", (token) => workspace.apply(token));
    handle("download", async (id, bucket, key) => {
      const result = await dialog.showSaveDialog(win, {
        defaultPath: path.basename(key),
      });
      if (result.canceled) return false;
      await storage.download(getClient(id), bucket, key, result.filePath);
      return true;
    });
    win = new BrowserWindow({
      width: 1320,
      height: 880,
      minWidth: 960,
      minHeight: 680,
      backgroundColor: "#101411",
      title: "S3 Browser",
      icon: path.join(__dirname, "../assets/icon.png"),
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (e) => e.preventDefault());
    win.webContents.session.setPermissionRequestHandler(
      (_wc, _permission, cb) => cb(false),
    );
    await win.loadFile(path.join(__dirname, "index.html"));
  });
app.on("before-quit", (event) => {
  if (!queue || quitting) return;
  event.preventDefault();
  quitting = true;
  workspace.close().finally(() => {
    queue.db.close();
    for (const c of clients.values()) c.destroy();
    app.quit();
  });
});
app.on("window-all-closed", () => app.quit());

app.on("second-instance", () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
});
