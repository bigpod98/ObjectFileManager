// Translate the application's object-storage commands to Azure's native Blob API.
const { randomUUID, createHash } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const metadataPrefix = "s3browser_meta_";
const metadataMarker = "s3browser_metadata_encoding";
function encodeMetadata(metadata) {
  if (metadata === undefined) return undefined;
  // Azure metadata identifiers cannot contain '-' and header values must be ASCII.
  let encoded = false;
  const result = Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => {
      if (
        /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) &&
        /^[\t\x20-\x7e]*$/.test(value) &&
        key.toLowerCase() !== metadataMarker &&
        !key.toLowerCase().startsWith(metadataPrefix)
      )
        return [key, value];
      encoded = true;
      return [
        metadataPrefix + Buffer.from(key).toString("hex"),
        Buffer.from(value).toString("base64"),
      ];
    }),
  );
  if (encoded) result[metadataMarker] = "v1";
  return result;
}
function decodeMetadata(metadata = {}) {
  if (metadata[metadataMarker] !== "v1") return metadata;
  return Object.fromEntries(
    Object.entries(metadata)
      .filter(([key]) => key !== metadataMarker)
      .map(([key, value]) => {
        const encoded = key.slice(metadataPrefix.length);
        return key.startsWith(metadataPrefix) &&
          /^(?:[0-9a-f]{2})+$/.test(encoded)
          ? [
              Buffer.from(encoded, "hex").toString(),
              Buffer.from(value, "base64").toString(),
            ]
          : [key, value];
      }),
  );
}
function conditions(input, prefix = "") {
  return Object.fromEntries(
    ["IfMatch", "IfNoneMatch", "IfModifiedSince", "IfUnmodifiedSince"]
      .filter((name) => input[prefix + name] !== undefined)
      .map((name) => [
        name[0].toLowerCase() + name.slice(1),
        input[prefix + name],
      ]),
  );
}
function etag(value) {
  // Azure XML listings omit quotes; HTTP property responses include them.
  return value && !value.startsWith('"') && !value.startsWith("W/")
    ? `"${value}"`
    : value;
}
function properties(result) {
  return {
    ETag: etag(result.etag),
    VersionId: result.versionId,
    ContentLength: result.contentLength,
    LastModified: result.lastModified,
    ContentType: result.contentType,
    ContentEncoding: result.contentEncoding,
    ContentLanguage: result.contentLanguage,
    ContentDisposition: result.contentDisposition,
    CacheControl: result.cacheControl,
    Metadata: decodeMetadata(result.metadata),
    StorageClass: result.accessTier,
    ...(result.contentMD5
      ? {
          ChecksumMD5: Buffer.from(result.contentMD5).toString("base64"),
          ChecksumType: "FULL_OBJECT",
        }
      : {}),
  };
}
function unsupported(message) {
  return Object.assign(new Error(`Azure Blob Storage: ${message}`), {
    name: "UnsupportedOperation",
  });
}
function headers(input) {
  for (const key of [
    "Expires",
    "WebsiteRedirectLocation",
    "SSEKMSKeyId",
    "ObjectLockMode",
    "ObjectLockRetainUntilDate",
    "ObjectLockLegalHoldStatus",
  ])
    if (input[key] !== undefined)
      throw unsupported(`${key} cannot be applied through this provider.`);
  return Object.fromEntries(
    [
      "ContentType",
      "ContentEncoding",
      "ContentLanguage",
      "ContentDisposition",
      "CacheControl",
    ]
      .filter((name) => input[name] !== undefined)
      .map((name) => ["blob" + name, input[name]]),
  );
}
function normalizeError(error) {
  if (error.statusCode) {
    // Azure may report conditional creation conflicts as BlobAlreadyExists/409.
    const status =
      error.statusCode === 409 &&
      (error.code || error.details?.errorCode) === "BlobAlreadyExists"
        ? 412
        : error.statusCode;
    error.$metadata = { ...error.$metadata, httpStatusCode: status };
    if (status === 404) error.name = "NotFound";
    if (status === 412) error.name = "PreconditionFailed";
  }
  return error;
}

