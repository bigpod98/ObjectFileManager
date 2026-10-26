const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const API = "https://storage.googleapis.com/storage/v1";
const fields = {
  ContentType: "contentType",
  ContentEncoding: "contentEncoding",
  ContentDisposition: "contentDisposition",
  ContentLanguage: "contentLanguage",
  CacheControl: "cacheControl",
  Metadata: "metadata",
  StorageClass: "storageClass",
};

function unsupported(message) {
  return Object.assign(new Error(message), { name: "NotSupported" });
}

function normalizeError(error) {
  const status = Number(error.response?.status || error.code);
  if (status >= 400 && status <= 599) {
    error.$metadata = { httpStatusCode: status };
    if (status === 404) {
      // GCS uses reason=notFound for both buckets and objects. Only its explicit
      // object-specific JSON error can prove an object disappeared after copy.
      const message = error.response?.data?.error?.message;
      error.name =
        typeof message === "string" && /^No such object: /u.test(message)
          ? "NoSuchKey"
          : "NotFound";
    }
    if (status === 412) error.name = "PreconditionFailed";
    if (status === 403) error.name = "AccessDenied";
  }
  return error;
}

// Application ETags are opaque version tokens, not checksums. Encoding both
// revisions avoids caches and keeps reviewed metadata changes race protected.
function etag(metadata) {
  if (!metadata.generation || !metadata.metageneration)
    throw new Error(
      "Google Cloud Storage omitted object revision information.",
    );
  return `"gcs:${metadata.generation}:${metadata.metageneration}"`;
}

function revision(value) {
  const match = /^"gcs:(\d+):(\d+)"$/.exec(value);
  if (!match)
    throw new Error(
      "Refresh the object to obtain its Google Cloud Storage revision.",
    );
  return { generation: match[1], metageneration: match[2] };
}

function conditions(input, source = false) {
  const match = input[source ? "CopySourceIfMatch" : "IfMatch"];
  const absent = input[source ? "CopySourceIfNoneMatch" : "IfNoneMatch"];
  if (match && absent) throw unsupported("Conflicting object preconditions.");
  if (absent && (source || absent !== "*"))
    throw unsupported(
      "Google Cloud Storage supports only destination IfNoneMatch: *.",
    );
  const prefix = source ? "ifSource" : "if";
  if (match) {
    const version = revision(match);
    return {
      [`${prefix}GenerationMatch`]: version.generation,
      [`${prefix}MetagenerationMatch`]: version.metageneration,
    };
  }
  return absent ? { ifGenerationMatch: 0 } : {};
}

function attributes(input) {
  return Object.fromEntries(
    Object.entries(fields)
      .filter(([key]) => input[key] !== undefined)
      .map(([key, field]) => [field, input[key]]),
  );
}

function head(metadata) {
  return {
    ETag: etag(metadata),
    ContentLength: Number(metadata.size),
    LastModified: metadata.updated ? new Date(metadata.updated) : undefined,
    VersionId: metadata.generation,
    ...(metadata.md5Hash
      ? { ChecksumMD5: metadata.md5Hash, ChecksumType: "FULL_OBJECT" }
      : {}),
    ...Object.fromEntries(
      Object.entries(fields)
        .filter(([, field]) => metadata[field] !== undefined)
        .map(([key, field]) => [key, metadata[field]]),
    ),
  };
}

