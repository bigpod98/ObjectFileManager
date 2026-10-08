const { _electron: electron, expect } = require("@playwright/test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { client } = require("../src/storage.cjs");
const {
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  ListMultipartUploadsCommand,
  AbortMultipartUploadCommand,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  DeleteBucketCommand,
} = require("@aws-sdk/client-s3");

(async () => {
  if (!process.env.S3_TEST_ENDPOINT)
    throw new Error("Set S3_TEST_ENDPOINT to a disposable S3 test server.");
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "objectfilemanager-expanded-ui-"),
  );
  const destination = path.join(root, "downloads"),
    source = path.join(root, "sync-source");
  await fs.mkdir(destination);
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "new.txt"), "new synced content");
  await fs.writeFile(
    path.join(source, "changed.txt"),
    "replacement synced content",
  );
  const s3 = client({
    endpoint: process.env.S3_TEST_ENDPOINT,
    region: "us-east-1",
    pathStyle: true,
    accessKeyId: "objectfilemanager-test",
    secretAccessKey: "objectfilemanager-test-secret",
  });
  const bucket = `desktop-expanded-${Date.now()}`;
  let app,
    page,
    bucketCreated = false,
    incomplete;
  const errors = [];
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    bucketCreated = true;
    const seed = {
      "folder/a.txt": "folder content",
      "folder/nested/needle.txt": "nested content",
      "folder/empty/": "",
      "readme.txt": "hello",
      "large.txt": "large test content".repeat(10),
      "sync/changed.txt": "old",
      "sync/remote-only.txt": "retain unless deletion explicitly selected",
    };
    for (const [Key, Body] of Object.entries(seed))
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key,
          Body,
          ContentType: "text/plain",
          Metadata: { test: "expanded" },
        }),
      );
    incomplete = await s3.send(
      new CreateMultipartUploadCommand({
        Bucket: bucket,
        Key: "abandoned.bin",
      }),
    );
    app = await electron.launch({
      executablePath: process.env.S3_TEST_EXECUTABLE || undefined,
      args: [
        ...(process.env.S3_TEST_EXECUTABLE ? [] : ["."]),
        `--user-data-dir=${path.join(root, "user-data")}`,
        ...(process.env.S3_TEST_NO_SANDBOX ? ["--no-sandbox"] : []),
      ],
      env,
    });
    page = await app.firstWindow();
    page.setDefaultTimeout(15000);
    page.on("pageerror", (error) => errors.push(error.message));
    const choose = (folder) =>
      app.evaluate(({ dialog }, selected) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [selected],
        });
      }, folder);
    const closeWorkflow = () =>
      page.locator('[data-close="workflow-dialog"]').click();
    const goPrefix = async (prefix) => {
      await page.locator("#prefix-input").fill(prefix);
      await page
        .locator("#prefix-form")
        .getByRole("button", { name: "Open", exact: false })
        .click();
      await expect(page.locator("#browser-status")).not.toContainText(
        "Loading",
      );
    };
    const contents = async (key) =>
      (
        await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
      ).Body.transformToString();
    const exists = async (key) => {
      try {
        await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return true;
      } catch (error) {
        if (error.$metadata?.httpStatusCode === 404) return false;
        throw error;
      }
    };
    console.log("Expanded desktop: connect and browse");
    await page.getByRole("button", { name: "Connect your storage" }).click();
    await page.locator("#provider").selectOption("Ceph");
    await page.locator("[name=name]").fill("Expanded test storage");
    await page.locator("#endpoint").fill(process.env.S3_TEST_ENDPOINT);
    await page.locator("[name=accessKeyId]").fill("objectfilemanager-test");
    await page
      .locator("[name=secretAccessKey]")
      .fill("objectfilemanager-test-secret");
    await page.locator("#remember").uncheck();
    await page.getByRole("button", { name: "Save connection" }).click();
    await expect(page.locator("#connection-dialog")).not.toBeVisible();
    await page.locator("#direct-bucket").fill(bucket);
    await page.getByRole("button", { name: "Open bucket" }).click();
    await expect(page.locator("#files")).toContainText("readme.txt");

    console.log(
      "Expanded desktop: bookmark, size sorting and recursive search",
    );
    await page.locator("#bookmark").click();
    await expect(page.locator("#bookmark")).toHaveText("★ Bookmarked");
    await expect(page.locator("#locations")).toContainText(bucket);
    await page.locator('[data-sort="size"]').click();
    const objectNames = await page
      .locator("#files tr:has(.document) .file-name")
      .evaluateAll((buttons) => buttons.map((button) => button.title));
    assert.deepEqual(objectNames, ["readme.txt", "large.txt"]);
    await page.locator('[data-sort="size"]').click();
    assert.deepEqual(
      await page
        .locator("#files tr:has(.document) .file-name")
        .evaluateAll((buttons) => buttons.map((button) => button.title)),
      ["large.txt", "readme.txt"],
    );
    await page.locator("#search").fill("needle");
    await expect(page.locator("#files tr")).toHaveCount(0);
    await page.locator("#recursive-search").click();
    await expect(page.locator("#files")).toContainText(
      "folder/nested/needle.txt",
    );
    await page.locator("#clear-search").click();
    await expect(page.locator("#files")).toContainText("readme.txt");

    console.log(
      "Expanded desktop: multiselect queued folder download and settings",
    );
    await page
      .getByRole("checkbox", { name: "Select folder/", exact: true })
      .check();
    await page
      .getByRole("checkbox", { name: "Select readme.txt", exact: true })
      .check();
    await expect(page.locator("#selection-count")).toHaveText("2 selected");
    await choose(destination);
    await page.locator("#bulk-download").click();
    await page.locator("#download-choose").click();
    await expect(page.locator("#workflow-dialog")).not.toBeVisible();
    const download = page.locator(".job").filter({ hasText: "Download ·" });
    await expect(download.locator(".state")).toHaveText("paused");
    assert.deepEqual(await fs.readdir(destination), []);
    await download.locator('[data-action="settings"]').click();
    await page.locator("#setting-concurrency").fill("2");
    await page.locator("#setting-bandwidth").fill("1");
    await page.locator("#setting-retries").fill("1");
    await page.locator("#settings-save").click();
    await expect(download.locator(".job-head small")).toContainText(
      "2 workers",
    );
    await download.locator('[data-action="start"]').click();
    await expect(download.locator(".state")).toHaveText("complete", {
      timeout: 30000,
    });
    await expect(download.locator(".job-stats")).toContainText("4 / 4 objects");
    if (process.env.S3_TEST_TRANSFERS_SCREENSHOT)
      await page.screenshot({ path: process.env.S3_TEST_TRANSFERS_SCREENSHOT });
    for (const key of [
      "folder/a.txt",
      "folder/nested/needle.txt",
      "readme.txt",
    ])
      assert.equal(
        await fs.readFile(path.join(destination, key), "utf8"),
        seed[key],
      );
    assert.ok(
      (await fs.stat(path.join(destination, "folder/empty"))).isDirectory(),
    );

    console.log("Expanded desktop: reviewed copy and deletion");
    await page.locator("#browse-nav").click();
    await page.locator("#refresh").click();
    await page
      .getByRole("checkbox", { name: "Select readme.txt", exact: true })
      .check();
    await page.locator("#bulk-copy").click();
    await page.locator("#operation-prefix").fill("copies/");
    await page.locator("#operation-preview").click();
    await expect(page.locator("#workflow-title")).toHaveText("Review copy");
    await expect(page.locator("#workflow-body")).toContainText(
      "copies/readme.txt",
    );
    assert.equal(await exists("copies/readme.txt"), false);
    await page.locator("#operation-execute").click();
    await expect(page.locator("#workflow-title")).toHaveText(
      "Operation result",
    );
    assert.equal(await contents("copies/readme.txt"), seed["readme.txt"]);
    await closeWorkflow();
    await goPrefix("copies/");
    await page
      .getByRole("checkbox", { name: "Select copies/readme.txt", exact: true })
      .check();
    await page.locator("#bulk-delete").click();
    await page.locator("#operation-preview").click();
    await expect(page.locator("#workflow-title")).toHaveText("Review delete");
    assert.equal(await exists("copies/readme.txt"), true);
    await page.locator("#operation-execute").click();
    await expect(page.locator("#workflow-title")).toHaveText(
      "Operation result",
    );
    assert.equal(await exists("copies/readme.txt"), false);
    await closeWorkflow();

    console.log(
      "Expanded desktop: reviewed sync uploads and explicit remote deletion",
    );
    await goPrefix("sync/");
    await expect(page.locator("#files")).toContainText("remote-only.txt");
    await choose(source);
    await page.locator("#sync-open").click();
    await expect(page.locator("#sync-delete")).not.toBeChecked();
    await page.locator("#sync-delete").check();
    await page.locator("#sync-compare").click();
    await expect(page.locator("#workflow-title")).toHaveText(
      "Review folder sync",
    );
    await expect(page.locator("#workflow-body")).toContainText(
      "2 uploads · 1 remote deletions",
    );
    assert.equal(await contents("sync/changed.txt"), "old");
    assert.equal(await exists("sync/new.txt"), false);
    await page.locator("#sync-apply").click();
    await expect(page.locator("#workflow-dialog")).not.toBeVisible();
    const sync = page.locator(".job").filter({ hasText: "Sync ·" });
    await expect(sync.locator(".state")).toHaveText("paused");
    assert.equal(await exists("sync/remote-only.txt"), true);
    await sync.locator('[data-action="start"]').click();
    await expect(sync.locator(".state")).toHaveText("complete", {
      timeout: 30000,
    });
    await expect
      .poll(() => exists("sync/remote-only.txt"), { timeout: 10000 })
      .toBe(false);
    assert.equal(await contents("sync/new.txt"), "new synced content");
    assert.equal(
      await contents("sync/changed.txt"),
      "replacement synced content",
    );

    console.log(
      "Expanded desktop: object details, metadata and usable signed links",
    );
    await page.locator("#browse-nav").click();
    await page.locator("#locations button").first().click();
    await expect(page.locator("#prefix-input")).toHaveValue("");
    await expect(
      page.locator('#files .file-name[title="readme.txt"]'),
    ).toBeVisible();
    if (process.env.S3_TEST_SCREENSHOT)
      await page.screenshot({ path: process.env.S3_TEST_SCREENSHOT });
    await page.locator('#files .file-name[title="readme.txt"]').click();
    await expect(page.locator("#object-body")).toContainText("ETag");
    await page.getByText("Edit metadata", { exact: true }).click();
    await expect(page.locator("#object-metadata")).toContainText("expanded");
    // A metadata-only write keeps the ETag but must invalidate the open editor.
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: "readme.txt",
        Body: "hello",
        Metadata: { test: "concurrent-edit" },
        ContentType: "text/plain",
      }),
    );
    await page.locator("#metadata-confirm").check();
    await page.locator("#metadata-save").click();
    await expect(page.locator("#object-error")).toContainText("object changed");
    assert.equal(
      (
        await s3.send(
          new HeadObjectCommand({ Bucket: bucket, Key: "readme.txt" }),
        )
      ).Metadata.test,
      "concurrent-edit",
    );
    await page.locator('[data-close="object-dialog"]').click();
    await page.locator('#files .file-name[title="readme.txt"]').click();
    await page.getByText("Edit metadata", { exact: true }).click();
    await expect(page.locator("#object-metadata")).toContainText(
      "concurrent-edit",
    );
    await page
      .locator("#object-metadata")
      .fill(
        JSON.stringify({ test: "edited-through-ui", owner: "desktop-test" }),
      );
    await page.locator("#metadata-confirm").check();
    await page.locator("#metadata-save").click();
    await expect
      .poll(
        async () =>
          (
            await s3.send(
              new HeadObjectCommand({ Bucket: bucket, Key: "readme.txt" }),
            )
          ).Metadata?.test,
      )
      .toBe("edited-through-ui");
    await expect(page.locator("#object-error")).toHaveText("");
    assert.equal(await contents("readme.txt"), "hello");
    await page.getByText("Temporary download link", { exact: true }).click();
    await page.locator("#url-expiry").fill("120");
    await page.locator("#url-create").click();
    await expect(page.locator("#url-result")).toHaveValue(/X-Amz-Signature=/);
    const url = await page.locator("#url-result").inputValue();
    assert.equal(new URL(url).searchParams.get("X-Amz-Expires"), "120");
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "hello");
    await page.locator("#url-copy").click();
    await expect
      .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe(url);
    await page.getByText("Object versions", { exact: true }).click();
    await page.locator("#versions-load").click();
    await expect(page.locator("#versions-list")).toContainText("Current");
    await page.locator('[data-close="object-dialog"]').click();
    await page.locator("#create-folder").click();
    await page.locator("#folder-name").fill("created-through-ui");
    await page.locator("#folder-create").click();
    await expect(page.locator("#workflow-dialog")).not.toBeVisible();
    assert.equal(await exists("created-through-ui/"), true);

    console.log("Expanded desktop: reviewed multipart cleanup");
    await page.locator("#multipart-open").click();
    await page.locator("#multipart-load").click();
    await expect(page.locator("#multipart-list")).toContainText(
      "abandoned.bin",
    );
    await page.locator("[data-multipart]").check();
    await page.locator("#multipart-review").click();
    await expect(page.locator("#workflow-title")).toHaveText(
      "Confirm multipart cleanup",
    );
    assert.equal(
      (await s3.send(new ListMultipartUploadsCommand({ Bucket: bucket })))
        .Uploads.length,
      1,
    );
    await page.locator("#multipart-abort").click();
    await expect(page.locator("#workflow-title")).toHaveText(
      "Multipart cleanup result",
    );
    await expect(page.locator("#workflow-body")).toContainText(
      "1 uploads aborted · 0 failed",
    );
    assert.equal(
      (await s3.send(new ListMultipartUploadsCommand({ Bucket: bucket })))
        .Uploads?.length || 0,
      0,
    );
    incomplete = null;
    await closeWorkflow();
    assert.deepEqual(errors, []);
    console.log("Expanded desktop test passed.");
  } catch (error) {
    if (page)
      console.error(
        "UI diagnostic:",
        (
          await page
            .locator("body")
            .innerText()
            .catch(() => "unavailable")
        ).slice(-6500),
      );
    throw error;
  } finally {
    await app?.close();
    if (bucketCreated) {
      if (incomplete?.UploadId)
        await s3
          .send(
            new AbortMultipartUploadCommand({
              Bucket: bucket,
              Key: "abandoned.bin",
              UploadId: incomplete.UploadId,
            }),
          )
          .catch((error) => {
            if (error.$metadata?.httpStatusCode !== 404) throw error;
          });
      let token;
      do {
        const result = await s3.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            ContinuationToken: token,
          }),
        );
        if (result.Contents?.length)
          await s3.send(
            new DeleteObjectsCommand({
              Bucket: bucket,
              Delete: { Objects: result.Contents.map(({ Key }) => ({ Key })) },
            }),
          );
        token = result.IsTruncated ? result.NextContinuationToken : undefined;
      } while (token);
      await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
    }
    s3.destroy();
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
