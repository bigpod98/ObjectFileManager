// Native Swift account API, with optional Keystone authentication.
const http = require("node:http");
const https = require("node:https");
const { Readable } = require("node:stream");
const { createHmac } = require("node:crypto");

function unsupported(message) {
  return Object.assign(new Error(`OpenStack Swift: ${message}`), {
    name: "UnsupportedOperation",
    $metadata: { httpStatusCode: 501 },
  });
}
function quoted(value) {
  return value ? `"${String(value).replace(/^"|"$/g, "")}"` : undefined;
}
function date(value) {
  if (!value) return undefined;
  // Container listing timestamps are UTC but omit the zone.
  const parsed = new Date(
    /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : `${value}Z`,
  );
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}
function objectHeaders(input) {
  const headers = {};
  for (const [field, name] of Object.entries({
    ContentType: "content-type",
    ContentEncoding: "content-encoding",
    ContentDisposition: "content-disposition",
    CacheControl: "cache-control",
    ContentLanguage: "content-language",
    Expires: "expires",
  })) {
    if (input[field] !== undefined)
      headers[name] =
        input[field] instanceof Date
          ? input[field].toUTCString()
          : input[field];
  }
  for (const [key, value] of Object.entries(input.Metadata || {})) {
    if (!/^[a-zA-Z0-9_-]+$/.test(key))
      throw new Error("Invalid Swift metadata key.");
    headers[`x-object-meta-${key}`] = String(value);
  }
  return headers;
}
function output(response) {
  const h = response.headers;
  const result = {
    $metadata: { httpStatusCode: response.statusCode },
    Metadata: {},
  };
  for (const [name, value] of Object.entries(h)) {
    if (name.startsWith("x-object-meta-"))
      result.Metadata[name.slice(14)] = value;
  }
  for (const [field, name] of Object.entries({
    ContentType: "content-type",
    ContentEncoding: "content-encoding",
    ContentDisposition: "content-disposition",
    CacheControl: "cache-control",
    ContentLanguage: "content-language",
  }))
    if (h[name] !== undefined) result[field] = h[name];
  if (h.etag) result.ETag = quoted(h.etag);
  if (h["content-length"] !== undefined)
    result.ContentLength = Number(h["content-length"]);
  if (h["last-modified"]) result.LastModified = new Date(h["last-modified"]);
  if (h.expires) result.Expires = new Date(h.expires);
  if (h["content-range"]) result.ContentRange = h["content-range"];
  return result;
}
function client(profile) {
  if (profile.swiftAuth === "keystone" || profile.authUrl)
    return require("./keystone.cjs").client(profile, client);
  if (!profile.endpoint || !profile.swiftToken)
    throw new Error(
      "Swift requires an account storage URL and authentication token.",
    );
  const endpoint = new URL(profile.endpoint);
  if (
    !["https:", "http:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error(
      "Swift storage URL must be an HTTP(S) account URL without credentials, query, or fragment.",
    );
  const base = endpoint.pathname.replace(/\/+$/, "");
  if (!/\/v1\/[^/]+$/.test(base))
    throw new Error(
      "Swift storage URL must end with /v1/<account> (for example /v1/AUTH_project).",
    );
  const pending = new Set();
  let destroyed = false;
  let maxFileSize;
  function path(input = {}) {
    let value = base;
    if (input.Bucket !== undefined)
      value += `/${encodeURIComponent(input.Bucket)}`;
    if (input.Key !== undefined)
      value += `/${String(input.Key).split("/").map(encodeURIComponent).join("/")}`;
    return value;
  }
  async function request(
    method,
    target,
    { headers = {}, body, abortSignal, onProgress } = {},
  ) {
    abortSignal?.throwIfAborted();
    if (destroyed) throw new Error("Swift connection is closed.");
    let source;
    const response = await new Promise((resolve, reject) => {
      const req = (endpoint.protocol === "https:" ? https : http).request(
        {
          protocol: endpoint.protocol,
          hostname: endpoint.hostname,
          port: endpoint.port,
          method,
          path: target,
          headers: { "x-auth-token": profile.swiftToken, ...headers },
          signal: abortSignal,
        },
        resolve,
      );
      pending.add(req);
      req.once("close", () => pending.delete(req));
      req.once("error", (error) => {
        source?.destroy();
        body?.destroy?.();
        reject(error);
      });
      req.setTimeout(120000, () =>
        req.destroy(new Error("Swift request timed out.")),
      );
      req.once("close", () => {
        source?.destroy();
        body?.destroy?.();
      });
      if (body === undefined) req.end();
      else {
        const iterable =
          typeof body === "string" ||
          Buffer.isBuffer(body) ||
          body instanceof Uint8Array
            ? [body]
            : body;
        let loaded = 0;
        source = Readable.from(
          (async function* () {
            for await (const chunk of iterable) {
              abortSignal?.throwIfAborted();
              loaded += Buffer.byteLength(chunk);
              onProgress?.(loaded);
              yield chunk;
            }
          })(),
        );
        source.on("error", (error) => req.destroy(error));
        source.pipe(req);
      }
    });
    pending.add(response);
    response.once("close", () => {
      pending.delete(response);
      source?.destroy();
    });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      response.resume();
      source?.destroy();
      const status = response.statusCode;
      const name =
        {
          401: "Unauthorized",
          403: "AccessDenied",
          404: "NotFound",
          409: "Conflict",
          412: "PreconditionFailed",
          413: "EntityTooLarge",
        }[status] || "SwiftError";
      throw Object.assign(
        new Error(
          status === 401
            ? "Swift authentication token is invalid or expired. Update the connection with a fresh token."
            : `OpenStack Swift request failed (${status} ${response.statusMessage}).`,
        ),
        {
          name,
          $metadata: { httpStatusCode: status },
        },
      );
    }
    return response;
  }
  async function listing(input, abortSignal, account = false) {
    const limit = Math.max(1, Math.min(1000, Number(input.MaxKeys) || 1000));
    const params = new URLSearchParams({
      format: "json",
      limit: String(limit),
    });
    if (input.Prefix) params.set("prefix", input.Prefix);
    if (input.Delimiter) params.set("delimiter", input.Delimiter);
    const marker = input.ContinuationToken || input.StartAfter;
    if (marker) params.set("marker", marker);
    const response = await request(
      "GET",
      `${path(account ? {} : input)}?${params}`,
      { abortSignal },
    );
    const chunks = [];
    for await (const chunk of response) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString();
    const rows = text ? JSON.parse(text) : [];
    if (!Array.isArray(rows))
      throw new Error("Invalid Swift listing response.");
    return {
      rows,
      next:
        rows.length === limit
          ? rows.at(-1).name || rows.at(-1).subdir
          : undefined,
    };
  }
  async function singlePutLimit(abortSignal) {
    abortSignal?.throwIfAborted();
    if (maxFileSize !== undefined) return maxFileSize;
    let limit = 5 * 1024 ** 3;
    try {
      // Deployments can mount Swift behind a path prefix. Keep discovery on
      // the configured origin; request() never follows redirects with tokens.
      const response = await request(
        "GET",
        base.replace(/\/v1\/[^/]+$/, "/info"),
        {
          abortSignal,
        },
      );
      const chunks = [];
      let length = 0;
      for await (const chunk of response) {
        length += chunk.length;
        if (length > 1024 * 1024) {
          response.destroy();
          throw new Error("Swift capability response is too large.");
        }
        chunks.push(chunk);
      }
      const value = JSON.parse(Buffer.concat(chunks).toString()).swift
        ?.max_file_size;
      if (Number.isSafeInteger(value) && value > 0) limit = value;
    } catch (error) {
      abortSignal?.throwIfAborted();
      if (error.name === "AbortError" || destroyed) throw error;
      // Public capability discovery may be disabled by the operator.
    }
    abortSignal?.throwIfAborted();
    maxFileSize = limit;
    return limit;
  }
  async function upload(input, { abortSignal, onProgress } = {}) {
    if (input.VersionId !== undefined)
      throw unsupported("version operations are unavailable.");
    if (input.IfMatch !== undefined)
      throw unsupported(
        "atomic replacement guarded by an ETag is unavailable.",
      );
    if (input.IfNoneMatch !== undefined && input.IfNoneMatch !== "*")
      throw unsupported("only If-None-Match: * is supported for uploads.");
    const headers = objectHeaders(input);
    if (input.IfNoneMatch !== undefined)
      headers["if-none-match"] = input.IfNoneMatch;
    // A validated source can fail only after yielding its final data bytes
    // (for example, the queue's SHA-256 Transform checks in flush). Chunked
    // framing keeps Swift from committing those bytes until successful EOF
    // emits the terminating chunk. Content-Length would commit too early.
    const buffered =
      input.Body === undefined ||
      input.Body === null ||
      typeof input.Body === "string" ||
      Buffer.isBuffer(input.Body) ||
      input.Body instanceof Uint8Array;
    const length =
      input.ContentLength ??
      (buffered ? Buffer.byteLength(input.Body ?? "") : undefined);
    // The queue can destroy its source on cancellation while discovery is
    // still pending. Observe errors before that first await, without reading
    // any bytes, and retain any validation error until streaming starts.
    let bodyError;
    const observeError = (error) => {
      bodyError = error;
    };
    input.Body?.on?.("error", observeError);
    try {
      if (length !== undefined) {
        const limit = await singlePutLimit(abortSignal);
        if (bodyError) throw bodyError;
        if (length > limit)
          throw Object.assign(
            new Error(
              `OpenStack Swift: object size ${length} bytes exceeds this server's single-upload limit of ${limit} bytes. Segmented large-object uploads are unavailable.`,
            ),
            {
              name: "EntityTooLarge",
              $metadata: { httpStatusCode: 413 },
            },
          );
      }
      if (buffered && input.ContentLength !== undefined)
        headers["content-length"] = input.ContentLength;
      const response = await request("PUT", path(input), {
        headers,
        body: input.Body ?? Buffer.alloc(0),
        abortSignal,
        onProgress,
      });
      response.resume();
      return output(response);
    } catch (error) {
      input.Body?.destroy?.();
      throw error;
    } finally {
      const cleanup = () => input.Body?.off?.("error", observeError);
      // destroy(error) schedules error before close on the next tick.
      if (input.Body?.destroyed && !input.Body.closed)
        input.Body.once("close", cleanup);
      else cleanup();
    }
  }
  return {
    provider: "OpenStack Swift",
    capabilities: {
      conditionalWrite: false,
      createOnlyWrite: true,
      conditionalDelete: false,
      copy: true,
      metadata: false,
      versions: false,
      signedUrl: !!profile.swiftTempUrlKey,
      multipart: false,
    },
    upload,
    async send(command, { abortSignal } = {}) {
      const input = command.input || {};
      const name = command.constructor.name;
      if (input.VersionId !== undefined)
        throw unsupported("version operations are unavailable.");
      if (name === "ListBucketsCommand") {
        const buckets = [],
          seen = new Set();
        let marker;
        do {
          const page = await listing(
            { ContinuationToken: marker },
            abortSignal,
            true,
          );
          buckets.push(...page.rows.map((row) => ({ Name: row.name })));
          marker = page.next;
          if (marker && seen.has(marker))
            throw new Error("Invalid Swift account pagination.");
          if (marker) seen.add(marker);
        } while (marker);
        return { Buckets: buckets };
      }
      if (name === "ListObjectsV2Command") {
        const { rows, next } = await listing(input, abortSignal);
        return {
          Contents: rows
            .filter((row) => row.name !== undefined)
            .map((row) => ({
              Key: row.name,
              Size: row.bytes,
              ETag: quoted(row.hash),
              LastModified: date(row.last_modified),
            })),
          CommonPrefixes: rows
            .filter((row) => row.subdir !== undefined)
            .map((row) => ({ Prefix: row.subdir })),
          IsTruncated: !!next,
          NextContinuationToken: next,
        };
      }
      if (name === "PutObjectCommand") return upload(input, { abortSignal });
      if (name === "HeadObjectCommand" || name === "GetObjectCommand") {
        const headers = {};
        for (const [field, header] of Object.entries({
          IfMatch: "if-match",
          IfNoneMatch: "if-none-match",
          IfModifiedSince: "if-modified-since",
          IfUnmodifiedSince: "if-unmodified-since",
          Range: "range",
        }))
          if (input[field] !== undefined)
            headers[header] =
              input[field] instanceof Date
                ? input[field].toUTCString()
                : input[field];
        const response = await request(
          name === "HeadObjectCommand" ? "HEAD" : "GET",
          path(input),
          { headers, abortSignal },
        );
        const result = output(response);
        if (name === "GetObjectCommand") result.Body = response;
        else response.resume();
        return result;
      }
      if (name === "CopyObjectCommand") {
        // Swift server-side copy conditions apply only to the source. A
        // conditional download + create-only upload preserves both guards.
        if (input.IfMatch !== undefined)
          throw unsupported(
            "atomic replacement guarded by an ETag is unavailable for copy.",
          );
        if (input.IfNoneMatch !== undefined && input.IfNoneMatch !== "*")
          throw unsupported(
            "only If-None-Match: * is supported for copy destinations.",
          );
        const raw = String(input.CopySource || "").replace(/^\//, "");
        if (!raw.includes("/") || raw.includes("?"))
          throw unsupported("invalid or versioned copy source.");
        if (input.IfNoneMatch === "*") {
          await singlePutLimit(abortSignal);
          const sourceHeaders = {};
          if (input.CopySourceIfMatch !== undefined)
            sourceHeaders["if-match"] = input.CopySourceIfMatch;
          if (input.CopySourceIfNoneMatch !== undefined)
            sourceHeaders["if-none-match"] = input.CopySourceIfNoneMatch;
          const source = await request("GET", `${base}/${raw}`, {
            headers: sourceHeaders,
            abortSignal,
          });
          try {
            const attributes = output(source);
            const result = await upload(
              {
                ...(input.MetadataDirective === "REPLACE" ? {} : attributes),
                ...input,
                Body: source,
                ContentLength: attributes.ContentLength,
              },
              { abortSignal },
            );
            return {
              CopyObjectResult: {
                ETag: result.ETag,
                LastModified: result.LastModified,
              },
              $metadata: result.$metadata,
            };
          } finally {
            source.destroy();
          }
        }
        const headers = {
          ...objectHeaders(input),
          "x-copy-from": `/${raw}`,
          "content-length": 0,
        };
        if (input.CopySourceIfMatch !== undefined)
          headers["if-match"] = input.CopySourceIfMatch;
        if (input.CopySourceIfNoneMatch !== undefined)
          headers["if-none-match"] = input.CopySourceIfNoneMatch;
        if (input.MetadataDirective === "REPLACE")
          headers["x-fresh-metadata"] = "true";
        const response = await request("PUT", path(input), {
          headers,
          abortSignal,
        });
        response.resume();
        const result = output(response);
        return {
          CopyObjectResult: {
            ETag: result.ETag,
            LastModified: result.LastModified,
          },
          $metadata: result.$metadata,
        };
      }
      if (name === "DeleteObjectCommand") {
        if (
          input.IfMatch !== undefined ||
          input.IfNoneMatch !== undefined ||
          input.IfMatchSize !== undefined ||
          input.IfMatchLastModifiedTime !== undefined
        )
          throw unsupported("conditional deletion is unavailable.");
        const response = await request("DELETE", path(input), { abortSignal });
        response.resume();
        return { $metadata: { httpStatusCode: response.statusCode } };
      }
      throw unsupported(`${name.replace(/Command$/, "")} is unavailable.`);
    },
    async signedUrl(input, expiresIn) {
      if (!profile.swiftTempUrlKey)
        throw unsupported(
          "configure an account TempURL key to create download links.",
        );
      if (input.VersionId !== undefined)
        throw unsupported("version operations are unavailable.");
      if (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > 604800)
        throw new Error(
          "Temporary URL expiry must be between 1 and 604800 seconds.",
        );
      const expires = Math.floor(Date.now() / 1000) + expiresIn;
      const target = path(input);
      if (
        String(input.Key)
          .split("/")
          .some((part) => part === "." || part === "..")
      )
        throw unsupported(
          "temporary links cannot preserve dot path segments in browsers.",
        );
      // Swift signs the decoded WSGI path, not its percent-encoded URL form.
      const signature = createHmac("sha256", profile.swiftTempUrlKey)
        .update(`GET\n${expires}\n${decodeURIComponent(target)}`)
        .digest("hex");
      return `${endpoint.origin}${target}?temp_url_sig=${signature}&temp_url_expires=${expires}`;
    },
    destroy() {
      destroyed = true;
      for (const item of pending) item.destroy();
      pending.clear();
    },
  };
}
module.exports = { client };