function client(profile) {
  const mode = profile.googleAuth || (profile.keyFilename ? "file" : "json");
  if (!["json", "file", "default"].includes(mode))
    throw new Error("Choose a supported Google authentication method.");
  let credentials;
  if (mode === "json") {
    try {
      credentials = JSON.parse(profile.serviceAccountJson || profile.keyFile);
    } catch {
      throw new Error(
        "Google Cloud Storage requires valid service account JSON.",
      );
    }
    if (
      credentials?.type !== "service_account" ||
      !credentials.client_email ||
      !credentials.private_key
    )
      throw new Error(
        "Google Cloud Storage requires a service account email and private key.",
      );
  }
  if (
    mode === "file" &&
    !require("node:path").isAbsolute(profile.keyFilename || "")
  )
    throw new Error(
      "Use an absolute path to the Google service account key file.",
    );
  const projectId = profile.projectId || credentials?.project_id;
  if (!projectId)
    throw new Error("Google Cloud Storage requires a project ID.");
  const { Storage, CRC32C } = require("@google-cloud/storage");
  const storage = new Storage({
    projectId,
    ...(credentials
      ? { credentials }
      : mode === "file"
        ? { keyFilename: profile.keyFilename }
        : {}),
  });
  const lifetime = new AbortController();
  const connectionCapabilities =
    require("../provider-capabilities.cjs").capabilities({
      ...profile,
      provider: "Google Cloud Storage",
    });
  let signingCapabilities;
  let signingError;
  async function resolveCapabilities() {
    signingCapabilities ||= (async () => {
      if (connectionCapabilities.signedUrl) return;
      try {
        const credentials = await storage.authClient.getCredentials();
        if (!credentials.client_email)
          throw new Error(
            "User Application Default Credentials do not provide a service account signer. Use service account credentials or service account impersonation.",
          );
        // Without a local key, email alone does not prove IAM signBlob access.
        if (!credentials.private_key)
          await storage.authClient.sign(
            "ObjectFileManager signing capability check",
          );
        connectionCapabilities.signedUrl = true;
      } catch (error) {
        signingError = error;
        connectionCapabilities.signedUrl = false;
      }
    })();
    await signingCapabilities;
    lifetime.signal.throwIfAborted();
    return { ...connectionCapabilities };
  }
  const signalFor = (signal) =>
    signal ? AbortSignal.any([lifetime.signal, signal]) : lifetime.signal;
  const objectPath = (bucket, key) =>
    `/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(key)}`;

  async function request(path, { signal, params, ...options } = {}) {
    signal?.throwIfAborted();
    const url = new URL(API + path);
    for (const [key, value] of Object.entries(params || {}))
      if (value !== undefined) url.searchParams.set(key, String(value));
    try {
      const response = await storage.authClient.request({
        url: url.toString(),
        method: "GET",
        retry: false,
        signal,
        ...options,
      });
      return response.data;
    } catch (error) {
      throw normalizeError(error);
    }
  }

  async function upload(input, { abortSignal, onProgress } = {}) {
    const signal = signalFor(abortSignal);
    signal.throwIfAborted();
    const file = storage.bucket(input.Bucket).file(input.Key);
    const destination = file.createWriteStream({
      resumable: true,
      chunkSize: 8 * 1024 * 1024,
      // SDK checksum failure cleanup deletes the live key without a revision
      // guard. Validate locally instead, never deleting a concurrent writer.
      validation: false,
      metadata: attributes(input),
      preconditionOpts: conditions(input),
    });
    const source = input.Body?.pipe
      ? input.Body
      : Readable.from([input.Body ?? Buffer.alloc(0)]);
    let loaded = 0;
    const checksum = new CRC32C();
    const progress = new Transform({
      transform(chunk, encoding, done) {
        checksum.update(chunk);
        loaded += chunk.length;
        onProgress?.(loaded);
        done(null, chunk);
      },
    });
    try {
      await pipeline(source, progress, destination, { signal });
      if (
        typeof file.metadata.crc32c !== "string" ||
        file.metadata.crc32c !== checksum.toString()
      )
        throw Object.assign(
          new Error(
            "Google Cloud Storage upload checksum is missing or does not match. The object was not deleted; review it before retrying.",
          ),
          { code: "UploadIntegrityError" },
        );
      return { ETag: etag(file.metadata), VersionId: file.metadata.generation };
    } catch (error) {
      throw normalizeError(error);
    }
  }

  async function send(command, { abortSignal } = {}) {
    const signal = signalFor(abortSignal);
    signal.throwIfAborted();
    const input = command.input;
    const name = command.constructor.name;
    if (input.Range !== undefined)
      throw unsupported(
        "Google Cloud Storage range reads are not supported in this browser.",
      );
    for (const key of [
      "IfModifiedSince",
      "IfUnmodifiedSince",
      "CopySourceIfModifiedSince",
      "CopySourceIfUnmodifiedSince",
    ])
      if (input[key] !== undefined)
        throw unsupported(
          `Google Cloud Storage does not support ${key} in this browser.`,
        );
    if (name === "ListBucketsCommand") {
      const buckets = [];
      let pageToken;
      const seen = new Set();
      do {
        const page = await request("/b", {
          signal,
          params: { project: projectId, pageToken, maxResults: 1000 },
        });
        buckets.push(
          ...(page.items || []).map((item) => ({
            Name: item.name,
            CreationDate: item.timeCreated
              ? new Date(item.timeCreated)
              : undefined,
          })),
        );
        pageToken = page.nextPageToken;
        if (pageToken && seen.has(pageToken))
          throw new Error("Invalid Google Cloud Storage bucket pagination.");
        seen.add(pageToken);
      } while (pageToken);
      return { Buckets: buckets };
    }
    if (
      name === "ListObjectsV2Command" ||
      name === "ListObjectVersionsCommand"
    ) {
      const versions = name === "ListObjectVersionsCommand";
      if (versions && input.KeyMarker && input.KeyMarker !== input.Prefix)
        throw new Error("Invalid Google Cloud Storage version marker.");
      const page = await request(`/b/${encodeURIComponent(input.Bucket)}/o`, {
        signal,
        params: {
          prefix: input.Prefix,
          // The exclusive bound is the exact name plus the smallest Unicode
          // scalar, so even supplementary characters and prefix siblings are
          // bounded out on every page without a UTF-16 successor calculation.
          startOffset: versions ? input.Prefix : undefined,
          endOffset: versions ? input.Prefix + "\u0000" : undefined,
          delimiter: input.Delimiter,
          pageToken: versions ? input.VersionIdMarker : input.ContinuationToken,
          maxResults: input.MaxKeys || 500,
          versions: versions || undefined,
        },
      });
      const items = (page.items || [])
        .filter((item) => !versions || item.name === input.Prefix)
        .map((item) => ({
          Key: item.name,
          Size: Number(item.size),
          ETag: etag(item),
          LastModified: item.updated ? new Date(item.updated) : undefined,
          ...(versions
            ? { VersionId: item.generation, IsLatest: !item.timeDeleted }
            : {}),
        }));
      return versions
        ? {
            Versions: items,
            DeleteMarkers: [],
            IsTruncated: !!page.nextPageToken,
            NextKeyMarker: page.nextPageToken ? input.Prefix : undefined,
            NextVersionIdMarker: page.nextPageToken,
          }
        : {
            Contents: items,
            CommonPrefixes: (page.prefixes || []).map((Prefix) => ({ Prefix })),
            IsTruncated: !!page.nextPageToken,
            NextContinuationToken: page.nextPageToken,
          };
    }
    const path = objectPath(input.Bucket, input.Key);
    if (name === "HeadObjectCommand" || name === "GetObjectCommand") {
      const params = { generation: input.VersionId, ...conditions(input) };
      const metadata = await request(path, { signal, params });
      const result = head(metadata);
      if (name === "GetObjectCommand") {
        // Pin the read to the HEAD revision so download bytes and metadata agree.
        result.Body = await request(path, {
          signal,
          params: {
            alt: "media",
            generation: metadata.generation,
            ifGenerationMatch: metadata.generation,
            ifMetagenerationMatch: metadata.metageneration,
          },
          responseType: "stream",
          // Gaxios uses node-fetch: compress:false prevents client decoding,
          // while Accept-Encoding prevents GCS decompressive transcoding.
          compress: false,
          headers: {
            "Accept-Encoding": "gzip",
          },
        });
      }
      return result;
    }
    if (name === "PutObjectCommand") return upload(input, { abortSignal });
    if (name === "DeleteObjectCommand") {
      await request(path, {
        signal,
        method: "DELETE",
        params: { generation: input.VersionId, ...conditions(input) },
      });
      return {};
    }
    if (name === "CopyObjectCommand") {
      const raw = input.CopySource.replace(/^\//, "");
      const question = raw.indexOf("?");
      const source = question < 0 ? raw : raw.slice(0, question);
      const slash = source.indexOf("/");
      if (slash < 0) throw new Error("Invalid copy source.");
      const sourceBucket = decodeURIComponent(source.slice(0, slash));
      const sourceKey = decodeURIComponent(source.slice(slash + 1));
      const sourceGeneration =
        new URLSearchParams(question < 0 ? "" : raw.slice(question + 1)).get(
          "versionId",
        ) || undefined;
      const params = {
        sourceGeneration,
        ...conditions(input),
        ...conditions(input, true),
      };
      const rewritePath = `${objectPath(sourceBucket, sourceKey)}/rewriteTo${path}`;
      let rewriteToken;
      const seen = new Set();
      do {
        const result = await request(rewritePath, {
          signal,
          method: "POST",
          params: { ...params, rewriteToken },
          data: input.MetadataDirective === "REPLACE" ? attributes(input) : {},
        });
        if (result.done) {
          const metadata = result.resource;
          return {
            CopyObjectResult: {
              ETag: etag(metadata),
              LastModified: metadata.updated
                ? new Date(metadata.updated)
                : undefined,
            },
            VersionId: metadata.generation,
          };
        }
        rewriteToken = result.rewriteToken;
        if (!rewriteToken || seen.has(rewriteToken))
          throw new Error("Invalid Google Cloud Storage rewrite continuation.");
        seen.add(rewriteToken);
      } while (true);
    }
    throw unsupported(
      `Google Cloud Storage does not support ${name.replace(/Command$/, "")} in this browser. S3 multipart upload cleanup is unavailable for native resumable uploads.`,
    );
  }

  return {
    provider: "Google Cloud Storage",
    capabilities: connectionCapabilities,
    resolveCapabilities,
    send,
    upload,
    async signedUrl({ Bucket, Key }, expiresIn) {
      if (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > 604800)
        throw new Error("Link lifetime must be between 1 and 604800 seconds.");
      lifetime.signal.throwIfAborted();
      if (!(await resolveCapabilities()).signedUrl)
        throw unsupported(
          `Expiring download links require a Google service account signer with signing permission. ${signingError?.message || "Signing credentials are unavailable."}`,
        );
      const [url] = await storage
        .bucket(Bucket)
        .file(Key)
        .getSignedUrl({
          version: "v4",
          action: "read",
          expires: Date.now() + expiresIn * 1000,
        });
      return url;
    },
    destroy() {
      lifetime.abort();
    },
  };
}

module.exports = { client };
