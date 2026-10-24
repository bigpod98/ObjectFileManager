const {
  S3Client,
  ListBucketsCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  AbortMultipartUploadCommand,
} = require("@aws-sdk/client-s3");
const { Upload } = require("@aws-sdk/lib-storage");
const { Transform } = require("node:stream");
const { createHash } = require("node:crypto");
const { validateUploadSource, openUploadSource } = require("./queue.cjs");
const mime = require("mime-types");
function client(profile) {
  const adapters = {
    "OpenStack Swift": "./providers/swift.cjs",
    "Azure Blob Storage": "./providers/azure.cjs",
    "Google Cloud Storage": "./providers/gcs.cjs",
  };
  if (Object.hasOwn(adapters, profile.provider))
    return require(adapters[profile.provider]).client(profile);
  return new S3Client({
    region: profile.region || "us-east-1",
    endpoint: profile.endpoint || undefined,
    forcePathStyle: !!profile.pathStyle,
    credentials: {
      accessKeyId: profile.accessKeyId,
      secretAccessKey: profile.secretAccessKey,
      ...(profile.sessionToken ? { sessionToken: profile.sessionToken } : {}),
    },
    maxAttempts: 5,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    requestHandler: { connectionTimeout: 15000, requestTimeout: 120000 },
  });
}
async function buckets(s3) {
  const names = [];
  const seen = new Set();
  let token;
  do {
    const page = await s3.send(
      new ListBucketsCommand({ MaxBuckets: 1000, ContinuationToken: token }),
    );
    names.push(...(page.Buckets || []).map((bucket) => bucket.Name));
    token = page.ContinuationToken;
    if (token != null && token !== "") {
      if (typeof token !== "string" || seen.has(token))
        throw new Error("Storage returned invalid bucket pagination.");
      seen.add(token);
    }
  } while (token);
  return names;
}
async function browse(s3, bucket, prefix = "", token) {
  const r = await s3.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      Delimiter: "/",
      ContinuationToken: token || undefined,
      MaxKeys: 500,
    }),
  );
  for (const key of [
    ...(r.Contents || []).map((object) => object.Key),
    ...(r.CommonPrefixes || []).map((folder) => folder.Prefix),
  ]) {
    if (typeof key !== "string" || !key || !key.startsWith(prefix))
      throw new Error(
        "Storage returned an object outside the requested folder.",
      );
  }
  return {
    folders: (r.CommonPrefixes || []).map((p) => p.Prefix),
    objects: (r.Contents || [])
      .filter((o) => o.Key !== prefix)
      .map((o) => ({
        key: o.Key,
        size: o.Size,
        modified: o.LastModified?.toISOString(),
        etag: o.ETag,
      })),
    token: r.NextContinuationToken || null,
  };
}
// Metadata identifies this durable queue operation, while hashing the returned
// body proves that copied metadata or a concurrent write did not change bytes.
// Undefined means absent; false means present but not verified.
async function reconcileUpload(s3, job, entry, signal) {
  let result;
  try {
    result = await s3.send(
      new GetObjectCommand({ Bucket: job.bucket, Key: entry.key }),
      { abortSignal: signal },
    );
  } catch (error) {
    if (error.$metadata?.httpStatusCode === 404 || error.name === "NoSuchKey")
      return undefined;
    throw error;
  }
  try {
    if (
      result.Metadata?.["objectfilemanager-upload-token"] !==
        entry.uploadToken ||
      result.Metadata?.["objectfilemanager-sha256"] !== entry.sha256 ||
      result.ContentLength !== entry.size
    )
      return false;
    if (!result.Body || !result.Body[Symbol.asyncIterator])
      throw new Error(
        "Cannot verify the previous upload: object body unavailable.",
      );
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of result.Body) {
      signal.throwIfAborted();
      if (job.throttle) await job.throttle(chunk.length, signal);
      hash.update(chunk);
      size += chunk.length;
    }
    signal.throwIfAborted();
    return size === entry.size && hash.digest("base64") === entry.sha256;
  } finally {
    result.Body?.destroy?.();
  }
}
async function transfer(s3, job, entry, signal, onProgress) {
  if (entry.integrityPending) {
    const verified =
      entry.uploadToken && entry.sha256
        ? await reconcileUpload(s3, job, entry, signal)
        : false;
    if (verified === true) return;
    if (verified !== undefined)
      throw new Error(
        "The previous upload has not passed integrity verification. The remote object was left unchanged; review it before retrying.",
      );
    // A missing object can be retried. Existence alone must never be accepted
    // as success if another object appears between this read and the write.
  }
  const recoverable = !!(
    (entry.expectedAbsent || entry.etag) &&
    entry.uploadToken &&
    entry.sha256
  );
  if (
    recoverable &&
    entry.attempts > 1 &&
    (await reconcileUpload(s3, job, entry, signal))
  )
    return;
  try {
    return await uploadObject(s3, job, entry, signal, onProgress);
  } catch (error) {
    // A lost PutObject/CompleteMultipartUpload reply can be followed by a 412
    // even during the SDK's own retries. A matching verified object is the
    // only success evidence; permission/read failures must remain failures.
    if (
      recoverable &&
      !signal.aborted &&
      (await reconcileUpload(s3, job, entry, signal))
    )
      return;
    throw error;
  }
}
async function uploadObject(s3, job, entry, signal, onProgress) {
  const recoveringIntegrity = !!entry.integrityPending;
  if (entry.etag)
    require("./provider-capabilities.cjs").requireCapability(
      s3,
      "conditionalWrite",
      "Replacing reviewed objects",
    );
  const skipExisting = !job.overwrite && !entry.expectedAbsent && !entry.etag;
  if (skipExisting) {
    try {
      await s3.send(
        new HeadObjectCommand({ Bucket: job.bucket, Key: entry.key }),
        { abortSignal: signal },
      );
      if (recoveringIntegrity)
        throw new Error(
          "The previous upload has not passed integrity verification.",
        );
      return "skipped";
    } catch (e) {
      if (e.$metadata?.httpStatusCode !== 404 && e.name !== "NotFound") throw e;
    }
  }
  if (signal.aborted) throw new Error("Paused");
  const condition =
    entry.expectedAbsent || skipExisting
      ? { IfNoneMatch: "*" }
      : entry.etag
        ? { IfMatch: entry.etag }
        : {};
  const metadata =
    entry.uploadToken && entry.sha256
      ? {
          Metadata: {
            "objectfilemanager-upload-token": entry.uploadToken,
            "objectfilemanager-sha256": entry.sha256,
          },
        }
      : {};
  const markIntegrityPending = () => {
    if (s3.provider !== "Google Cloud Storage") return;
    entry.markIntegrityPending?.();
    entry.integrityPending = 1;
  };
  if (entry.directory) {
    await validateUploadSource(entry);
    if (entry.sha256 && entry.sha256 !== createHash("sha256").digest("base64"))
      throw new Error(
        "Source content changed since scanning. Create a new batch.",
      );
    markIntegrityPending();
    await s3.send(
      new PutObjectCommand({
        Bucket: job.bucket,
        Key: entry.key,
        Body: Buffer.alloc(0),
        ContentLength: 0,
        ContentType: "application/x-directory",
        ...condition,
        ...metadata,
      }),
      { abortSignal: signal },
    );
    return;
  }
  const handle = await openUploadSource(entry);
  try {
    signal.throwIfAborted();
    const source = handle.createReadStream({ autoClose: false });
    const hash = entry.sha256 ? createHash("sha256") : null;
    let size = 0;
    const limiter =
      job.throttle || hash
        ? new Transform({
            transform(chunk, encoding, callback) {
              hash?.update(chunk);
              size += chunk.length;
              Promise.resolve(job.throttle?.(chunk.length, signal)).then(
                () => callback(null, chunk),
                callback,
              );
            },
            flush(callback) {
              if (
                hash &&
                (size !== entry.size || hash.digest("base64") !== entry.sha256)
              )
                callback(
                  new Error(
                    "Source content changed since scanning. Create a new batch.",
                  ),
                );
              else callback();
            },
          })
        : null;
    const body = limiter ? source.pipe(limiter) : source;
    const onSourceError = (error) => body.destroy(error);
    if (limiter) source.on("error", onSourceError);
    // Native providers own their block/resumable transport while sharing queue
    // throttling, source validation, recovery metadata and cancellation.
    if (typeof s3.upload === "function") {
      const abort = () =>
        body.destroy(
          Object.assign(new Error("Upload paused"), { name: "AbortError" }),
        );
      signal.addEventListener("abort", abort, { once: true });
      try {
        signal.throwIfAborted();
        markIntegrityPending();
        await s3.upload(
          {
            Bucket: job.bucket,
            Key: entry.key,
            Body: body,
            ContentLength: entry.size,
            ContentType: mime.lookup(entry.key) || "application/octet-stream",
            ...condition,
            ...metadata,
          },
          { abortSignal: signal, onProgress: onProgress || (() => {}) },
        );
      } catch (error) {
        if (
          skipExisting &&
          !recoveringIntegrity &&
          error.$metadata?.httpStatusCode === 412
        )
          return "skipped";
        throw error;
      } finally {
        signal.removeEventListener("abort", abort);
        source.destroy();
        body.destroy();
      }
      return;
    }
    // Scope cancellation to this file, while allowing multipart cleanup to finish.
    // Upload.abort() alone races its worker and can leave HTTP requests in flight.
    const scopedClient = {
      config: s3.config,
      send: (command) =>
        s3.send(
          command,
          command instanceof AbortMultipartUploadCommand
            ? {}
            : { abortSignal: signal },
        ),
    };
    const upload = new Upload({
      client: scopedClient,
      params: {
        Bucket: job.bucket,
        Key: entry.key,
        Body: body,
        ContentLength: entry.size,
        ContentType: mime.lookup(entry.key) || "application/octet-stream",
        ...condition,
        ...metadata,
      },
      queueSize: 1,
      partSize: Math.max(8 * 1024 * 1024, Math.ceil(entry.size / 10000)),
      leavePartsOnError: false,
    });
    const abort = () =>
      body.destroy(
        Object.assign(new Error("Upload paused"), { name: "AbortError" }),
      );
    signal.addEventListener("abort", abort, { once: true });
    upload.on("httpUploadProgress", (p) => onProgress(p.loaded || 0));
    try {
      await upload.done();
    } catch (e) {
      if (skipExisting && e.$metadata?.httpStatusCode === 412) return "skipped";
      throw e;
    } finally {
      signal.removeEventListener("abort", abort);
      source.destroy();
      body.destroy();
    }
  } finally {
    await handle.close();
  }
}
module.exports = { client, buckets, browse, transfer, ListBucketsCommand };
