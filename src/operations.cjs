const {
  ListObjectsV2Command,
  HeadObjectCommand,
  PutObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCopyCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  GetObjectTaggingCommand,
} = require("@aws-sdk/client-s3");

const GiB = 1024 ** 3;
const attributesToPreserve = [
  "Metadata",
  "ContentType",
  "ContentEncoding",
  "ContentDisposition",
  "ContentLanguage",
  "CacheControl",
  "Expires",
  "WebsiteRedirectLocation",
  "StorageClass",
  "ServerSideEncryption",
  "SSEKMSKeyId",
  "BucketKeyEnabled",
  "ObjectLockMode",
  "ObjectLockRetainUntilDate",
  "ObjectLockLegalHoldStatus",
];
const prefixOf = (value = "") =>
  value && !value.endsWith("/") ? `${value}/` : value;
const notFound = (error) =>
  error?.$metadata?.httpStatusCode === 404 ||
  ["NotFound", "NoSuchKey"].includes(error?.name);
const date = (value) => (value ? new Date(value).toISOString() : undefined);

function snapshot(key, head) {
  if (
    !head.ETag ||
    !Number.isSafeInteger(head.ContentLength) ||
    head.ContentLength < 0
  )
    throw new Error(
      `Cannot safely snapshot ${key}: the server omitted its ETag or size.`,
    );
  return {
    key,
    size: head.ContentLength,
    etag: head.ETag,
    lastModified: date(head.LastModified),
    versionId: head.VersionId,
  };
}

async function head(s3, bucket, key) {
  return s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
}

async function unchanged(s3, bucket, item) {
  const current = await head(s3, bucket, item.key);
  if (
    current.ETag !== item.etag ||
    current.ContentLength !== item.size ||
    (item.versionId !== undefined && current.VersionId !== item.versionId) ||
    (item.lastModified && date(current.LastModified) !== item.lastModified)
  )
    throw new Error(
      `Source changed since preview: ${item.key}. Review a new preview.`,
    );
  return current;
}

async function absent(s3, bucket, key) {
  try {
    await head(s3, bucket, key);
  } catch (error) {
    if (notFound(error)) return;
    throw error;
  }
  throw new Error(
    `Destination already exists: ${key}. Choose another destination.`,
  );
}

async function preview(
  s3,
  {
    bucket,
    selection,
    destinationBucket = bucket,
    destinationPrefix = "",
    sourcePrefix = "",
    action,
  },
) {
  if (!["copy", "move", "delete"].includes(action))
    throw new Error("Unknown object operation.");
  if (!bucket || !Array.isArray(selection) || !selection.length)
    throw new Error("Select at least one object or folder.");
  sourcePrefix = prefixOf(sourcePrefix);
  destinationPrefix = prefixOf(destinationPrefix);
  if (action !== "delete" && !destinationBucket)
    throw new Error("A destination bucket is required.");
  const keys = new Set(),
    folders = [];
  for (const selected of selection) {
    if (
      typeof selected.key !== "string" ||
      !selected.key ||
      !selected.key.startsWith(sourcePrefix)
    )
      throw new Error(
        "Selection must contain keys within the source location.",
      );
    if (!selected.folder) {
      keys.add(selected.key);
      continue;
    }
    const prefix = prefixOf(selected.key);
    folders.push(prefix);
    let token;
    const seenTokens = new Set();
    do {
      const page = await s3.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: token,
        }),
      );
      for (const object of page.Contents || []) {
        if (typeof object.Key !== "string" || !object.Key.startsWith(prefix))
          throw new Error(
            "The server returned an object outside the selected folder.",
          );
        keys.add(object.Key);
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
      if (page.IsTruncated && (!token || seenTokens.has(token)))
        throw new Error("The server returned invalid folder pagination.");
      if (token) seenTokens.add(token);
    } while (token);
  }
  const items = [],
    destinations = new Set();
  for (const key of [...keys].sort()) {
    const item = snapshot(key, await head(s3, bucket, key));
    if (action !== "delete") {
      const relative = key.slice(sourcePrefix.length);
      if (!relative) throw new Error("Select a child folder or file to copy.");
      item.destinationKey = destinationPrefix + relative;
      if (
        bucket === destinationBucket &&
        (keys.has(item.destinationKey) ||
          folders.some((folder) => item.destinationKey.startsWith(folder)))
      )
        throw new Error(
          "Source and destination overlap. Choose a separate destination.",
        );
      if (destinations.has(item.destinationKey))
        throw new Error("Multiple sources map to the same destination.");
      destinations.add(item.destinationKey);
      await absent(s3, destinationBucket, item.destinationKey);
    }
    items.push(item);
  }
  return {
    action,
    bucket,
    sourcePrefix,
    destinationBucket,
    destinationPrefix,
    items,
    count: items.length,
    bytes: items.reduce((sum, item) => sum + item.size, 0),
  };
}

