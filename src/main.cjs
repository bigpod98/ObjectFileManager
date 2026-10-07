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
  refreshSwiftToken,
} = require("./profiles.cjs");
const {
  JsonFile,
  serialMutations,
  decodeProfiles,
  encodeProfiles,
  cleanLocation,
  decodeLocations,
  withoutProfile,
} = require("./local-state.cjs");
const mutateLocalState = serialMutations();
let profileFile;
const refreshingProfiles = new Set();
const removingProfiles = new Set();
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
  if (removingProfiles.has(id))
    throw new Error("This connection is being removed.");
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
async function persistProfiles(next) {
  await profileFile.save(encodeProfiles(next, safeStorage));
  profiles = next;
}
function handle(name, fn) {
  if (
    name.startsWith("connection:") ||
    ["locations:bookmark", "locations:visit"].includes(name)
  ) {
    const operation = fn;
    fn = (...args) => mutateLocalState(() => operation(...args));
  }
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
    profileFile = new JsonFile(profilePath(), {
      report: (message) =>
        dialog.showErrorBox("Could not read connections", message),
    });
    profiles = await profileFile.load([], (data) =>
      decodeProfiles(data, safeStorage),
    );
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
    const locationFile = new JsonFile(locationsPath, {
      report: (message) =>
        dialog.showErrorBox("Could not read saved locations", message),
    });
    let locations = await locationFile.load(
      { bookmarks: [], recent: [] },
      decodeLocations,
    );
    const locationKey = (l) => JSON.stringify([l.profile, l.bucket, l.prefix]);
    const saveLocations = async (next) => {
      await locationFile.save(next);
      locations = next;
    };
    handle("locations:get", () => locations);
    handle("locations:bookmark", async (location) => {
      const clean = cleanLocation(location);
      getClient(clean.profile);
      const key = locationKey(clean);
      const bookmarks = locations.bookmarks.some((l) => locationKey(l) === key)
        ? locations.bookmarks.filter((l) => locationKey(l) !== key)
        : [...locations.bookmarks, clean];
      await saveLocations({ ...locations, bookmarks });
      return locations;
    });
    handle("locations:visit", async (location) => {
      const clean = cleanLocation(location);
      getClient(clean.profile);
      const recent = [
        clean,
        ...locations.recent.filter(
          (l) => locationKey(l) !== locationKey(clean),
        ),
      ].slice(0, 20);
      await saveLocations({ ...locations, recent });
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
      await persistProfiles([...profiles, profile]);
      return publicProfiles();
    });
    handle("connection:refresh-swift", async ({ id, token } = {}) => {
      if (removingProfiles.has(id))
        throw new Error("This connection is being removed.");
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
      try {
        await persistProfiles(profiles.map((p) => (p.id === id ? updated : p)));
      } finally {
        refreshingProfiles.delete(id);
      }
      clients.get(id)?.destroy();
      clients.delete(id);
      return publicProfiles();
    });
    handle("connection:remove", async (id) => {
      if (removingProfiles.has(id))
        throw new Error("This connection is being removed.");
      if (refreshingProfiles.has(id))
        throw new Error("Wait for this connection’s token refresh to finish.");
      if (
        workspace
          .list()
          .some((j) => j.profile === id && !["complete"].includes(j.state))
      )
        throw new Error("Remove unfinished batches for this connection first.");
      removingProfiles.add(id);
      const previousLocations = locations;
      let recovery,
        cleaned = false;
      try {
        // The files cannot be renamed atomically together. Keep a recovery copy
        // until both writes succeed, including if restoring locations fails.
        const nextLocations = withoutProfile(locations, id);
        if (JSON.stringify(nextLocations) !== JSON.stringify(locations)) {
          recovery = await locationFile.recoveryCopy(previousLocations);
          await saveLocations(nextLocations);
          cleaned = true;
        }
        await persistProfiles(profiles.filter((p) => p.id !== id));
        await locationFile.discardRecovery(recovery);
      } catch (error) {
        if (cleaned) {
          try {
            await saveLocations(previousLocations);
          } catch {
            throw new Error(
              `Connection was not removed. Saved locations could not be restored; recover them from ${recovery}.`,
            );
          }
        }
        await locationFile.discardRecovery(recovery);
        throw error;
      } finally {
        removingProfiles.delete(id);
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
