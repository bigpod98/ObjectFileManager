const { _electron: electron, expect } = require("@playwright/test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "s3browser-ui-"));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    executablePath: process.env.S3_TEST_EXECUTABLE || undefined,
    args: [
      ...(process.env.S3_TEST_EXECUTABLE ? [] : ["."]),
      `--user-data-dir=${root}`,
      ...(process.env.S3_TEST_NO_SANDBOX ? ["--no-sandbox"] : []),
    ],
    env,
  });
  try {
    const page = await app.firstWindow();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await expect(
      page.getByRole("heading", { name: "Your files. Any cloud." }),
    ).toBeVisible();
    await expect(page.locator("#locations")).toContainText("Bookmark a bucket");
    await expect(page.locator("#toast")).toBeHidden();
    const screenshots =
      process.env.S3_TEST_REFRESH_ASSETS === "1"
        ? "assets"
        : "test-results/desktop";
    await fs.mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: path.join(screenshots, "welcome.png") });
    await page.getByRole("button", { name: "Connect your storage" }).click();
    await expect(page.locator("#region")).toHaveValue("auto");
    await page.locator("#provider").selectOption("Ceph");
    await expect(page.locator("#path-style")).toBeChecked();
    await page.locator("[name=name]").fill("Local test storage");
    await page
      .locator("#endpoint")
      .fill(process.env.S3_TEST_ENDPOINT || "http://127.0.0.1:19000");
    await page.locator("[name=accessKeyId]").fill("s3browser-test");
    await page.locator("[name=secretAccessKey]").fill("s3browser-test-secret");
    await page.locator("#remember").uncheck();
    await page.getByRole("button", { name: "Save connection" }).click();
    await expect(page.locator("#connection-name")).toHaveText(
      "Local test storage",
    );
    await expect(page.locator("#connection-dialog")).not.toBeVisible();
    await page
      .getByRole("button", { name: "Transfers", exact: false })
      .first()
      .click();
    await expect(
      page.getByRole("heading", { name: "A place for your next big move." }),
    ).toBeVisible();
    if (process.env.S3_TEST_ENDPOINT) {
      const { client } = require("../src/storage.cjs");
      const {
        CreateBucketCommand,
        PutObjectCommand,
        DeleteObjectsCommand,
        DeleteBucketCommand,
      } = require("@aws-sdk/client-s3");
      const s3 = client({
        endpoint: process.env.S3_TEST_ENDPOINT,
        region: "us-east-1",
        pathStyle: true,
        accessKeyId: "s3browser-test",
        secretAccessKey: "s3browser-test-secret",
      });
      const bucket = `desktop-test-${Date.now()}`;
      await s3.send(new CreateBucketCommand({ Bucket: bucket }));
      const keys = [
        "photos/2026/image.txt",
        "readme.txt",
        "<script>alert(1)</script>.txt",
      ];
      try {
        for (const key of keys)
          await s3.send(
            new PutObjectCommand({
              Bucket: bucket,
              Key: key,
              Body: "test data",
            }),
          );
        await page.locator("#browse-nav").click();
        await page.locator("#direct-bucket").fill(bucket);
        await page.getByRole("button", { name: "Open bucket" }).click();
        await expect(page.locator("#files")).toContainText("readme.txt");
        await page.locator("#search").fill("readme");
        await expect(page.locator("#files tr")).toHaveCount(1);
        await page.locator("#search").fill("");
        await page
          .getByRole("button", { name: "▰ photos", exact: true })
          .click();
        await expect(page.locator("#files")).toContainText("2026");
        await page.locator("#breadcrumbs button").first().click();
        await page.screenshot({ path: path.join(screenshots, "browser.png") });
        const source = path.join(root, "Upload sample");
        await fs.mkdir(path.join(source, "empty"), { recursive: true });
        await fs.writeFile(
          path.join(source, "file.txt"),
          "desktop upload test",
        );
        await app.evaluate(({ dialog }, source) => {
          dialog.showOpenDialog = async () => ({
            canceled: false,
            filePaths: [source],
          });
        }, source);
        await page.locator("#upload-top").click();
        await page
          .getByRole("button", { name: "Choose source & scan" })
          .click();
        await expect(
          page.getByRole("button", { name: "Start upload", exact: true }),
        ).toBeVisible();
        await page
          .getByRole("button", { name: "Start upload", exact: true })
          .click();
        await expect(page.locator(".state")).toHaveText("complete", {
          timeout: 30000,
        });
        await expect(page.locator(".job-stats")).toContainText("3 / 3 objects");
        await page.screenshot({
          path: path.join(screenshots, "transfers.png"),
        });
        keys.push(
          "Upload sample/",
          "Upload sample/empty/",
          "Upload sample/file.txt",
        );
      } finally {
        await s3.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: keys.map((Key) => ({ Key })) },
          }),
        );
        await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
        s3.destroy();
      }
    }
    expect(errors).toEqual([]);
    console.log(
      "Desktop smoke test passed: onboarding, presets, session connection, navigation" +
        (process.env.S3_TEST_ENDPOINT
          ? ", live browsing, filtering, upload and progress."
          : "."),
    );
  } finally {
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
