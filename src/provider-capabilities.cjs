// Missing capability declarations retain compatibility with existing S3 clients.
const defaults = {
  conditionalWrite: true,
  createOnlyWrite: true,
  conditionalDelete: true,
  copy: true,
  metadata: true,
  versions: true,
  signedUrl: true,
  multipart: true,
};

function capabilities(connection = {}) {
  if (connection.capabilities)
    return { ...defaults, ...connection.capabilities };
  switch (connection.provider) {
    case "OpenStack Swift":
      return {
        ...defaults,
        conditionalWrite: false,
        conditionalDelete: false,
        metadata: false,
        versions: false,
        signedUrl: !!connection.swiftTempUrlKey,
        multipart: false,
      };
    case "Azure Blob Storage":
      return {
        ...defaults,
        multipart: false,
        signedUrl:
          connection.azureAuth !== "sas" &&
          !connection.sasToken &&
          (!connection.connectionString ||
            /(?:^|;)AccountKey=|^UseDevelopmentStorage=true(?:;|$)/i.test(
              connection.connectionString,
            )),
      };
    case "Google Cloud Storage":
      // ADC and key files need runtime resolution: user ADC cannot sign, while
      // service accounts and impersonated credentials may use IAM signBlob.
      return {
        ...defaults,
        multipart: false,
        signedUrl: googleLocalSigner(connection),
      };
    default:
      return { ...defaults };
  }
}

function googleLocalSigner(connection) {
  if (connection.googleAuth && connection.googleAuth !== "json") return false;
  if (!connection.googleAuth && connection.keyFilename) return false;
  try {
    const key = JSON.parse(connection.serviceAccountJson || connection.keyFile);
    return (
      key?.type === "service_account" && !!key.client_email && !!key.private_key
    );
  } catch {
    return false;
  }
}

function requireCapability(client, key, label) {
  if (capabilities(client)[key] === false)
    throw new Error(
      `${label} is not supported safely by this ${client.provider || "storage"} connection.`,
    );
}

module.exports = { capabilities, requireCapability };