function preserve(head) {
  return Object.fromEntries(
    attributesToPreserve
      .filter((key) => head[key] !== undefined)
      .map((key) => [key, head[key]]),
  );
}

// Conditions are never retried without their guards: incompatible providers must fail closed.
async function copyObject(
  s3,
  {
    bucket,
    key,
    destinationBucket = bucket,
    destinationKey = key,
    size,
    etag,
    versionId,
    attributes,
    sourceHead,
    destinationEtag,
  },
) {
  if (!etag || !Number.isSafeInteger(size) || size < 0)
    throw new Error("Copy requires a source ETag and size.");
  const copySource = `${encodeURIComponent(bucket)}/${key.split("/").map(encodeURIComponent).join("/")}${versionId !== undefined ? `?versionId=${encodeURIComponent(versionId)}` : ""}`;
  const target = { Bucket: destinationBucket, Key: destinationKey };
  const condition = destinationEtag
    ? { IfMatch: destinationEtag }
    : { IfNoneMatch: "*" };
  const source = { CopySource: copySource, CopySourceIfMatch: etag };
  if (size <= 5 * GiB) {
    const result = await s3.send(
      new CopyObjectCommand({
        ...target,
        ...source,
        ...condition,
        ...(attributes
          ? {
              ...preserve(sourceHead || {}),
              ...attributes,
              MetadataDirective: "REPLACE",
              TaggingDirective: "COPY",
            }
          : {}),
      }),
    );
    return { etag: result.CopyObjectResult?.ETag, versionId: result.VersionId };
  }
  sourceHead ||= await s3.send(
    new HeadObjectCommand({
      Bucket: bucket,
      Key: key,
      VersionId: versionId,
      IfMatch: etag,
    }),
  );
  if (sourceHead.ETag !== etag || sourceHead.ContentLength !== size)
    throw new Error("Source changed before multipart copy.");
  const tags = await s3.send(
    new GetObjectTaggingCommand({
      Bucket: bucket,
      Key: key,
      VersionId: versionId,
    }),
  );
  const tagging = (tags.TagSet || [])
    .map(
      ({ Key, Value }) =>
        `${encodeURIComponent(Key)}=${encodeURIComponent(Value)}`,
    )
    .join("&");
  const started = await s3.send(
    new CreateMultipartUploadCommand({
      ...target,
      ...preserve(sourceHead),
      ...attributes,
      ...(tagging ? { Tagging: tagging } : {}),
    }),
  );
  if (!started.UploadId)
    throw new Error("The server did not return a multipart upload ID.");
  const upload = { ...target, UploadId: started.UploadId };
  try {
    // Keep every part under S3's 5 GiB limit and the total under 10,000 parts.
    const partSize = Math.max(512 * 1024 ** 2, Math.ceil(size / 10000));
    if (partSize > 5 * GiB)
      throw new Error("Object exceeds the supported multipart copy size.");
    const parts = [];
    for (let start = 0, part = 1; start < size; start += partSize, part++) {
      const result = await s3.send(
        new UploadPartCopyCommand({
          ...upload,
          ...source,
          PartNumber: part,
          CopySourceRange: `bytes=${start}-${Math.min(start + partSize, size) - 1}`,
        }),
      );
      if (!result.CopyPartResult?.ETag)
        throw new Error(`The server did not verify copied part ${part}.`);
      parts.push({ PartNumber: part, ETag: result.CopyPartResult.ETag });
    }
    const result = await s3.send(
      new CompleteMultipartUploadCommand({
        ...upload,
        ...condition,
        MultipartUpload: { Parts: parts },
      }),
    );
    return { etag: result.ETag, versionId: result.VersionId };
  } catch (error) {
    try {
      await s3.send(new AbortMultipartUploadCommand(upload));
    } catch (cleanup) {
      error.message += ` Multipart cleanup also failed: ${cleanup.message}`;
    }
    throw error;
  }
}

