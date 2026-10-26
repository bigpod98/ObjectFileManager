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

  await t.test(
    "recursive search trims filtering without changing ordinary space matching",
    async (t) => {
      const page = await fixture(t);
      await saved(page, 0).click();
      await page.evaluate(() => {
        window.s3["objects:search"] = async (options) => {
          window.fixture.calls.push({ method: "search", ...options });
          return {
            folders: [],
            objects: [
              {
                key:
                  options.prefix +
                  (options.token ? "report-next.txt" : "report.txt"),
                size: 4,
              },
            ],
            token: options.token ? null : "page2",
            scanned: 1,
          };
        };
      });
      await page.locator("#search").fill(" report ");
      await page.locator("#recursive-search").click();
      await expect(page.locator("#files")).toContainText("report.txt");
      await page.locator("#next").click();
      await expect(page.locator("#files")).toContainText("report-next.txt");
      expect(
        await page.evaluate(() =>
          window.fixture.calls
            .filter((c) => c.method === "search")
            .map((c) => [c.query, c.token]),
        ),
      ).toEqual([
        ["report", null],
        ["report", "page2"],
      ]);
      await page.locator("#clear-search").click();
      await expect(page.locator("#search")).toHaveValue("");
      await page.locator("#search").fill(" file ");
      await expect(page.locator("#files [data-open]")).toHaveCount(0);
      await page.locator("#search").fill("   ");
      await page.locator("#recursive-search").click();
      await expect(page.locator("#toast")).toContainText("Enter a search term");
      expect(await page.evaluate(() => state.searchQuery)).toBeNull();
    },
  );

  await t.test(
    "transfer cards follow full job order and retain focused controls",
    async (t) => {
      const page = await fixture(t);
      await page.evaluate(() => {
        window.fixture.makeJob = (id) => ({
          id,
          profile: "a",
          bucket: "bucket",
          prefix: id,
          state: "queued",
          kind: "upload",
          created: 1,
          concurrency: 1,
          overwrite: false,
          done: 0,
          skipped: 0,
          failed: 0,
          active: [],
          total: 1,
          bytes: 4,
          completedBytes: 0,
        });
        window.fixture.jobs = ["old1", "old2"].map(window.fixture.makeJob);
        window.s3.jobs = async () => window.fixture.jobs;
      });
      await page.locator("#queue-nav").click();
      const cards = page.locator("#jobs > article");
      await expect(cards).toHaveCount(2);
      expect(await cards.evaluateAll((els) => els.map((e) => e.id))).toEqual([
        "job-old1",
        "job-old2",
      ]);
      const focused = page.locator("#job-old2 [data-action=start]");
      await focused.focus();
      await page.evaluate(async () => {
        window.fixture.originalCard = document.getElementById("job-old2");
        window.fixture.originalButton = document.activeElement;
        window.fixture.jobs = ["new2", "new1", "old1", "old2"].map(
          window.fixture.makeJob,
        );
        await refreshJobs();
      });
      expect(await cards.evaluateAll((els) => els.map((e) => e.id))).toEqual([
        "job-new2",
        "job-new1",
        "job-old1",
        "job-old2",
      ]);
      await expect(focused).toBeFocused();
      // Exercise moving the focused card itself, as well as removing another card.
      await page.evaluate(async () => {
        window.fixture.jobs = ["old2", "new2", "new1"].map(
          window.fixture.makeJob,
        );
        await refreshJobs();
        await refreshJobs();
      });
      expect(await cards.evaluateAll((els) => els.map((e) => e.id))).toEqual([
        "job-old2",
        "job-new2",
        "job-new1",
      ]);
      await expect(focused).toBeFocused();
      // Older engines use insertBefore, which detaches the focused subtree.
      await page.evaluate(async () => {
        document.querySelector("#jobs").moveBefore = undefined;
        window.fixture.jobs = ["new2", "new1", "old2"].map(
          window.fixture.makeJob,
        );
        await refreshJobs();
        window.fixture.jobs = ["old2", "new2", "new1"].map(
          window.fixture.makeJob,
        );
        await refreshJobs();
      });
      await expect(focused).toBeFocused();
      expect(
        await page.evaluate(
          () =>
            document.getElementById("job-old2") ===
              window.fixture.originalCard &&
            document.activeElement === window.fixture.originalButton,
        ),
      ).toBe(true);
    },
  );

  await t.test(
    "runtime failures offer explicit retry while scan errors remain blocked",
    async (t) => {
      const page = await fixture(t);
      await page.evaluate(() => {
        window.s3.jobs = async () =>
          [1, 0].map((runtimeFailure) => ({
            id: runtimeFailure ? "runtime" : "scan",
            profile: "a",
            bucket: "bucket",
            prefix: "",
            state: "failed",
            kind: "upload",
            created: 1,
            concurrency: 1,
            overwrite: false,
            done: 0,
            skipped: 0,
            failed: 0,
            active: [],
            total: 1,
            bytes: 4,
            completedBytes: 0,
            runtimeFailure,
            error: runtimeFailure
              ? "Temporary database failure"
              : "Folder scan interrupted",
          }));
        window.s3.retry = async (id) => {
          window.fixture.retried = id;
        };
      });
      await page.locator("#queue-nav").click();
      const retry = page.locator("#job-runtime [data-action=retry]");
      await expect(retry).toBeVisible();
      await expect(retry).toHaveText("Retry batch");
      await expect(page.locator("#job-scan [data-action=retry]")).toBeHidden();
      await retry.click();
      expect(await page.evaluate(() => window.fixture.retried)).toBe("runtime");
    },
  );

  for (const scenario of [
    "mixed",
    "conflict-only",
    "unsupported-replacement",
    "no-conflicts",
    "uncertain",
  ]) {
    await t.test(
      `sync review explains partial plans: ${scenario}`,
      async (t) => {
        const page = await fixture(t);
        await saved(page, 0).click();
        await page.evaluate((scenario) => {
          if (scenario === "unsupported-replacement")
            state.profile.capabilities = { conditionalWrite: false };
          window.s3["sync:compare"] = async () => ({
            token: "review-token",
            plan: {
              source: "/local/folder",
              entries:
                scenario === "conflict-only"
                  ? []
                  : [
                      {
                        key: "new.txt",
                        ...(scenario === "unsupported-replacement"
                          ? { etag: '"reviewed"' }
                          : {}),
                      },
                    ],
              deletions: [],
              counts: { uncertain: scenario === "uncertain" ? 1 : 0 },
              rows: ["no-conflicts", "uncertain"].includes(scenario)
                ? []
                : [
                    {
                      key: "conflicting.txt",
                      status: "conflict",
                      reason: "Resolve this path before syncing.",
                    },
                  ],
            },
          });
          window.s3["sync:apply"] = async (token) =>
            window.fixture.calls.push({ method: "sync:apply", token });
        }, scenario);
        await page.locator("#sync-open").click();
        await page.locator("#sync-compare").click();
        if (["no-conflicts", "uncertain"].includes(scenario)) {
          await expect(page.locator("#sync-apply")).toHaveText(
            "Confirm & queue sync",
          );
          await expect(page.locator("#workflow-body")).not.toContainText(
            "unresolved conflict",
          );
        } else {
          await expect(page.locator("#workflow-body")).toContainText(
            "1 unresolved conflict",
          );
          await expect(page.locator("#workflow-body")).toContainText(
            "Conflicting paths will remain unchanged",
          );
          await expect(page.locator("#sync-apply")).toHaveText(
            "Queue non-conflicting changes",
          );
        }
        if (scenario === "uncertain") {
          await expect(page.locator("#sync-uncertain")).toContainText(
            "1 file has unproven content equality",
          );
          await expect(page.locator("#sync-uncertain")).toContainText(
            "Uploads remain included",
          );
        } else {
          await expect(page.locator("#sync-uncertain")).toHaveCount(0);
        }
        if (["conflict-only", "unsupported-replacement"].includes(scenario)) {
          await expect(page.locator("#sync-apply")).toBeDisabled();
          if (scenario === "unsupported-replacement")
            await expect(page.locator("#workflow-error")).toContainText(
              "cannot safely replace reviewed objects",
            );
        } else {
          await page.locator("#sync-apply").click();
          expect(
            await page.evaluate(() =>
              window.fixture.calls.filter((c) => c.method === "sync:apply"),
            ),
          ).toEqual([{ method: "sync:apply", token: "review-token" }]);
        }
      },
    );
  }
});
