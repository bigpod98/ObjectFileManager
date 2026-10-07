const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  generateKeyPairSync,
  randomBytes,
  createCipheriv,
  createDecipheriv,
} = require("node:crypto");
const {
  CREDENTIAL_FIELDS,
  normalizeProfile,
  publicProfile,
  serializeProfile,
  restoreProfile,
  refreshSwiftToken,
} = require("../src/profiles.cjs");
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const serviceAccountJson = JSON.stringify({
  type: "service_account",
  project_id: "example-project",
  client_email: "browser@example-project.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
});
const samples = [
  {
    provider: "Amazon S3",
    accessKeyId: "access-id-private",
    secretAccessKey: "secret-private",
    sessionToken: "session-private",
  },
  {
    provider: "OpenStack Swift",
    endpoint: "https://swift.example.com/v1/AUTH_account",
    swiftToken: "swift-token-private",
    swiftTempUrlKey: "tempurl-private",
  },
  {
    provider: "Azure Blob Storage",
    accountName: "accountprivate",
    accountKey: "azure-key-private",
  },
  { provider: "Google Cloud Storage", serviceAccountJson },
  {
    provider: "OpenStack Swift",
    swiftAuth: "keystone",
    authUrl: "https://identity.example.com/v3",
    username: "private-user",
    password: " private-password ",
    projectName: "project",
    domainName: "Default",
    region: "RegionOne",
  },
  {
    provider: "Azure Blob Storage",
    azureAuth: "sas",
    accountName: "accountprivate",
    sasToken: "?sv=2025-01-05&sig=private-signature",
  },
  {
    provider: "Azure Blob Storage",
    azureAuth: "connectionString",
    connectionString:
      "DefaultEndpointsProtocol=https;AccountName=accountprivate;AccountKey=cHJpdmF0ZS1rZXk=;EndpointSuffix=core.windows.net",
  },
  {
    provider: "Google Cloud Storage",
    googleAuth: "file",
    keyFilename: "/private/service-account.json",
    projectId: "project",
  },
  {
    provider: "Google Cloud Storage",
    googleAuth: "default",
    projectId: "project",
  },
];
const key = randomBytes(32);
const safeStorage = {
  encryptString(value) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
  },
  decryptString(value) {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      value.subarray(0, 12),
    );
    decipher.setAuthTag(value.subarray(12, 28));
    return Buffer.concat([
      decipher.update(value.subarray(28)),
      decipher.final(),
    ]).toString("utf8");
  },
};

for (const sample of samples) {
  test(`${sample.provider}: normalize, encrypt, restore, and redact credentials`, () => {
    const profile = {
      ...normalizeProfile({
        ...sample,
        name: "  Work archive  ",
        bucket: "  backups  ",
        remember: true,
      }),
      id: "profile-1",
    };
    assert.equal(profile.name, "Work archive");
    assert.equal(profile.bucket, "backups");
    const stored = serializeProfile(profile, safeStorage);
    const visible = publicProfile(profile);
    const restored = restoreProfile(stored, safeStorage);
    assert.deepEqual(restored, profile);
    for (const field of CREDENTIAL_FIELDS) {
      assert.equal(Object.hasOwn(stored, field), false);
      assert.equal(Object.hasOwn(visible, field), false);
      if (profile[field]) {
        assert.equal(JSON.stringify(stored).includes(profile[field]), false);
        assert.equal(JSON.stringify(visible).includes(profile[field]), false);
      }
    }
    assert.equal(visible.credentials, undefined);
    assert.equal(visible.stored, undefined);
    assert.equal(stored.name, "Work archive");
    assert.equal(stored.bucket, "backups");
    assert.equal(visible.provider, sample.provider);
  });
}

test("existing encrypted S3 profiles remain compatible", () => {
  const credentials = {
    accessKeyId: "legacy-access",
    secretAccessKey: "legacy-secret",
    sessionToken: "",
  };
  const saved = {
    id: "old",
    name: "Old R2",
    provider: "Cloudflare R2",
    endpoint: "https://example.r2.cloudflarestorage.com",
    region: "auto",
    bucket: "archive",
    pathStyle: false,
    remember: true,
    credentials: safeStorage
      .encryptString(JSON.stringify(credentials))
      .toString("base64"),
  };
  const restored = restoreProfile(saved, safeStorage);
  for (const [field, value] of Object.entries(credentials))
    assert.equal(restored[field], value);
  assert.equal(restored.id, "old");
  assert.equal(restored.region, "auto");
  assert.deepEqual(
    restoreProfile(serializeProfile(restored, safeStorage), safeStorage),
    restored,
  );
});

