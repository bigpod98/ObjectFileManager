const { chromium, expect } = require("@playwright/test");
const { pathToFileURL } = require("node:url");
const path = require("node:path");

// Exercise the real renderer with an IPC fixture; no cloud account or desktop
// display is needed. Storage authentication is covered by adapter tests.
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      const profiles = [];
      window.submittedConnections = [];
      window.refreshedSwiftTokens = [];
      window.s3 = {
        init: async () => ({ profiles: [], secure: false }),
        "locations:get": async () => ({ bookmarks: [], recent: [] }),
        "locations:visit": async () => ({ bookmarks: [], recent: [] }),
        "queue:status": async () => ({ auto: false }),
        jobs: async () => [],
        "connection:add": async (input) => {
          window.submittedConnections.push(input);
          profiles.push({
            id: String(profiles.length + 1),
            name: input.name,
            provider: input.provider,
            swiftAuth: input.swiftAuth,
            googleAuth: input.googleAuth,
            azureAuth: input.azureAuth,
            endpoint: input.endpoint,
            bucket: input.bucket,
            remember: input.remember,
            capabilities: {
              conditionalWrite: input.provider !== "OpenStack Swift",
              conditionalDelete: input.provider !== "OpenStack Swift",
              metadata: input.provider !== "OpenStack Swift",
              versions: input.provider !== "OpenStack Swift",
              signedUrl: input.provider !== "OpenStack Swift",
              multipart: ![
                "OpenStack Swift",
                "Azure Blob Storage",
                "Google Cloud Storage",
              ].includes(input.provider),
              copy: true,
            },
          });
          return [...profiles];
        },
        buckets: async () => [],
        browse: async () => ({
          folders: [],
          objects: [{ key: "example.txt", size: 4 }],
          token: null,
        }),
        "connection:refresh-swift": async (input) => {
          if (window.refreshError) throw new Error(window.refreshError);
          window.refreshedSwiftTokens.push(input);
          return [...profiles];
        },
      };
    });
    await page.goto(pathToFileURL(path.resolve("src/index.html")).href);
    await page.locator("#connect-first").click();
    await expect(page.locator("#region")).toHaveValue("auto");
    await expect(page.locator("[name=swiftToken]")).toBeDisabled();
    await page.locator("[name=name]").fill("Provider test");
    await page.locator("[name=accessKeyId]").fill("s3-access");
    await page.locator("[name=secretAccessKey]").fill("s3-secret");
    await page.locator("#provider").selectOption("OpenStack Swift");
    await expect(page.locator("[name=accessKeyId]")).toBeDisabled();
    await expect(page.locator("#endpoint")).toHaveAttribute("required", "");
    await expect(page.locator("#default-bucket-label")).toHaveText(
      "Default container (optional)",
    );
    await expect(page.locator("[name=swiftToken]")).toBeVisible();
    await page
      .locator("#endpoint")
      .fill("https://swift.example.com/v1/AUTH_account");
    await page.locator("[name=swiftToken]").fill("swift-token");
    await page.locator("#connection-form button[type=submit]").click();
    await expect(page.locator("#connection-dialog")).not.toBeVisible();
    await expect(page.locator("#bucket-label")).toHaveText("CONTAINER");
    await expect(page.locator("#open-bucket")).toHaveText("Open container →");
    let submitted = await page.evaluate(() =>
      window.submittedConnections.at(-1),
    );
    expect(submitted.swiftToken).toBe("swift-token");
    expect(submitted.accessKeyId).toBeUndefined();
    expect(submitted.secretAccessKey).toBeUndefined();
    await expect(page.locator("#multipart-open")).not.toBeVisible();
    await expect(page.locator("#refresh-swift")).toBeVisible();
    await page.locator("#direct-bucket").fill("archive");
    await page.locator("#open-bucket").click();
    await page.locator("#files [data-select]").check();
    await expect(page.locator("#bulk-copy")).toBeEnabled();
    await expect(page.locator("#bulk-move")).toBeDisabled();
    await expect(page.locator("#bulk-delete")).toBeDisabled();
    await page.locator("#sync-open").click();
    await expect(page.locator("#sync-delete")).toBeDisabled();
    await page.locator('[data-close="workflow-dialog"]').click();
    await page.locator("#refresh-swift").click();
    await expect(page.locator("#swift-token")).toHaveAttribute(
      "type",
      "password",
    );
    await page.locator("#swift-token").fill("renewed-token");
    await page.evaluate(() => {
      window.refreshError =
        "Pause this connection’s active transfer batch before refreshing its token.";
    });
    await page.locator("#swift-token-form button[type=submit]").click();
    await expect(page.locator("#swift-token-error")).toContainText(
      "Pause this connection",
    );
    await page.evaluate(() => {
      window.refreshError = null;
    });
    await page.locator("#swift-token-form button[type=submit]").click();
    await expect(page.locator("#swift-token-dialog")).not.toBeVisible();
    expect(await page.evaluate(() => window.refreshedSwiftTokens)).toEqual([
      { id: "1", token: "renewed-token" },
    ]);
    await expect(page.locator("#swift-token")).toHaveValue("");
    await expect(page.locator("#direct-bucket")).toHaveValue("archive");

    await page.locator("#add-connection").click();
    await page.locator("#provider").selectOption("Azure Blob Storage");
    await expect(page.locator("#endpoint")).not.toHaveAttribute("required", "");
    await expect(page.locator("[name=accountName]")).toBeVisible();
    await expect(page.locator("[name=swiftToken]")).toBeDisabled();
    await page.locator("[name=name]").fill("Azure test");
    await page.locator("[name=accountName]").fill("testaccount");
    await page.locator("[name=accountKey]").fill("azure-secret");
    await page.locator("#connection-form button[type=submit]").click();
    await expect(page.locator("#connection-dialog")).not.toBeVisible();
    await expect(page.locator("#endpoint-label")).toContainText(
      "Azure Blob Storage",
    );
    submitted = await page.evaluate(() => window.submittedConnections.at(-1));
    expect(submitted.accountKey).toBe("azure-secret");
    expect(submitted.swiftToken).toBeUndefined();
    await expect(page.locator("#refresh-swift")).not.toBeVisible();
    await expect(page.locator("#multipart-open")).not.toBeVisible();

    await page.locator("#add-connection").click();
    await page.locator("#provider").selectOption("Google Cloud Storage");
    await expect(page.locator("#endpoint")).toBeDisabled();
    await expect(page.locator("#endpoint-field")).not.toBeVisible();
    await expect(page.locator("[name=serviceAccountJson]")).toHaveAttribute(
      "required",
      "",
    );
    await expect(page.locator("#default-bucket-label")).toHaveText(
      "Default bucket (optional)",
    );
    await page.locator("[name=name]").fill("Google test");
    await page
      .locator("[name=serviceAccountJson]")
      .fill('{"fixture":"json key"}');
    await page.locator("#connection-form button[type=submit]").click();
    await expect(page.locator("#connection-dialog")).not.toBeVisible();
    await expect(page.locator("#bucket-label")).toHaveText("BUCKET");
    await expect(page.locator("#endpoint-label")).toContainText(
      "Google Cloud Storage",
    );
    submitted = await page.evaluate(() => window.submittedConnections.at(-1));
    expect(submitted.serviceAccountJson).toBe('{"fixture":"json key"}');
    expect(submitted.endpoint).toBeUndefined();
    expect(submitted.accountKey).toBeUndefined();
    await expect(page.locator("#refresh-swift")).not.toBeVisible();
    await expect(page.locator("#multipart-open")).not.toBeVisible();

    await page.locator("#add-connection").click();
    await page.locator("#provider").selectOption("Ceph");
    await expect(page.locator("[name=accessKeyId]")).toBeVisible();
    await expect(page.locator("[name=accessKeyId]")).toHaveAttribute(
      "required",
      "",
    );
    await expect(page.locator("#path-style")).toBeChecked();
    await expect(page.locator("[name=serviceAccountJson]")).toBeDisabled();
    await page.locator("[name=name]").fill("S3 test");
    await page.locator("#endpoint").fill("https://s3.example.com");
    await page.locator("[name=accessKeyId]").fill("s3-key");
    await page.locator("[name=secretAccessKey]").fill("s3-secret");
    await page.locator("#connection-form button[type=submit]").click();
    await expect(page.locator("#multipart-open")).toBeVisible();
    await expect(page.locator("#refresh-swift")).not.toBeVisible();
    await page.locator("#add-connection").click();
    await page.locator("#provider").selectOption("OpenStack Swift");
    await page.locator("#swift-auth").selectOption("keystone");
    await expect(page.locator("#endpoint")).toBeDisabled();
    await expect(page.locator("[name=swiftToken]")).toBeDisabled();
    await page.locator("[name=name]").fill("Keystone test");
    await page
      .locator("[name=authUrl]")
      .fill("https://identity.example.com/v3");
    await page.locator("[name=username]").fill("test-user");
    await page.locator("[name=password]").fill(" password ");
    await page.locator("[name=projectName]").fill("project");
    await page
      .locator('[data-auth-fields="swift:keystone"] [name=region]')
      .fill("RegionOne");
    await page.locator("#connection-form button[type=submit]").click();
    await expect(page.locator("#connection-dialog")).not.toBeVisible();
    await expect(page.locator("#refresh-swift")).not.toBeVisible();
    await expect(page.locator("#endpoint-label")).toContainText("Keystone");
    submitted = await page.evaluate(() => window.submittedConnections.at(-1));
    expect(submitted.swiftAuth).toBe("keystone");
    expect(submitted.password).toBe(" password ");
    expect(submitted.region).toBe("RegionOne");
    expect(submitted.swiftToken).toBeUndefined();
    expect(submitted.endpoint).toBeUndefined();
    await page.locator("#direct-bucket").fill("container");
    await page.locator("#open-bucket").click();
    await page.locator("#sync-open").click();
    await expect(page.locator("#workflow-dialog h2")).toHaveText(
      "Sync a local folder to OpenStack Swift",
    );
    await page.locator('[data-close="workflow-dialog"]').click();

    for (const mode of ["sas", "connectionString"]) {
      await page.locator("#add-connection").click();
      await page.locator("#provider").selectOption("Azure Blob Storage");
      await page.locator("#azure-auth").selectOption(mode);
      await page.locator("[name=name]").fill("Azure " + mode);
      await expect(page.locator("[name=accountKey]")).toBeDisabled();
      if (mode === "sas") {
        await page.locator("[name=accountName]").fill("account");
        await page.locator("[name=sasToken]").fill("sig=secret");
      } else {
        await expect(page.locator("#endpoint")).toBeDisabled();
        await expect(page.locator("[name=accountName]")).toBeDisabled();
        await page
          .locator("[name=connectionString]")
          .fill("UseDevelopmentStorage=true");
      }
      await page.locator("#connection-form button[type=submit]").click();
      await expect(page.locator("#connection-dialog")).not.toBeVisible();
      submitted = await page.evaluate(() => window.submittedConnections.at(-1));
      expect(submitted.azureAuth).toBe(mode);
      expect(submitted.accountKey).toBeUndefined();
      expect(submitted.password).toBeUndefined();
      if (mode === "connectionString")
        expect(submitted.sasToken).toBeUndefined();
    }
    for (const mode of ["file", "default"]) {
      await page.locator("#add-connection").click();
      await page.locator("#provider").selectOption("Google Cloud Storage");
      await page.locator("#gcs-auth").selectOption(mode);
      await page.locator("[name=name]").fill("Google " + mode);
      await expect(page.locator("[name=serviceAccountJson]")).toBeDisabled();
      await expect(page.locator("[name=projectId]")).toHaveAttribute(
        "required",
        "",
      );
      await page.locator("[name=projectId]").fill("project");
      if (mode === "file")
        await page.locator("[name=keyFilename]").fill("/private/key.json");
      else await expect(page.locator("[name=keyFilename]")).toBeDisabled();
      await page.locator("#connection-form button[type=submit]").click();
      await expect(page.locator("#connection-dialog")).not.toBeVisible();
      submitted = await page.evaluate(() => window.submittedConnections.at(-1));
      expect(submitted.googleAuth).toBe(mode);
      expect(submitted.serviceAccountJson).toBeUndefined();
      expect(submitted.connectionString).toBeUndefined();
      if (mode === "file")
        expect(submitted.keyFilename).toBe("/private/key.json");
      else expect(submitted.keyFilename).toBeUndefined();
    }
    expect(errors).toEqual([]);
    console.log(
      "Provider connection form smoke passed (Swift, Azure, GCS, S3).",
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
