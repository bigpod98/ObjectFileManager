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
    case "Google Cloud Storage":
      return { ...defaults, multipart: false };
    default:
      return { ...defaults };
  }
}

function requireCapability(client, key, label) {
  if (capabilities(client)[key] === false)
    throw new Error(
      `${label} is not supported safely by this ${client.provider || "storage"} connection.`,
    );
}

module.exports = { capabilities, requireCapability };