test("a locked profile keeps the original encrypted payload without exposing it", () => {
  const saved = serializeProfile(
    {
      ...normalizeProfile({ ...samples[1], name: "Swift", remember: true }),
      id: "locked",
    },
    safeStorage,
  );
  const unavailable = {
    decryptString() {
      throw new Error("Locked keyring");
    },
    encryptString() {
      throw new Error("Must not encrypt locked profiles");
    },
  };
  const locked = restoreProfile(saved, unavailable);
  assert.equal(locked.locked, true);
  assert.equal(publicProfile(locked).locked, true);
  assert.equal(publicProfile(locked).stored, undefined);
  assert.equal(publicProfile(locked).credentials, undefined);
  assert.equal(serializeProfile(locked, unavailable), saved);
});

test("unknown fields cannot escape through public or saved metadata", () => {
  const profile = {
    ...normalizeProfile({ ...samples[0], name: "S3" }),
    private_key: "secret",
    credentials: "encrypted-secret",
    stored: { secret: "secret" },
    surpriseToken: "secret",
  };
  for (const cleaned of [
    publicProfile(profile),
    serializeProfile(profile, safeStorage),
  ]) {
    assert.equal(cleaned.private_key, undefined);
    assert.equal(cleaned.surpriseToken, undefined);
    assert.equal(cleaned.stored, undefined);
  }
  const saved = serializeProfile(profile, safeStorage);
  saved.credentials = safeStorage
    .encryptString(
      JSON.stringify({ name: "Injected", provider: "Other", ...samples[0] }),
    )
    .toString("base64");
  assert.equal(restoreProfile(saved, safeStorage).name, "S3");
});

test("provider validation rejects unknown providers and missing credentials", () => {
  assert.throws(
    () => normalizeProfile({ name: "test", provider: "Unknown" }),
    /supported/,
  );
  assert.throws(() => normalizeProfile(null), /supported/);
  for (const sample of samples) {
    assert.throws(
      () => normalizeProfile({ provider: sample.provider, name: "test" }),
      /required|valid Google/,
    );
    assert.throws(
      () => normalizeProfile({ ...sample, name: " " }),
      /name is required/,
    );
  }
  assert.throws(
    () =>
      normalizeProfile({ ...samples[0], name: "test", provider: "Custom S3" }),
    /endpoint is required/,
  );
  assert.throws(
    () =>
      normalizeProfile({
        ...samples[2],
        name: "test",
        accountName: "invalid/name",
      }),
    /account name/,
  );
});

test("endpoints reject malformed URLs and credential-bearing URL components", () => {
  for (const endpoint of [
    "not a URL",
    "https:example.com",
    "ftp://example.com",
    "https://user:password@example.com",
    "https://example.com/?token=secret",
    "https://example.com/#token",
    "https://example.com/path with spaces",
    "https://example.com\\path",
  ]) {
    assert.throws(
      () => normalizeProfile({ ...samples[0], name: "test", endpoint }),
      /HTTP or HTTPS/,
    );
  }
  assert.equal(
    normalizeProfile({
      ...samples[1],
      name: "test",
      endpoint: "http://127.0.0.1:8080/v1/AUTH_test",
    }).endpoint,
    "http://127.0.0.1:8080/v1/AUTH_test",
  );
});

test("Google JSON validation never includes pasted secrets in errors", () => {
  for (const json of [
    "secret-private-json",
    "null",
    "{}",
    JSON.stringify({
      type: "service_account",
      client_email: "x@y",
      private_key: "secret-private-key",
    }),
  ]) {
    assert.throws(
      () =>
        normalizeProfile({
          ...samples[3],
          name: "GCS",
          serviceAccountJson: json,
        }),
      (error) =>
        /valid Google service account/.test(error.message) &&
        !error.message.includes("secret-private"),
    );
  }
  const normalized = normalizeProfile({ ...samples[3], name: "GCS" });
  assert.equal(normalized.projectId, "example-project");
  const withoutProject = JSON.parse(serviceAccountJson);
  delete withoutProject.project_id;
  assert.throws(
    () =>
      normalizeProfile({
        ...samples[3],
        name: "GCS",
        serviceAccountJson: JSON.stringify(withoutProject),
      }),
    /project ID is required/,
  );
  assert.equal(
    normalizeProfile({
      ...samples[3],
      name: "GCS",
      projectId: " override-project ",
    }).projectId,
    "override-project",
  );
  assert.throws(
    () =>
      normalizeProfile({
        ...samples[3],
        name: "GCS",
        endpoint: "https://example.com",
      }),
    /standard Google API/,
  );
});

