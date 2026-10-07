const assert = require("node:assert/strict");
const { _electron: electron, expect } = require("@playwright/test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Queue } = require("../src/queue.cjs");

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ofm-identity-"));
  try {
    for (const custom of [false, true]) {
      const base = path.join(root, custom ? "custom" : "default");
      const config = path.join(base, "config");
      const profile = custom
        ? path.join(base, "chosen-profile")
        : path.join(config, "s3-browser");
      await fs.mkdir(profile, { recursive: true });
      const connection = {
        id: "legacy-profile",
        name: "Existing connection",
        provider: "Amazon S3",
        region: "us-east-1",
        remember: true,
        credentials: Buffer.from("unavailable legacy keyring").toString(
          "base64",
        ),
      };
      const connections = JSON.stringify([connection]);
      await fs.writeFile(path.join(profile, "connections.json"), connections);
      const location = {
        profile: connection.id,
        bucket: "existing-bucket",
        prefix: "photos/",
      };
      await fs.writeFile(
        path.join(profile, "locations.json"),
        JSON.stringify({ bookmarks: [location], recent: [location] }),
      );
      const source = path.join(base, "pending.txt");
      await fs.writeFile(source, "pending upload");
      const queue = new Queue(
        path.join(profile, "transfers.sqlite"),
        async () => {},
      );
      const job = await queue.scan({
        sources: [source],
        profile: connection.id,
        bucket: location.bucket,
      });
      queue.db.close();
      const env = { ...process.env, HOME: base, XDG_CONFIG_HOME: config };
      delete env.ELECTRON_RUN_AS_NODE;
      const app = await electron.launch({
        executablePath: process.env.S3_TEST_EXECUTABLE || undefined,
        args: [
          ...(process.env.S3_TEST_EXECUTABLE ? [] : ["."]),
          ...(custom ? [`--user-data-dir=${profile}`] : []),
          ...(process.env.S3_TEST_NO_SANDBOX ? ["--no-sandbox"] : []),
        ],
        env,
      });
      try {
        const page = await app.firstWindow();
        await expect(page).toHaveTitle("ObjectFileManager");
        await expect(page.locator(".brand")).toContainText("ObjectFileManager");
        const identity = await app.evaluate(({ app }) => ({
          name: app.getName(),
          profile: app.getPath("userData"),
        }));
        assert.equal(identity.name, "s3-browser");
        assert.equal(identity.profile, profile);
        const state = await page.evaluate(async () => ({
          init: await window.s3.init(),
          jobs: await window.s3.jobs(),
          locations: await window.s3["locations:get"](),
        }));
        assert.equal(state.init.profiles[0].id, connection.id);
        assert.equal(state.init.profiles[0].locked, true);
        assert.equal(state.jobs[0].id, job);
        assert.equal(state.jobs[0].state, "paused");
        assert.deepEqual(state.locations.bookmarks, [location]);
        assert.equal(
          await fs.readFile(path.join(profile, "connections.json"), "utf8"),
          connections,
        );
      } finally {
        await app.close();
      }
    }
    console.log(
      "PASS: renamed app retains legacy profiles, locked credentials, bookmarks, queued transfers, and custom profile paths.",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
