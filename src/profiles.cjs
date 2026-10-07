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
  "connectionString",
  "sasToken",
  "username",
  "password",
  "keyFilename",
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
  "swiftAuth",
  "authUrl",
  "projectName",
  "domainName",
  "domainId",
  "googleAuth",
  "azureAuth",
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
    p.swiftAuth = input.swiftAuth || (input.authUrl ? "keystone" : "token");
    if (!["token", "keystone"].includes(p.swiftAuth))
      throw new Error("Choose a supported Swift authentication method.");
    p.swiftToken = string(input.swiftToken).trim();
    p.swiftTempUrlKey = string(input.swiftTempUrlKey || input.tempUrlKey);
    if (p.swiftAuth === "keystone") {
      p.endpoint = "";
      p.authUrl = string(input.authUrl).trim();
      require("./providers/keystone.cjs").tokenUrl(p.authUrl);
      p.username = string(input.username).trim();
      p.password = string(input.password);
      p.projectName = string(input.projectName).trim();
      p.projectId = string(input.projectId).trim();
      p.domainName = string(input.domainName).trim() || "Default";
      p.domainId = string(input.domainId).trim();
      p.region = string(input.region).trim();
      delete p.swiftToken;
      if (!p.username || !p.password || (!p.projectName && !p.projectId))
        throw new Error(
          "Keystone requires a username, password, and project name or ID.",
        );
    } else if (!p.endpoint || !p.swiftToken)
      throw new Error(
        "The Swift account storage URL and authentication token are required.",
      );
  } else if (p.provider === "Azure Blob Storage") {
    p.azureAuth =
      input.azureAuth ||
      (input.connectionString
        ? "connectionString"
        : input.sasToken
          ? "sas"
          : "key");
    if (!["key", "sas", "connectionString"].includes(p.azureAuth))
      throw new Error("Choose a supported Azure authentication method.");
    p.accountName = string(input.accountName).trim();
    if (p.azureAuth === "connectionString") {
      p.connectionString = string(input.connectionString).trim();
      if (!p.connectionString)
        throw new Error("An Azure connection string is required.");
      // Validate locally; constructing the SDK client makes no network request.
      try {
        require("@azure/storage-blob").BlobServiceClient.fromConnectionString(
          p.connectionString,
        );
      } catch {
        throw new Error("Enter a valid Azure Blob connection string.");
      }
      p.endpoint = "";
      delete p.accountName;
    } else {
      if (p.azureAuth === "sas") {
        p.sasToken = string(input.sasToken).trim().replace(/^\?/, "");
        if (!new URLSearchParams(p.sasToken).get("sig"))
          throw new Error(
            "An Azure SAS token containing a signature is required.",
          );
      } else p.accountKey = string(input.accountKey).trim();
      if (!p.accountName || (p.azureAuth === "key" && !p.accountKey))
        throw new Error(
          "The Azure storage account name and account key are required.",
        );
      if (!/^[a-z0-9]{3,24}$/.test(p.accountName))
        throw new Error(
          "Use an Azure storage account name with 3–24 lowercase letters or digits.",
        );
    }
  } else if (p.provider === "Google Cloud Storage") {
    if (p.endpoint)
      throw new Error(
        "Google Cloud Storage uses its standard Google API endpoint.",
      );
    p.googleAuth = input.googleAuth || (input.keyFilename ? "file" : "json");
    if (!["json", "file", "default"].includes(p.googleAuth))
      throw new Error("Choose a supported Google authentication method.");
    if (p.googleAuth !== "json") {
      p.projectId = string(input.projectId).trim();
      if (!p.projectId)
        throw new Error("A Google Cloud project ID is required.");
      if (p.googleAuth === "file") {
        p.keyFilename = string(input.keyFilename).trim();
        if (!require("node:path").isAbsolute(p.keyFilename))
          throw new Error(
            "Use an absolute path to the Google service account key file.",
          );
      }
      return p;
    }
    p.serviceAccountJson = string(
      input.serviceAccountJson || input.keyFile,
    ).trim();
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
  if (profile.swiftAuth === "keystone" || profile.authUrl)
    throw new Error("Keystone connections refresh their tokens automatically.");
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
    if (
      !credentials ||
      typeof credentials !== "object" ||
      Array.isArray(credentials) ||
      CREDENTIAL_FIELDS.some(
        (field) =>
          credentials[field] !== undefined &&
          typeof credentials[field] !== "string",
      )
    )
      throw new Error("Invalid stored credentials");
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
