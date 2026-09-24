const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const {
  ListObjectsV2Command,
  HeadObjectCommand,
  DeleteObjectCommand,
} = require("@aws-sdk/client-s3");

const missing = (error) =>
  error?.$metadata?.httpStatusCode === 404 ||
  ["NotFound", "NoSuchKey"].includes(error?.name);
const timestamp = (value) => (value ? new Date(value).toISOString() : null);
const identity = (stat) => ({
  size: stat.size,
  mtime: stat.mtimeMs,
  ctime: stat.ctimeMs,
  dev: stat.dev,
  ino: stat.ino,
});
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function localTree(source, prefix, signal) {
  signal?.throwIfAborted();
  source = path.resolve(source);
  if ((await fs.realpath(source)) !== source)
    throw new Error(
      "Sync source and its parent directories must not be symbolic links.",
    );
  if (!(await fs.lstat(source)).isDirectory())
    throw new Error("Choose a local folder to compare.");
  const snapshot = [],
    entries = [],
    skipped = [];
  async function walk(file, relative) {
    signal?.throwIfAborted();
    const stat = await fs.lstat(file);
    signal?.throwIfAborted();
    const before = identity(stat);
    const type = stat.isSymbolicLink()
      ? "symlink"
      : stat.isDirectory()
        ? "directory"
        : stat.isFile()
          ? "file"
          : "special";
    const key =
      prefix + relative + (type === "directory" && relative ? "/" : "");
    if (Buffer.byteLength(key) > 1024)
      throw new Error(`S3 key exceeds 1,024 bytes: ${key}`);
    const record = { relative, type, ...before };
    snapshot.push(record);
    if (type === "symlink" || type === "special") {
      if (type === "symlink") record.target = await fs.readlink(file);
      skipped.push({ key: prefix + relative, type });
      return;
    }
    const entry = {
      source: file,
      root: source,
      key,
      size: type === "directory" ? 0 : stat.size,
      mtime: stat.mtimeMs,
      directory: type === "directory",
    };
    if (type === "file") {
      const handle = await fs.open(
        file,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        if (!same(identity(await handle.stat()), before))
          throw new Error(`Local source changed while comparing: ${file}`);
        const md5 = createHash("md5"),
          sha256 = createHash("sha256"),
          sha1 = createHash("sha1");
        for await (const chunk of handle.createReadStream({
          autoClose: false,
          signal,
        })) {
          signal?.throwIfAborted();
          md5.update(chunk);
          sha256.update(chunk);
          sha1.update(chunk);
        }
        signal?.throwIfAborted();
        record.sha256 = sha256.digest("base64");
        entry.sha256 = record.sha256;
        entry.md5 = md5.digest("hex");
        entry.sha1 = sha1.digest("base64");
      } finally {
        await handle.close();
      }
    }
    if (relative) entries.push(entry);
    if (type === "directory") {
      const names = (await fs.readdir(file)).sort();
      for (const name of names)
        await walk(
          path.join(file, name),
          relative ? `${relative}/${name}` : name,
        );
    }
    if (!same(identity(await fs.lstat(file)), before))
      throw new Error(`Local source changed while comparing: ${file}`);
  }
  await walk(source, "");
  signal?.throwIfAborted();
  return { source, snapshot, entries, skipped };
}

async function head(s3, bucket, key, checksum = false, signal) {
  signal?.throwIfAborted();
  try {
    let result;
    try {
      result = await s3.send(
        new HeadObjectCommand({
          Bucket: bucket,
          Key: key,
          ...(checksum ? { ChecksumMode: "ENABLED" } : {}),
        }),
        { abortSignal: signal },
      );
    } catch (error) {
      signal?.throwIfAborted();
      if (
        !checksum ||
        !(
          [400, 403, 501].includes(error?.$metadata?.httpStatusCode) ||
          ["NotImplemented", "InvalidRequest", "InvalidArgument"].includes(
            error?.name,
          )
        )
      )
        throw error;
      result = await s3.send(
        new HeadObjectCommand({ Bucket: bucket, Key: key }),
        { abortSignal: signal },
      );
    }
    signal?.throwIfAborted();
    return {
      key,
      size: result.ContentLength,
      etag: result.ETag || null,
      modified: timestamp(result.LastModified),
      versionId: result.VersionId || null,
      checksumSHA256: result.ChecksumSHA256,
      checksumSHA1: result.ChecksumSHA1,
      checksumType: result.ChecksumType,
      encryption: result.ServerSideEncryption,
    };
  } catch (error) {
    signal?.throwIfAborted();
    if (missing(error)) return null;
    throw error;
  }
}