function client(profile, injected = {}) {
  const sdk = injected.sdk || require("@azure/storage-blob");
  const credential =
    injected.credential ||
    (profile.accountKey &&
      new sdk.StorageSharedKeyCredential(
        profile.accountName,
        profile.accountKey,
      ));
  const service =
    injected.service ||
    (profile.connectionString
      ? sdk.BlobServiceClient.fromConnectionString(profile.connectionString, {
          retryOptions: { maxTries: 5 },
        })
      : new sdk.BlobServiceClient(
          (profile.endpoint ||
            `https://${profile.accountName}.blob.core.windows.net`) +
            (profile.sasToken ? `?${profile.sasToken.replace(/^\?/, "")}` : ""),
          credential || undefined,
          { retryOptions: { maxTries: 5 } },
        ));
  const container = (input) =>
    service.getContainerClient(input.Bucket || profile.bucket);
  const blob = (input) => {
    const result = container(input).getBlockBlobClient(input.Key);
    return input.VersionId === undefined
      ? result
      : result.withVersion(input.VersionId);
  };

  async function upload(input, { abortSignal, onProgress } = {}) {
    abortSignal?.throwIfAborted();
    const options = {
      abortSignal,
      conditions: conditions(input),
      blobHTTPHeaders: headers(input),
      metadata: encodeMetadata(input.Metadata),
      tier: input.StorageClass,
      tags: input.Tagging
        ? Object.fromEntries(new URLSearchParams(input.Tagging))
        : undefined,
      onProgress: (event) => onProgress?.(event.loadedBytes),
    };
    const body = input.Body ?? Buffer.alloc(0);
    try {
      const target = blob(input);
      const result =
        typeof body.pipe === "function"
          ? await uploadBlocks(target, body, input.ContentLength, options)
          : await target.uploadData(
              typeof body === "string" ? Buffer.from(body) : body,
              options,
            );
      return properties(result);
    } catch (error) {
      throw normalizeError(error);
    }
  }

  async function uploadBlocks(target, body, length, options) {
    // Explicit staging propagates cancellation to every request. The SDK's
    // uploadStream currently omits abortSignal from its stageBlock calls.
    const blockSize = Math.max(
      8 * 1024 * 1024,
      Math.ceil((length || 0) / 50000),
    );
    if (!Number.isSafeInteger(blockSize) || blockSize > 128 * 1024 * 1024)
      throw unsupported(
        "streamed upload exceeds the supported 128 MiB per block limit.",
      );
    const prefix = randomUUID();
    const ids = [];
    const hash = createHash("md5");
    let buffer = Buffer.allocUnsafe(blockSize);
    let used = 0;
    let loaded = 0;
    const { abortSignal } = options;
    const abort = () =>
      body.destroy(
        abortSignal.reason ||
          Object.assign(new Error("Upload aborted"), { name: "AbortError" }),
      );
    abortSignal?.addEventListener("abort", abort, { once: true });
    async function stage() {
      abortSignal?.throwIfAborted();
      if (ids.length >= 50000)
        throw unsupported("upload exceeds Azure's 50,000 block limit.");
      const id = Buffer.from(
        // Match the official JS SDK's 48-byte IDs, including when an interrupted
        // upload from that SDK left uncommitted blocks on the same blob.
        `${prefix}${String(ids.length).padStart(12, "0")}`,
      ).toString("base64");
      await target.stageBlock(id, buffer.subarray(0, used), used, {
        abortSignal,
      });
      ids.push(id);
      loaded += used;
      options.onProgress({ loadedBytes: loaded });
      used = 0;
    }
    try {
      abortSignal?.throwIfAborted();
      for await (const value of body) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        hash.update(chunk);
        for (let offset = 0; offset < chunk.length;) {
          const count = Math.min(blockSize - used, chunk.length - offset);
          chunk.copy(buffer, used, offset, offset + count);
          used += count;
          offset += count;
          if (used === blockSize) await stage();
        }
      }
      if (used) await stage();
      abortSignal?.throwIfAborted();
      if (length !== undefined && loaded !== length)
        throw new Error("Upload stream length changed before commit.");
      return await target.commitBlockList(ids, {
        ...options,
        blobHTTPHeaders: {
          ...options.blobHTTPHeaders,
          blobContentMD5: hash.digest(),
        },
      });
    } finally {
      abortSignal?.removeEventListener("abort", abort);
      buffer = null;
    }
  }

  async function copy(input, abortSignal) {
    if (
      input.MetadataDirective &&
      !["COPY", "REPLACE"].includes(input.MetadataDirective)
    )
      throw unsupported("the requested metadata directive is unavailable.");
    if (input.TaggingDirective && input.TaggingDirective !== "COPY")
      throw unsupported("the requested tagging directive is unavailable.");
    const separator = input.CopySource.indexOf("?");
    const path = (
      separator === -1 ? input.CopySource : input.CopySource.slice(0, separator)
    ).replace(/^\//, "");
    const slash = path.indexOf("/");
    if (slash < 1)
      throw new Error("A copy source container and object are required.");
    const sourceInput = {
      Bucket: decodeURIComponent(path.slice(0, slash)),
      Key: decodeURIComponent(path.slice(slash + 1)),
      VersionId:
        separator === -1
          ? undefined
          : (new URLSearchParams(input.CopySource.slice(separator + 1)).get(
              "versionId",
            ) ?? undefined),
    };
    const source = blob(sourceInput);
    const sourceConditions = conditions(input, "CopySource");
    const head = await source.getProperties({
      abortSignal,
      conditions: sourceConditions,
    });
    // Pin all subsequent reads to the reviewed source, including callers without an ETag.
    sourceConditions.ifMatch ||= head.etag;
    const tags = head.tagCount
      ? (await source.getTags({ abortSignal })).tags
      : {};
    let result;
    if (input.MetadataDirective === "REPLACE") {
      headers(input); // Reject unsupported attributes before transferring any bytes.
      if (head.blobType && head.blobType !== "BlockBlob")
        throw unsupported(
          "metadata replacement is supported only for block blobs.",
        );
      // Copy Blob cannot replace HTTP content headers. Commit a streamed block
      // upload with the original destination guard instead of racing setHTTPHeaders.
      const downloaded = await source.download(0, undefined, {
        abortSignal,
        conditions: sourceConditions,
      });
      const body = downloaded.readableStreamBody;
      if (!body)
        throw new Error("Azure did not return a readable object body.");
      try {
        result = await upload(
          {
            ...properties(head),
            ...input,
            VersionId: undefined,
            Body: body,
            Tagging: new URLSearchParams(tags).toString(),
          },
          { abortSignal },
        );
      } finally {
        body.destroy();
      }
    } else {
      const target = blob(input);
      let copied = await target.startCopyFromURL(source.url, {
        abortSignal,
        conditions: conditions(input),
        sourceConditions,
        tags,
        tier: head.accessTier,
      });
      const copyId = copied.copyId;
      try {
        while (copied.copyStatus === "pending") {
          await delay(1000, undefined, { signal: abortSignal });
          copied = await target.getProperties({ abortSignal });
          if (copyId !== copied.copyId)
            throw Object.assign(
              new Error("Azure destination changed during copy."),
              { statusCode: 412 },
            );
        }
      } catch (error) {
        if (abortSignal?.aborted && copied.copyStatus === "pending" && copyId) {
          try {
            // Azure checks this exact copy ID. Never delete the destination or
            // reuse the cancelled signal for cleanup of a pending remote copy.
            await target.abortCopyFromURL(copyId, {
              abortSignal: AbortSignal.timeout(15000),
            });
          } catch (cleanup) {
            if (
              !["NoPendingCopyOperation", "CopyIdMismatch"].includes(
                cleanup.code || cleanup.details?.errorCode,
              )
            )
              throw Object.assign(
                new Error(
                  `${error.message} Azure copy cancellation also failed: ${cleanup.message}`,
                  { cause: error },
                ),
                { name: error.name },
              );
          }
        }
        throw error;
      }
      if (copied.copyStatus !== "success")
        throw new Error(
          `Azure copy did not complete: ${copied.copyStatusDescription || copied.copyStatus || "unknown status"}`,
        );
      result = properties(copied);
    }
    return {
      CopyObjectResult: {
        ETag: result.ETag,
        LastModified: result.LastModified,
      },
      VersionId: result.VersionId,
    };
  }

  async function send(command, { abortSignal } = {}) {
    abortSignal?.throwIfAborted();
    const input = command.input || {};
    try {
      switch (command.constructor.name) {
        case "ListBucketsCommand": {
          const Buckets = [];
          for await (const item of service.listContainers({ abortSignal }))
            Buckets.push({
              Name: item.name,
              CreationDate: item.properties?.lastModified,
            });
          return { Buckets };
        }
        case "ListObjectsV2Command": {
          const options = { prefix: input.Prefix, abortSignal };
          const items = input.Delimiter
            ? container(input).listBlobsByHierarchy(input.Delimiter, options)
            : container(input).listBlobsFlat(options);
          const { value: page } = await items
            .byPage({
              continuationToken: input.ContinuationToken,
              maxPageSize: input.MaxKeys || 500,
            })
            .next();
          return {
            Contents: (page?.segment?.blobItems || []).map((item) => ({
              Key: item.name,
              Size: item.properties.contentLength,
              ETag: etag(item.properties.etag),
              LastModified: item.properties.lastModified,
            })),
            CommonPrefixes: (page?.segment?.blobPrefixes || []).map((item) => ({
              Prefix: item.name,
            })),
            IsTruncated: !!page?.continuationToken,
            NextContinuationToken: page?.continuationToken || undefined,
          };
        }
        case "ListObjectVersionsCommand": {
          if (input.KeyMarker && input.KeyMarker !== input.Prefix)
            throw new Error("Invalid Azure version continuation key.");
          const { value: page } = await container(input)
            .listBlobsFlat({
              prefix: input.Prefix,
              includeVersions: true,
              abortSignal,
            })
            .byPage({
              continuationToken: input.VersionIdMarker,
              maxPageSize: input.MaxKeys || 500,
            })
            .next();
          return {
            Versions: (page?.segment?.blobItems || [])
              .filter((item) => item.versionId)
              .map((item) => ({
                Key: item.name,
                VersionId: item.versionId,
                IsLatest: item.isCurrentVersion,
                Size: item.properties.contentLength,
                ETag: etag(item.properties.etag),
                LastModified: item.properties.lastModified,
              })),
            IsTruncated: !!page?.continuationToken,
            NextKeyMarker: page?.continuationToken ? input.Prefix : undefined,
            NextVersionIdMarker: page?.continuationToken || undefined,
          };
        }
        case "HeadObjectCommand":
          return properties(
            await blob(input).getProperties({
              abortSignal,
              conditions: conditions(input),
            }),
          );
        case "GetObjectCommand": {
          let offset = 0;
          let count;
          if (input.Range) {
            const match = /^bytes=(\d+)-(\d*)$/.exec(input.Range);
            if (!match)
              throw unsupported(
                "only a single byte range with a starting offset is supported.",
              );
            offset = Number(match[1]);
            count = match[2] ? Number(match[2]) - offset + 1 : undefined;
            if (
              !Number.isSafeInteger(offset) ||
              (count !== undefined &&
                (!Number.isSafeInteger(count) || count < 1))
            )
              throw new Error("Invalid download byte range.");
          }
          const result = await blob(input).download(offset, count, {
            abortSignal,
            conditions: conditions(input),
          });
          return {
            ...properties(result),
            Body: result.readableStreamBody,
            ContentRange: result.contentRange,
          };
        }
        case "PutObjectCommand":
          return await upload(input, { abortSignal });
        case "DeleteObjectCommand":
          await blob(input).delete({
            abortSignal,
            conditions: conditions(input),
          });
          return {};
        case "CopyObjectCommand":
          return await copy(input, abortSignal);
        case "GetObjectTaggingCommand": {
          const result = await blob(input).getTags({ abortSignal });
          return {
            TagSet: Object.entries(result.tags || {}).map(([Key, Value]) => ({
              Key,
              Value,
            })),
          };
        }
        default:
          throw unsupported(
            `${command.constructor.name.replace(/Command$/, "")} is not available. Azure uploads use native block uploads; S3 multipart inspection and cleanup are unavailable.`,
          );
      }
    } catch (error) {
      throw normalizeError(error);
    }
  }

  return {
    provider: "Azure Blob Storage",
    capabilities: {
      conditionalWrite: true,
      conditionalDelete: true,
      copy: true,
      metadata: true,
      versions: true,
      signedUrl: require("../provider-capabilities.cjs").capabilities({
        ...profile,
        provider: "Azure Blob Storage",
      }).signedUrl,
      multipart: false,
    },
    send,
    upload,
    signedUrl(input, expiresIn) {
      if (!this.capabilities.signedUrl)
        throw unsupported(
          "generating download links requires account key authentication.",
        );
      return blob(input).generateSasUrl({
        permissions: sdk.BlobSASPermissions.parse("r"),
        startsOn: new Date(Date.now() - 5 * 60 * 1000),
        expiresOn: new Date(Date.now() + expiresIn * 1000),
      });
    },
    destroy() {},
  };
}

module.exports = { client };
