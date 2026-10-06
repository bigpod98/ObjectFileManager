const { createPrivateKey } = require("node:crypto");
const { capabilities } = require("./provider-capabilities.cjs");

const PROVIDERS = [
  "Amazon S3",
  "Cloudflare R2",
  "Ceph",
  "MinIO",
  "Custom S3",
  "OpenStack Swift",
  "Azure Blob Storage",
  "Google Cloud Storage",
];
const CREDENTIAL_FIELDS = [
  "accessKeyId",
  "secretAccessKey",
  "sessionToken",
  "swiftToken",
  "swiftTempUrlKey",
  "accountName",
  "accountKey",
  "serviceAccountJson",
];
const METADATA_FIELDS = [
  "id",
  "name",
  "provider",
  "endpoint",
  "region",
  "bucket",
  "pathStyle",
  "projectId",
  "remember",
];
const pick = (value, fields) =>
  Object.fromEntries(
    fields
      .filter((field) => value[field] !== undefined)
      .map((field) => [field, value[field]]),
  );
const string = (value) => (typeof value === "string" ? value : "");

function normalizeProfile(input) {
  if (
    !input ||
    typeof input !== "object" ||
    !PROVIDERS.includes(input.provider)
  )
    throw new Error("Choose a supported storage provider.");
  const p = {
    name: string(input.name).trim(),
    provider: input.provider,
    endpoint: string(input.endpoint).trim(),
    bucket: string(input.bucket).trim(),
    remember: !!input.remember,
  };
  if (!p.name) throw new Error("A connection name is required.");
  if (p.endpoint) {
    let url;
    try {
      url = new URL(p.endpoint);
    } catch {}
    if (
      !/^https?:\/\//i.test(p.endpoint) ||
      /[\s\\]/.test(p.endpoint) ||
      !url?.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error(
        "Use an HTTP or HTTPS endpoint without embedded credentials, query, or fragment.",
      );
  }
  if (p.provider === "OpenStack Swift") {
    p.swiftToken = string(input.swiftToken).trim();
    p.swiftTempUrlKey = string(input.swiftTempUrlKey);
    if (!p.endpoint || !p.swiftToken)
      throw new Error(
        "The Swift account storage URL and authentication token are required.",
      );
  } else if (p.provider === "Azure Blob Storage") {
    p.accountName = string(input.accountName).trim();
    p.accountKey = string(input.accountKey).trim();
    if (!p.accountName || !p.accountKey)
      throw new Error(
        "The Azure storage account name and account key are required.",
      );
    if (!/^[a-z0-9]{3,24}$/.test(p.accountName))
      throw new Error(
        "Use an Azure storage account name with 3–24 lowercase letters or digits.",
      );
  } else if (p.provider === "Google Cloud Storage") {
    if (p.endpoint)
      throw new Error(
        "Google Cloud Storage uses its standard Google API endpoint.",
      );
    p.serviceAccountJson = string(input.serviceAccountJson).trim();
    let credentials;
    try {
      credentials = JSON.parse(p.serviceAccountJson);
      if (
        credentials.type !== "service_account" ||
        !/^[^\s@]+@[^\s@]+$/.test(credentials.client_email || "") ||
        createPrivateKey(credentials.private_key).asymmetricKeyType !== "rsa"
      )
        throw new Error();
    } catch {
      throw new Error(
        "Paste a valid Google service account JSON key containing type, client_email, and an RSA private_key.",
      );
    }
    p.projectId =
      string(input.projectId).trim() || string(credentials.project_id).trim();
    if (!p.projectId)
      throw new Error(
        "A Google Cloud project ID is required in the key or the Project ID field.",
      );
  } else {
    p.region = string(input.region).trim() || "us-east-1";
    p.pathStyle = !!input.pathStyle;
    p.accessKeyId = string(input.accessKeyId).trim();
    p.secretAccessKey = string(input.secretAccessKey);
    p.sessionToken = string(input.sessionToken);
    if (!p.accessKeyId || !p.secretAccessKey)
      throw new Error("An access key and secret key are required.");
    if (p.provider !== "Amazon S3" && !p.endpoint)
      throw new Error("An endpoint is required for this provider.");
  }
  return p;
}

function publicProfile(profile) {
  return {
    ...pick(profile, METADATA_FIELDS),
    capabilities: capabilities(profile),
    ...(profile.locked ? { locked: true } : {}),
  };
}

function refreshSwiftToken(profile, token) {
  if (!profile) throw new Error("Connection not found.");
  if (profile.locked)
    throw new Error(
      "Unlock your operating system keyring and restart S3 Browser before refreshing this connection.",
    );
  if (profile.provider !== "OpenStack Swift")
    throw new Error(
      "Token refresh is only available for OpenStack Swift connections.",
    );
  const swiftToken = string(token).trim();
  if (!swiftToken) throw new Error("A Swift authentication token is required.");
  return { ...profile, swiftToken };
}

function serializeProfile(profile, safeStorage) {
  if (profile.locked) return profile.stored;
  return {
    ...pick(profile, METADATA_FIELDS),
    credentials: safeStorage
      .encryptString(JSON.stringify(pick(profile, CREDENTIAL_FIELDS)))
      .toString("base64"),
  };
}

function restoreProfile(stored, safeStorage) {
  const metadata = pick(stored, METADATA_FIELDS);
  try {
    const credentials = JSON.parse(
      safeStorage.decryptString(Buffer.from(stored.credentials, "base64")),
    );
    return { ...metadata, ...pick(credentials, CREDENTIAL_FIELDS) };
  } catch {
    return { ...metadata, remember: true, locked: true, stored };
  }
}

module.exports = {
  PROVIDERS,
  CREDENTIAL_FIELDS,
  normalizeProfile,
  publicProfile,
  refreshSwiftToken,
  serializeProfile,
  restoreProfile,
};