function snapshotOf(remote) {
  return (
    remote && {
      key: remote.key,
      size: remote.size,
      etag: remote.etag,
      modified: remote.modified,
      versionId: remote.versionId,
    }
  );
}

async function remoteTree(s3, bucket, prefix) {
  const objects = new Map(),
    seen = new Set();
  let token;
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
          "The server returned an object outside the requested sync prefix.",
        );
      objects.set(object.Key, {
        key: object.Key,
        size: object.Size,
        etag: object.ETag || null,
        modified: timestamp(object.LastModified),
      });
    }
    token = page.NextContinuationToken;
    if (page.IsTruncated && !token)
      throw new Error(
        "The remote listing is incomplete; the server omitted its continuation token.",
      );
    if (token && seen.has(token))
      throw new Error("The remote listing repeated a continuation token.");
    if (token) seen.add(token);
  } while (token);
  return objects;
}

function overlap(a, b) {
  a = a.replace(/\/$/, "");
  b = b.replace(/\/$/, "");
  return a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
}

function hasPrefix(sortedKeys, prefix) {
  let low = 0,
    high = sortedKeys.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (sortedKeys[middle] < prefix) low = middle + 1;
    else high = middle;
  }
  return sortedKeys[low]?.startsWith(prefix) || false;
}

function comparison(local, remote) {
  if (local.size !== remote.size) return ["changed", "Size differs."];
  if (local.directory)
    return ["unchanged", "The folder marker already exists."];
  // Composite checksums are hashes of part checksums, not the full file.
  if (remote.checksumType === "FULL_OBJECT") {
    if (remote.checksumSHA256)
      return local.sha256 === remote.checksumSHA256
        ? ["unchanged", "Full-object SHA-256 matches."]
        : ["changed", "Full-object SHA-256 differs."];
    if (remote.checksumSHA1)
      return local.sha1 === remote.checksumSHA1
        ? ["unchanged", "Full-object SHA-1 matches."]
        : ["changed", "Full-object SHA-1 differs."];
  }
  const etag = (remote.etag || "").replace(/^"|"$/g, "");
  if (
    /^[a-f0-9]{32}$/i.test(etag) &&
    (!remote.encryption || remote.encryption === "AES256")
  )
    return local.md5 === etag.toLowerCase()
      ? ["unchanged", "Size and single-part MD5 ETag match."]
      : ["changed", "Single-part MD5 ETag differs."];
  return [
    "changed",
    "Content equality is uncertain: no supported full-object checksum or single-part MD5 ETag.",
  ];
}

async function compare(
  s3,
  { profile, bucket, prefix = "", source, deleteRemote = false },
) {
  if (!bucket || !source)
    throw new Error("Choose a bucket and a local folder.");
  if (prefix && !prefix.endsWith("/")) prefix += "/";
  const local = await localTree(source, prefix);
  const remote = await remoteTree(s3, bucket, prefix);
  const rows = [],
    entries = [],
    deletions = [],
    remoteSnapshot = [];
  const localKeys = new Set(local.entries.map((entry) => entry.key));
  const blocked = local.skipped.map((entry) => entry.key);
  for (const skipped of local.skipped)
    rows.push({
      ...skipped,
      status: "skipped",
      reason: `Local ${skipped.type} was skipped; overlapping remote paths are protected from deletion.`,
    });
  const remoteKeys = [...remote.keys()].sort();
  for (const entry of local.entries) {
    const bare = entry.key.replace(/\/$/, "");
    const conflict = entry.directory
      ? remote.has(bare)
      : hasPrefix(remoteKeys, entry.key + "/");
    // A remote file above a local path also constitutes a folder/file conflict.
    let ancestor = bare.lastIndexOf("/");
    let parentConflict = false;
    while (ancestor >= prefix.length) {
      if (remote.has(bare.slice(0, ancestor))) {
        parentConflict = true;
        break;
      }
      ancestor = bare.lastIndexOf("/", ancestor - 1);
    }
    if (conflict || parentConflict) {
      blocked.push(entry.key);
      rows.push({
        key: entry.key,
        size: entry.size,
        status: "conflict",
        reason:
          "Local and remote file/folder paths conflict. Resolve this path before syncing.",
      });
      continue;
    }
    const listed = remote.get(entry.key);
    if (!listed) {
      entry.expectedAbsent = true;
      entries.push(entry);
      remoteSnapshot.push({ key: entry.key, exists: false });
      rows.push({
        key: entry.key,
        size: entry.size,
        status: "new",
        reason: "The remote object does not exist.",
      });
      continue;
    }
    const current = await head(s3, bucket, entry.key, true);
    if (
      !current ||
      current.size !== listed.size ||
      current.etag !== listed.etag
    )
      throw new Error(
        `Remote object changed during comparison: ${entry.key}. Compare again.`,
      );
    remoteSnapshot.push({ ...snapshotOf(current), exists: true });
    let [status, reason] = comparison(entry, current);
    if (status === "changed" && !current.etag) {
      status = "conflict";
      reason =
        "The server omitted the ETag needed to safely replace this object.";
    }
    rows.push({ key: entry.key, size: entry.size, status, reason });
    if (status === "changed") {
      entry.etag = current.etag;
      entries.push(entry);
    }
  }
  for (const object of remote.values()) {
    if (localKeys.has(object.key)) continue;
    // The prefix marker itself describes the destination, not a child to delete.
    const protectedPath =
      object.key === prefix || blocked.some((key) => overlap(key, object.key));
    let deletion = false;
    let reason = protectedPath
      ? "Protected by a skipped/conflicting local path or destination folder marker."
      : "Exists only remotely; retained.";
    if (deleteRemote && !protectedPath) {
      const current = await head(s3, bucket, object.key);
      if (
        !current ||
        current.etag !== object.etag ||
        current.size !== object.size
      )
        throw new Error(
          `Remote object changed during comparison: ${object.key}. Compare again.`,
        );
      if (current.etag) {
        deletions.push(snapshotOf(current));
        deletion = true;
        reason =
          "Exists only remotely; scheduled for deletion after successful uploads.";
      } else
        reason =
          "Retained because the server did not provide an ETag for a conditional deletion.";
    }
    rows.push({
      key: object.key,
      size: object.size,
      status: "remote-only",
      reason,
      deletion,
      protected: protectedPath,
    });
  }
  const counts = {
    new: 0,
    changed: 0,
    unchanged: 0,
    "remote-only": 0,
    conflict: 0,
    skipped: 0,
    deletions: deletions.length,
  };
  for (const row of rows) counts[row.status]++;
  return {
    profile,
    bucket,
    prefix,
    source: local.source,
    deleteRemote: !!deleteRemote,
    entries,
    deletions,
    rows,
    counts,
    localSnapshot: local.snapshot,
    remoteSnapshot,
  };
}

