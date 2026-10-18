const { test } = require("node:test");
const assert = require("node:assert/strict");
const { chromium, expect } = require("@playwright/test");
const { pathToFileURL } = require("node:url");
const path = require("node:path");

// Run the real renderer with controllable IPC replies, without cloud accounts.
test("browser navigation regressions", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  async function fixture(t) {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("dialog", (dialog) => dialog.accept());
    t.after(async () => {
      await page.close();
      assert.deepEqual(errors, []);
    });
    await page.addInitScript(() => {
      let profiles = [
        { id: "a", name: "First", provider: "Amazon S3", bucket: "default-a" },
        { id: "b", name: "Second", provider: "Amazon S3", bucket: "default-b" },
      ];
      let locations = {
        bookmarks: [
          { profile: "a", bucket: "archive", prefix: "slow/" },
          { profile: "a", bucket: "archive", prefix: "other/" },
          { profile: "b", bucket: "backup", prefix: "target/" },
        ],
        recent: [],
      };
      const f = (window.fixture = { calls: [], pending: {}, holds: [] });
      const reply = async (name, value) => {
        const snapshot = structuredClone(value);
        if (f.holds.includes(name)) {
          f.holds = f.holds.filter((held) => held !== name);
          await new Promise((resolve) => (f.pending[name] = resolve));
        }
        return snapshot;
      };
      window.s3 = {
        init: async () => ({ profiles, secure: false }),
        jobs: async () => [],
        "queue:status": async () => ({ auto: false }),
        buckets: async () => [],
        browse: async (profile, bucket, prefix) => {
          f.calls.push({ method: "browse", profile, bucket, prefix });
          if (f.failBrowse) throw new Error("Listing failed");
          const gate = f.holds.includes("first-browse")
            ? "first-browse"
            : `browse:${prefix}`;
          return reply(gate, {
            folders: [prefix + "needle/"],
            objects: [
              { key: prefix, size: 0 },
              { key: prefix + "needle/", size: 0 },
              { key: prefix + "file.txt", size: 4 },
            ],
            token: null,
          });
        },
        "objects:search": async ({ prefix }) => ({
          folders: [],
          objects: [{ key: prefix + "needle/", size: 0 }],
          scanned: 1,
          token: null,
        }),
        "locations:get": () => reply("get", locations),
        "locations:visit": (ctx) => {
          f.calls.push({ method: "visit", ...ctx });
          locations.recent = [ctx];
          return reply("visit", locations);
        },
        "locations:bookmark": (ctx) => {
          locations.bookmarks.push(ctx);
          return reply("bookmark", locations);
        },
        "connection:remove": async (id) => {
          profiles = profiles.filter((p) => p.id !== id);
          for (const key of ["bookmarks", "recent"])
            locations[key] = locations[key].filter((l) => l.profile !== id);
          return reply("remove", profiles);
        },
      };
    });
    await page.goto(pathToFileURL(path.resolve("src/index.html")).href);
    await expect(page.locator("#locations button")).toHaveCount(3);
    return page;
  }
  const saved = (page, index) =>
    page.locator(`#locations button[data-location="${index}"]`);
  async function release(page, name) {
    await page.evaluate((name) => {
      window.fixture.pending[name]();
      delete window.fixture.pending[name];
    }, name);
    // Flush the promise continuations and give stale DOM writes time to run.
    await page.evaluate(() => new Promise(requestAnimationFrame));
  }

  await t.test(
    "saved targets skip default buckets and intermediate recents",
    async (t) => {
      const page = await fixture(t);
      await saved(page, 0).click();
      await expect(page.locator("#files")).toContainText("file.txt");
      expect(await page.evaluate(() => window.fixture.calls)).toEqual([
        { method: "browse", profile: "a", bucket: "archive", prefix: "slow/" },
        { method: "visit", profile: "a", bucket: "archive", prefix: "slow/" },
      ]);
      // A common-prefix row and its marker must appear only once; the current
      // prefix's own marker must never appear as a child of itself.
      await expect(page.locator("#files [data-open]")).toHaveCount(2);
    },
  );

  for (const target of [
    "same profile",
    "other profile",
    "connection",
    "bucket",
    "prefix",
  ]) {
    await t.test(
      `a later ${target} wins over a delayed saved location`,
      async (t) => {
        const page = await fixture(t);
        await page.evaluate(() => window.fixture.holds.push("first-browse"));
        await saved(page, 0).click();
        await page.waitForFunction(
          () => window.fixture.pending["first-browse"],
        );
        let bucket = "archive",
          prefix = "other/",
          name = "First";
        if (target === "same profile") await saved(page, 1).click();
        if (target === "other profile") {
          await saved(page, 2).click();
          bucket = "backup";
          prefix = "target/";
          name = "Second";
        }
        if (target === "connection") {
          await page.locator('#connections [data-id="b"]').click();
          bucket = "default-b";
          prefix = "";
          name = "Second";
        }
        if (target === "bucket") {
          await page.locator("#direct-bucket").fill("manual");
          await page.locator("#open-bucket").click();
          bucket = "manual";
          prefix = "";
        }
        if (target === "prefix") {
          await page.locator("#prefix-input").fill(prefix);
          await page.locator("#prefix-input").press("Enter");
        }
        await expect(page.locator("#files")).toContainText("file.txt");
        await release(page, "first-browse");
        await expect(page.locator("#workspace-name")).toHaveText(name);
        await expect(page.locator("#direct-bucket")).toHaveValue(bucket);
        await expect(page.locator("#prefix-input")).toHaveValue(prefix);
        const visits = await page.evaluate(() =>
          window.fixture.calls.filter((c) => c.method === "visit"),
        );
        expect(visits).toEqual([
          {
            method: "visit",
            profile: name === "First" ? "a" : "b",
            bucket,
            prefix,
          },
        ]);
      },
    );
  }

  await t.test("failed listings do not record visits", async (t) => {
    const page = await fixture(t);
    await page.evaluate(() => (window.fixture.failBrowse = true));
    await saved(page, 0).click();
    await expect(page.locator("#browser-status")).toContainText(
      "Listing failed",
    );
    expect(
      await page.evaluate(() =>
        window.fixture.calls.filter((c) => c.method === "visit"),
      ),
    ).toEqual([]);
  });

  for (const pending of ["visit", "bookmark", "get"]) {
    await t.test(
      `connection removal rejects a stale ${pending} snapshot`,
      async (t) => {
        const page = await fixture(t);
        if (pending !== "visit") {
          await saved(page, 0).click();
          await expect(page.locator("#locations button")).toHaveCount(4);
        }
        await page.evaluate((name) => window.fixture.holds.push(name), pending);
        if (pending === "visit") await saved(page, 0).click();
        if (pending === "bookmark") await page.locator("#bookmark").click();
        if (pending === "get")
          await page.evaluate(() => {
            window.pendingLoad = loadLocations();
          });
        await page.waitForFunction(
          (name) => window.fixture.pending[name],
          pending,
        );
        // Subsequent reloads may finish while this old snapshot remains delayed.
        await page.evaluate(() => (window.fixture.holds = []));
        await page.locator("#forget").click();
        await expect(page.locator("#welcome")).toBeVisible();
        await expect(page.locator("#connections button")).toHaveCount(1);
        await expect(page.locator("#locations button")).toHaveCount(1);
        await expect(page.locator("#locations")).toContainText(
          "backup/target/",
        );
        await release(page, pending);
        await expect(page.locator("#locations button")).toHaveCount(1);
        await expect(page.locator("#locations")).not.toContainText("archive");
      },
    );
  }

  await t.test(
    "removing a connection preserves a newer connection selection",
    async (t) => {
      const page = await fixture(t);
      await saved(page, 0).click();
      await page.evaluate(() => window.fixture.holds.push("remove"));
      await page.locator("#forget").click();
      await page.waitForFunction(() => window.fixture.pending.remove);
      await saved(page, 2).click();
      await expect(page.locator("#workspace-name")).toHaveText("Second");
      await release(page, "remove");
      await expect(page.locator("#browser")).toBeVisible();
      await expect(page.locator("#workspace-name")).toHaveText("Second");
      await expect(page.locator("#direct-bucket")).toHaveValue("backup");
    },
  );

  await t.test(
    "search folder markers can be selected and opened",
    async (t) => {
      const page = await fixture(t);
      await saved(page, 0).click();
      await page.locator("#search").fill("needle");
      await page.locator("#recursive-search").click();
      await expect(page.locator("#file-count")).toContainText("1 items");
      await page.locator("#files [data-select]").check();
      await expect(page.locator("#selection-count")).toHaveText("1 selected");
      expect(await page.evaluate(() => [...state.selection.values()])).toEqual([
        { key: "slow/needle/", folder: true },
      ]);
      await page.locator("#files [data-open]").click();
      await expect(page.locator("#prefix-input")).toHaveValue("slow/needle/");
      await expect(page.locator("#clear-search")).toBeHidden();
      await expect(page.locator("#files")).toContainText("file.txt");
    },
  );
});