test("Swift link capability is derived from its secret without exposing it", () => {
  const input = { ...samples[1], name: "Swift" };
  assert.equal(
    publicProfile(normalizeProfile(input)).capabilities.signedUrl,
    true,
  );
  assert.equal(
    publicProfile(normalizeProfile({ ...input, swiftTempUrlKey: "" }))
      .capabilities.signedUrl,
    false,
  );
});

test("Swift token refresh keeps connection identity and encrypted credentials", () => {
  const old = {
    ...normalizeProfile({
      ...samples[1],
      name: "Swift",
      bucket: "archive",
      remember: true,
    }),
    id: "durable-connection",
  };
  const updated = refreshSwiftToken(old, "  replacement-secret-token  ");
  assert.equal(old.swiftToken, samples[1].swiftToken);
  assert.deepEqual(updated, { ...old, swiftToken: "replacement-secret-token" });
  const saved = serializeProfile(updated, safeStorage);
  assert.equal(saved.id, "durable-connection");
  assert.equal(saved.swiftToken, undefined);
  assert.equal(
    JSON.stringify(saved).includes("replacement-secret-token"),
    false,
  );
  assert.equal(publicProfile(updated).swiftToken, undefined);
  assert.equal(
    restoreProfile(saved, safeStorage).swiftToken,
    "replacement-secret-token",
  );
});

test("Swift token refresh rejects unavailable connections and invalid tokens", () => {
  const swift = { ...samples[1], id: "swift", name: "Swift" };
  assert.throws(() => refreshSwiftToken(undefined, "token"), /not found/);
  assert.throws(
    () => refreshSwiftToken({ ...swift, locked: true }, "token"),
    /Unlock/,
  );
  assert.throws(() => refreshSwiftToken(samples[0], "token"), /only available/);
  for (const token of ["", "   ", null, undefined, 7])
    assert.throws(() => refreshSwiftToken(swift, token), /token is required/);
});

test("authentication modes discard inactive secrets and enforce explicit credential selection", () => {
  const swift = normalizeProfile({
    ...samples[4],
    name: "Keystone",
    swiftToken: "stale",
  });
  assert.equal(swift.swiftToken, undefined);
  assert.equal(swift.password, " private-password ");
  assert.throws(() => refreshSwiftToken(swift, "new-token"), /automatically/);
  const sas = normalizeProfile({
    ...samples[5],
    name: "SAS",
    accountKey: "stale",
  });
  assert.equal(sas.accountKey, undefined);
  assert.equal(publicProfile(sas).capabilities.signedUrl, false);
  assert.equal(
    publicProfile(normalizeProfile({ ...samples[6], name: "key" })).capabilities
      .signedUrl,
    true,
  );
  const sasConnection = normalizeProfile({
    name: "SAS connection",
    provider: "Azure Blob Storage",
    connectionString:
      "BlobEndpoint=https://example.blob.core.windows.net;SharedAccessSignature=sv=2025-01-05&sig=secret",
  });
  assert.equal(publicProfile(sasConnection).capabilities.signedUrl, false);
  const adc = normalizeProfile({
    ...samples[8],
    name: "ADC",
    serviceAccountJson: "stale",
    keyFilename: "/stale",
  });
  assert.equal(adc.serviceAccountJson, undefined);
  assert.equal(adc.keyFilename, undefined);
  assert.throws(
    () =>
      normalizeProfile({
        ...samples[7],
        name: "file",
        keyFilename: "relative.json",
      }),
    /absolute path/,
  );
  assert.throws(
    () => normalizeProfile({ ...samples[8], name: "ADC", projectId: "" }),
    /project ID/,
  );
  assert.throws(
    () =>
      normalizeProfile({
        ...samples[6],
        name: "bad",
        connectionString: "invalid-secret",
      }),
    /valid Azure/,
  );
});