async function validate(plan, s3, signal) {
  const current = await localTree(plan.source, plan.prefix, signal);
  signal?.throwIfAborted();
  if (!same(current.snapshot, plan.localSnapshot))
    throw new Error(
      "Local folder contents changed since the sync preview. Compare again before applying or deleting remote objects.",
    );
  if (s3) {
    for (const snapshot of plan.remoteSnapshot || []) {
      const currentRemote = await head(
        s3,
        plan.bucket,
        snapshot.key,
        false,
        signal,
      );
      const expected = snapshot.exists ? snapshotOf(snapshot) : null;
      if (!same(snapshotOf(currentRemote), expected))
        throw new Error(
          `Remote object changed since the sync preview: ${snapshot.key}. Compare again.`,
        );
    }
    await validateDeletions(s3, plan, signal);
  }
  return true;
}

async function validateDeletions(s3, plan, signal) {
  signal?.throwIfAborted();
  const remaining = [];
  for (const snapshot of plan.deletions || []) {
    signal?.throwIfAborted();
    if (
      !snapshot.etag ||
      !snapshot.key.startsWith(plan.prefix) ||
      snapshot.key === plan.prefix
    )
      throw new Error("Invalid remote deletion snapshot. Compare again.");
    const current = await head(s3, plan.bucket, snapshot.key, false, signal);
    if (!current) continue; // Safe to retry after a crash or partial cleanup.
    if (!same(snapshotOf(current), snapshotOf(snapshot)))
      throw new Error(
        `Remote deletion target changed since preview: ${snapshot.key}. Compare again.`,
      );
    remaining.push(snapshot);
  }
  return remaining;
}

async function executeDeletions(s3, plan, signal) {
  await validate(plan, undefined, signal);
  // Complete preflight before making the first destructive request.
  const remaining = await validateDeletions(s3, plan, signal);
  const failures = [];
  let deleted = (plan.deletions || []).length - remaining.length;
  for (const snapshot of remaining) {
    signal?.throwIfAborted();
    try {
      // Conditional deletion must not fall back to an unconditional request.
      await s3.send(
        new DeleteObjectCommand({
          Bucket: plan.bucket,
          Key: snapshot.key,
          IfMatch: snapshot.etag,
        }),
        { abortSignal: signal },
      );
      deleted++;
    } catch (error) {
      signal?.throwIfAborted();
      if (missing(error)) deleted++;
      else failures.push({ key: snapshot.key, error: error.message });
    }
  }
  signal?.throwIfAborted();
  return { deleted, failures };
}

module.exports = { compare, validate, executeDeletions };