async function execute(s3, plan) {
  if (
    !plan ||
    !["copy", "move", "delete"].includes(plan.action) ||
    !plan.bucket ||
    !Array.isArray(plan.items)
  )
    throw new Error("Invalid operation preview.");
  const result = {
    action: plan.action,
    total: plan.items.length,
    succeeded: 0,
    failed: 0,
    copied: 0,
    deleted: 0,
    failures: [],
  };
  const sources = new Set(plan.items.map((item) => item.key)),
    destinations = new Set();
  for (const item of plan.items) {
    if (
      !item.key ||
      !item.etag ||
      !Number.isSafeInteger(item.size) ||
      item.size < 0
    )
      throw new Error("Operation preview is missing an object snapshot.");
    if (plan.action !== "delete") {
      if (
        !plan.destinationBucket ||
        !item.destinationKey ||
        destinations.has(item.destinationKey) ||
        (plan.bucket === plan.destinationBucket &&
          sources.has(item.destinationKey))
      )
        throw new Error(
          "Invalid or overlapping destination in operation preview.",
        );
      destinations.add(item.destinationKey);
    }
  }
  for (const item of plan.items) {
    let stage = "validate";
    try {
      const sourceHead = await unchanged(s3, plan.bucket, item);
      if (plan.action !== "delete") {
        stage = "copy";
        await absent(s3, plan.destinationBucket, item.destinationKey);
        const copied = await copyObject(s3, {
          bucket: plan.bucket,
          ...item,
          destinationBucket: plan.destinationBucket,
          sourceHead,
        });
        result.copied++;
        stage = "verify";
        const target = await head(
          s3,
          plan.destinationBucket,
          item.destinationKey,
        );
        if (
          !copied.etag ||
          target.ETag !== copied.etag ||
          target.ContentLength !== item.size ||
          (copied.versionId !== undefined &&
            target.VersionId !== copied.versionId)
        )
          throw new Error(
            "Destination verification failed; source was retained.",
          );
      }
      if (plan.action !== "copy") {
        stage = "delete";
        // A move may have taken hours. Recheck after copy and use a server-side guard too.
        await unchanged(s3, plan.bucket, item);
        await s3.send(
          new DeleteObjectCommand({
            Bucket: plan.bucket,
            Key: item.key,
            IfMatch: item.etag,
          }),
        );
        result.deleted++;
      }
      result.succeeded++;
    } catch (error) {
      result.failed++;
      result.failures.push({
        key: item.key,
        destinationKey: item.destinationKey,
        stage,
        error: error.message || String(error),
      });
    }
  }
  return result;
}

async function createFolder(s3, bucket, prefix) {
  if (!bucket || typeof prefix !== "string" || !prefix)
    throw new Error("A bucket and folder name are required.");
  const key = prefixOf(prefix);
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: "",
      ContentType: "application/x-directory",
      IfNoneMatch: "*",
    }),
  );
  return { bucket, key };
}

module.exports = { preview, execute, createFolder, copyObject };
