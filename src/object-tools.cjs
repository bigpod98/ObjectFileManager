const {
  ListObjectsV2Command,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  GetObjectCommand,
  ListMultipartUploadsCommand,
  AbortMultipartUploadCommand,
} = require("@aws-sdk/client-s3");
const { createHmac, randomBytes, timingSafeEqual } = require("node:crypto");

const PAGE_SIZE = 500;
const SEARCH_PAGES = 5;
const snapshotSecrets = new WeakMap();

function canonical(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}

function metadataSnapshot(s3, { profile, bucket, key }, head) {
  if (!snapshotSecrets.has(s3)) snapshotSecrets.set(s3, randomBytes(32));
  // Bind the reviewed response to this connection and object, including every
  // returned attribute except per-request SDK diagnostics. ETags alone do not
  // detect metadata-only changes. Recreating a connection invalidates its tokens.
  const { $metadata, ...attributes } = head;
  return createHmac("sha256", snapshotSecrets.get(s3))
    .update(JSON.stringify(canonical({ profile, bucket, key, attributes })))
    .digest("hex");
}

function required(value, label) {
  if (typeof value !== "string" || !value.length)
    throw new Error(`${label} is required.`);
  return value;
}

function objectArgs({ bucket, key }) {
  return {
    Bucket: required(bucket, "Bucket"),
    Key: required(key, "Object key"),
  };
}

function iso(value) {
  return value instanceof Date ? value.toISOString() : value || null;
}

async function operation(name, fn) {
  try {
    return await fn();
  } catch (error) {
    const code = error.name || error.Code || error.code;
    if (
      [
        "NotImplemented",
        "UnsupportedOperation",
        "MethodNotAllowed",
        "NotSupported",
      ].includes(code) ||
      [405, 501].includes(error.$metadata?.httpStatusCode)
    )
      throw new Error(`${name} is not supported by this storage provider.`, {
        cause: error,
      });
    if (
      ["AccessDenied", "Forbidden"].includes(code) ||
      error.$metadata?.httpStatusCode === 403
    )
      throw new Error(
        `${name} was denied. Check this connection's bucket permissions.`,
        { cause: error },
      );
    if (
      error.$metadata?.httpStatusCode === 412 ||
      code === "PreconditionFailed"
    )
      throw new Error(
        `${name} stopped because the object changed. Refresh it and try again.`,
        { cause: error },
      );
    throw error;
  }
}

async function search(s3, { bucket, prefix = "", query = "", token }) {
  required(bucket, "Bucket");
  if (typeof prefix !== "string" || typeof query !== "string")
    throw new Error("Search prefix and query must be text.");
  const needle = query.toLocaleLowerCase();
  return operation("Recursive search", async () => {
    const objects = [];
    let scanned = 0;
    let next = token || undefined;
    const seen = new Set();
    for (let page = 0; page < SEARCH_PAGES; page++) {
      if (next) seen.add(next);
      const result = await s3.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: next,
          MaxKeys: PAGE_SIZE,
        }),
      );
      for (const item of result.Contents || []) {
        scanned++;
        if (
          typeof item.Key !== "string" ||
          item.Key === prefix ||
          !item.Key.startsWith(prefix)
        )
          continue;
        if (!item.Key.slice(prefix.length).toLocaleLowerCase().includes(needle))
          continue;
        objects.push({
          key: item.Key,
          size: item.Size,
          modified: iso(item.LastModified),
          etag: item.ETag,
        });
      }
      next = result.IsTruncated ? result.NextContinuationToken : undefined;
      if (result.IsTruncated && (!next || seen.has(next)))
        throw new Error(
          "The storage provider returned an invalid search continuation token.",
        );
      if (!next) break;
    }
    return { folders: [], objects, token: next || null, scanned };
  });
}

async function details(s3, options) {
  const input = objectArgs(options);
  return operation("Object details", async () => {
    const head = await s3.send(new HeadObjectCommand(input));
    return {
      metadataSnapshot: metadataSnapshot(s3, options, head),
      key: options.key,
      size: head.ContentLength,
      etag: head.ETag,
      modified: iso(head.LastModified),
      contentType: head.ContentType || "",
      metadata: head.Metadata || {},
      versionId: head.VersionId || null,
      storageClass: head.StorageClass || "STANDARD",
      cacheControl: head.CacheControl || "",
      contentDisposition: head.ContentDisposition || "",
      contentEncoding: head.ContentEncoding || "",
      contentLanguage: head.ContentLanguage || "",
      expires: iso(head.Expires),
      encryption: head.ServerSideEncryption || "",
      kmsKeyId: head.SSEKMSKeyId || "",
      restore: head.Restore || "",
      objectLockMode: head.ObjectLockMode || "",
      objectLockRetainUntilDate: iso(head.ObjectLockRetainUntilDate),
      objectLockLegalHoldStatus: head.ObjectLockLegalHoldStatus || "",
    };
  });
}

async function versions(s3, { bucket, key, keyMarker, versionIdMarker }) {
  objectArgs({ bucket, key });
  if (versionIdMarker && !keyMarker)
    throw new Error("A version marker requires its key marker.");
  return operation("Object version history", async () => {
    const result = await s3.send(
      new ListObjectVersionsCommand({
        Bucket: bucket,
        Prefix: key,
        KeyMarker: keyMarker || undefined,
        VersionIdMarker: versionIdMarker || undefined,
        MaxKeys: PAGE_SIZE,
      }),
    );
    const rows = [
      ...(result.Versions || []).map((item) => ({
        ...item,
        deleteMarker: false,
      })),
      ...(result.DeleteMarkers || []).map((item) => ({
        ...item,
        deleteMarker: true,
      })),
    ]
      .filter((item) => item.Key === key)
      .map((item) => ({
        key: item.Key,
        versionId: item.VersionId,
        isLatest: !!item.IsLatest,
        deleteMarker: item.deleteMarker,
        size: item.Size || 0,
        modified: iso(item.LastModified),
        etag: item.ETag || null,
      }))
      .sort((a, b) => (b.modified || "").localeCompare(a.modified || ""));
    const more = result.IsTruncated && result.NextKeyMarker === key;
    if (
      more &&
      (!result.NextVersionIdMarker ||
        (keyMarker === result.NextKeyMarker &&
          versionIdMarker === result.NextVersionIdMarker))
    )
      throw new Error(
        "The storage provider returned invalid version pagination markers.",
      );
    return {
      versions: rows,
      keyMarker: more ? result.NextKeyMarker : null,
      versionIdMarker: more ? result.NextVersionIdMarker : null,
    };
  });
}

async function restore(s3, { bucket, key, versionId }) {
  const input = objectArgs({ bucket, key });
  required(versionId, "Version ID");
  return operation("Version restore", async () => {
    const head = await s3.send(
      new HeadObjectCommand({ ...input, VersionId: versionId }),
    );
    if (head.DeleteMarker)
      throw new Error(
        "Choose an object version to restore; delete markers contain no object data.",
      );
    let current;
    try {
      current = await s3.send(new HeadObjectCommand(input));
    } catch (error) {
      if (
        error.$metadata?.httpStatusCode !== 404 &&
        !["NotFound", "NoSuchKey"].includes(error.name)
      )
        throw error;
    }
    const { copyObject } = require("./operations.cjs");
    const result = await copyObject(s3, {
      bucket,
      key,
      size: head.ContentLength,
      etag: head.ETag,
      versionId,
      sourceHead: head,
      destinationEtag: current?.ETag,
      attributes: {},
    });
    if (!result.etag)
      throw new Error(
        "The storage provider did not confirm the restored object.",
      );
    return result;
  });
}

async function metadata(s3, options) {
  const {
    bucket,
    key,
    metadata: values,
    contentType,
    expectedSnapshot,
  } = options;
  const input = objectArgs({ bucket, key });
  if (!values || typeof values !== "object" || Array.isArray(values))
    throw new Error("Metadata must be an object of text keys and values.");
  const normalized = Object.create(null);
  for (const [name, value] of Object.entries(values)) {
    if (
      !name ||
      /[\r\n]/.test(name) ||
      typeof value !== "string" ||
      /[\r\n]/.test(value)
    )
      throw new Error(
        "Metadata keys and values must be text without line breaks.",
      );
    if (Object.hasOwn(normalized, name.toLowerCase()))
      throw new Error("Metadata keys must be unique regardless of case.");
    normalized[name.toLowerCase()] = value;
  }
  if (
    contentType !== undefined &&
    (typeof contentType !== "string" ||
      !contentType.trim() ||
      /[\r\n]/.test(contentType))
  )
    throw new Error("Content type must be nonempty text without line breaks.");
  if (
    typeof expectedSnapshot !== "string" ||
    !/^[a-f0-9]{64}$/.test(expectedSnapshot)
  )
    throw new Error("Refresh object details before editing metadata.");
  return operation("Metadata editing", async () => {
    const head = await s3.send(new HeadObjectCommand(input));
    if (
      !timingSafeEqual(
        Buffer.from(expectedSnapshot, "hex"),
        Buffer.from(metadataSnapshot(s3, options, head), "hex"),
      )
    )
      throw new Error(
        "Metadata editing stopped because the object changed or its connection changed. Refresh object details and review your edits again.",
      );
    // S3's copy preconditions guard ETags, not arbitrary metadata or destination
    // version IDs. This review check detects changes before HEAD; a same-ETag
    // write between HEAD and copy cannot be excluded atomically by that API.
    const { copyObject } = require("./operations.cjs");
    const result = await copyObject(s3, {
      bucket,
      key,
      size: head.ContentLength,
      etag: head.ETag,
      versionId: head.VersionId,
      sourceHead: head,
      destinationEtag: head.ETag,
      attributes: {
        Metadata: normalized,
        ...(contentType !== undefined ? { ContentType: contentType } : {}),
      },
    });
    if (!result.etag)
      throw new Error(
        "The storage provider did not confirm the metadata update.",
      );
    return result;
  });
}

async function signedUrl(s3, { bucket, key, expiresIn = 3600 }) {
  const input = objectArgs({ bucket, key });
  if (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > 604800)
    throw new Error(
      "Link lifetime must be between 1 and 604800 seconds (seven days). Temporary credentials may expire sooner.",
    );
  const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
  return operation("Expiring download link", () =>
    getSignedUrl(s3, new GetObjectCommand(input), { expiresIn }),
  );
}

async function multipart(
  s3,
  { bucket, prefix = "", keyMarker, uploadIdMarker },
) {
  required(bucket, "Bucket");
  if (typeof prefix !== "string")
    throw new Error("Upload prefix must be text.");
  if (uploadIdMarker && !keyMarker)
    throw new Error("An upload marker requires its key marker.");
  return operation("Unfinished multipart upload listing", async () => {
    const result = await s3.send(
      new ListMultipartUploadsCommand({
        Bucket: bucket,
        // Some compatible providers omit nested uploads when Prefix is supplied.
        // Filter a bounded bucket page locally and retain both provider markers.
        KeyMarker: keyMarker || undefined,
        UploadIdMarker: uploadIdMarker || undefined,
        MaxUploads: PAGE_SIZE,
      }),
    );
    if (
      result.IsTruncated &&
      (!result.NextKeyMarker ||
        (result.NextKeyMarker === keyMarker &&
          result.NextUploadIdMarker === uploadIdMarker))
    )
      throw new Error(
        "The storage provider returned invalid multipart pagination markers.",
      );
    return {
      uploads: (result.Uploads || [])
        .filter(
          (item) => typeof item.Key === "string" && item.Key.startsWith(prefix),
        )
        .map((item) => ({
          key: item.Key,
          uploadId: item.UploadId,
          initiated: iso(item.Initiated),
          storageClass: item.StorageClass,
        })),
      keyMarker: result.IsTruncated ? result.NextKeyMarker : null,
      uploadIdMarker: result.IsTruncated
        ? result.NextUploadIdMarker || null
        : null,
    };
  });
}

async function abortMultipart(s3, { bucket, key, uploadId }) {
  const input = {
    ...objectArgs({ bucket, key }),
    UploadId: required(uploadId, "Upload ID"),
  };
  return operation("Multipart upload cleanup", async () => {
    await s3.send(new AbortMultipartUploadCommand(input));
    return { key, uploadId, aborted: true };
  });
}

module.exports = {
  search,
  details,
  versions,
  restore,
  metadata,
  signedUrl,
  multipart,
  abortMultipart,
};
