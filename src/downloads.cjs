const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const {
  ListObjectsV2Command,
  HeadObjectCommand,
  GetObjectCommand,
} = require("@aws-sdk/client-s3");

function safeParts(relative, directory = false) {
  if (directory && relative.endsWith("/")) relative = relative.slice(0, -1);
  const parts = relative.split("/");
  if (
    !relative ||
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        /[<>:"\\|?*\x00-\x1f\x7f]/.test(part) ||
        /[. ]$/.test(part) ||
        /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part) ||
        Buffer.byteLength(part) > 255 ||
        part.startsWith(".objectfilemanager-"),
    )
  ) {
    throw new Error(
      `Object has an unsafe or nonportable local path: ${relative}`,
    );
  }
  return parts;
}

async function statIfExists(file) {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

// Inspect each ancestor, including ancestors above the selected destination.
// Never use recursive mkdir, which follows existing directory symlinks.
async function directories(directory, create = false) {
  const parsed = path.parse(directory);
  let current = parsed.root;
  for (const part of directory
    .slice(parsed.root.length)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, part);
    let stat = await statIfExists(current);
    if (!stat && create) {
      try {
        await fs.mkdir(current);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      stat = await statIfExists(current);
    }
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink()))
      throw new Error(
        `Unsafe destination directory (symlink or file): ${current}`,
      );
  }
}

async function checkDestination(file, directory) {
  await directories(path.dirname(file));
  const stat = await statIfExists(file);
  if (
    stat &&
    (stat.isSymbolicLink() ||
      (directory ? !stat.isDirectory() : !stat.isFile()))
  )
    throw new Error(
      `Destination has a symlink or file/directory conflict: ${file}`,
    );
  return stat;
}

const sameFile = (a, b) =>
  a &&
  b &&
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.birthtimeMs === b.birthtimeMs;

function publicationMarker(destination) {
  // Identify the local destination, independently of remote key/prefix or batch.
  const hash = createHash("sha256")
    .update(destination.normalize("NFC").toLowerCase())
    .digest("hex")
    .slice(0, 32);
  return path.join(
    path.dirname(destination),
    `.objectfilemanager-${hash}.publish`,
  );
}

async function digestFile(filename, signal) {
  const before = await checkDestination(filename, false);
  const handle = await fs.open(
    filename,
    constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
  );
  try {
    if (!sameFile(before, await handle.stat()))
      throw new Error("Download file changed while verifying it.");
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      signal.throwIfAborted();
      hash.update(chunk);
    }
    const after = await checkDestination(filename, false);
    if (
      !sameFile(before, after) ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error("Download file changed while verifying it.");
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

async function recoverPublication(destination, existing, job, entry, signal) {
  const marker = publicationMarker(destination);
  if (!(await statIfExists(marker))) return false;
  await checkDestination(marker, false);
  const handle = await fs.open(
    marker,
    constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
  );
  let record;
  try {
    if ((await handle.stat()).size > 16384)
      throw new Error("Invalid download publication record.");
    record = JSON.parse(await handle.readFile("utf8"));
  } catch {
    throw new Error(
      `Unfinished download publication; move or remove ${destination} and ${marker} before retrying.`,
    );
  } finally {
    await handle.close();
  }
  if (!existing) {
    await fs.unlink(marker);
    return false;
  }
  if (
    record.destination === destination &&
    record.profile === job.profile &&
    record.bucket === job.bucket &&
    record.key === entry.key &&
    record.etag === entry.etag &&
    record.size === entry.size &&
    existing.size === entry.size &&
    typeof record.sha256 === "string" &&
    (await digestFile(destination, signal)) === record.sha256
  ) {
    signal.throwIfAborted();
    await fs.unlink(marker);
    return true;
  }
  // A crash may have happened between exclusive creation and recording its
  // identity. Never delete an ambiguous file or accept a partial copy as a skip.
  throw new Error(
    `Unfinished download publication; move or remove ${destination} and ${marker} before retrying.`,
  );
}

async function publishWithoutLinks(temporary, destination, job, entry, signal) {
  const marker = publicationMarker(destination);
  const sha256 = await digestFile(temporary, signal);
  let record, source, target, owned;
  let ownsMarker = false;
  try {
    signal.throwIfAborted();
    record = await fs.open(marker, "wx", 0o600);
    ownsMarker = true;
    await record.writeFile(
      JSON.stringify({
        destination,
        profile: job.profile,
        bucket: job.bucket,
        key: entry.key,
        etag: entry.etag,
        size: entry.size,
        sha256,
      }),
    );
    await record.sync();
    await record.close();
    record = null;
    await checkDestination(destination, false);
    signal.throwIfAborted();
    try {
      target = await fs.open(
        destination,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          (constants.O_NOFOLLOW || 0),
        0o600,
      );
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      await checkDestination(destination, false);
      return "skipped";
    }
    owned = await target.stat();
    const sourceStat = await checkDestination(temporary, false);
    source = await fs.open(
      temporary,
      constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
    );
    if (
      !sameFile(sourceStat, await source.stat()) ||
      sourceStat.size !== entry.size
    )
      throw new Error("Download temporary file changed during publication.");
    const buffer = Buffer.alloc(1024 * 1024);
    let copied = 0;
    while (true) {
      signal.throwIfAborted();
      const { bytesRead } = await source.read(buffer);
      if (!bytesRead) break;
      copied += bytesRead;
      if (copied > entry.size)
        throw new Error("Download temporary file changed during publication.");
      await target.writeFile(buffer.subarray(0, bytesRead));
    }
    if (copied !== entry.size)
      throw new Error("Download temporary file changed during publication.");
    signal.throwIfAborted();
    await target.sync();
    await target.close();
    target = null;
    if (!sameFile(owned, await checkDestination(destination, false)))
      throw new Error("Download destination changed during publication.");
    if ((await digestFile(destination, signal)) !== sha256)
      throw new Error("Download changed during publication.");
    owned = null;
    return "done";
  } finally {
    await record?.close();
    await source?.close();
    await target?.close();
    if (target && !owned)
      throw new Error(
        "Unable to verify download destination ownership; publication record retained.",
      );
    if (owned) {
      // Do not remove a replacement created by another process.
      if (sameFile(owned, await checkDestination(destination, false)))
        await fs.unlink(destination);
    }
    if (ownsMarker) await fs.unlink(marker);
  }
}

async function plan(s3, { bucket, prefix = "", selection, destination }) {
  if (!bucket || !Array.isArray(selection) || !selection.length || !destination)
    throw new Error("Choose objects and a destination folder.");
  if (prefix && !prefix.endsWith("/")) prefix += "/";
  const root = path.resolve(destination);
  await directories(root);
  const rootStat = await statIfExists(root);
  if (!rootStat?.isDirectory())
    throw new Error("The destination folder must exist.");
  const objects = new Map();
  const add = (object) => {
    if (!object.Key || !object.Key.startsWith(prefix))
      throw new Error("Object is outside the selected prefix.");
    objects.set(object.Key, object);
  };
  for (const selected of selection) {
    if (typeof selected.key !== "string" || !selected.key.startsWith(prefix))
      throw new Error("Object is outside the selected prefix.");
    if (selected.folder) {
      const folder = selected.key.endsWith("/")
        ? selected.key
        : `${selected.key}/`;
      safeParts(folder.slice(prefix.length), true);
      let token;
      const seen = new Set();
      do {
        const page = await s3.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: folder,
            ContinuationToken: token,
          }),
        );
        for (const object of page.Contents || []) {
          if (!object.Key?.startsWith(folder))
            throw new Error(
              "Storage returned an object outside the requested folder.",
            );
          add(object);
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
        if (page.IsTruncated && (!token || seen.has(token)))
          throw new Error("Storage returned invalid download pagination.");
        if (token) seen.add(token);
      } while (token);
    } else {
      const object = await s3.send(
        new HeadObjectCommand({ Bucket: bucket, Key: selected.key }),
      );
      add({ Key: selected.key, Size: object.ContentLength, ETag: object.ETag });
    }
  }
  const destinations = new Map();
  const entries = [];
  for (const object of objects.values()) {
    const directory = object.Key.endsWith("/");
    const parts = safeParts(object.Key.slice(prefix.length), directory);
    if (directory && object.Size)
      throw new Error(
        `Nonempty folder marker cannot be downloaded safely: ${object.Key}`,
      );
    if (!Number.isSafeInteger(object.Size) || object.Size < 0)
      throw new Error(`Invalid object size: ${object.Key}`);
    for (let i = 1; i <= parts.length; i++) {
      const name = parts.slice(0, i).join("/");
      const folded = name.normalize("NFC").toLowerCase();
      const isDirectory = i < parts.length || directory;
      const previous = destinations.get(folded);
      if (
        previous &&
        (previous.name !== name || previous.directory !== isDirectory)
      )
        throw new Error(
          `Objects have colliding local paths: ${previous.name} and ${name}`,
        );
      destinations.set(folded, { name, directory: isDirectory });
    }
    const source = path.join(root, ...parts);
    await checkDestination(source, directory);
    if (!directory && !object.ETag) {
      const snapshot = await s3.send(
        new HeadObjectCommand({ Bucket: bucket, Key: object.Key }),
      );
      if (!snapshot.ETag || snapshot.ContentLength !== object.Size)
        throw new Error(
          `Cannot establish a stable source snapshot: ${object.Key}`,
        );
      object.ETag = snapshot.ETag;
    }
    entries.push({
      key: object.Key,
      source,
      root,
      size: object.Size,
      directory,
      mtime: 0,
      etag: object.ETag || null,
    });
  }
  return entries;
}

async function transfer(s3, job, entry, signal, onProgress = () => {}) {
  signal.throwIfAborted();
  if (!entry.root || !path.isAbsolute(entry.source))
    throw new Error("Download has no safe destination root.");
  const root = path.resolve(entry.root);
  const relative = path.relative(root, entry.source);
  const parts = safeParts(
    relative.split(path.sep).join("/"),
    !!entry.directory,
  );
  const destination = path.join(root, ...parts);
  if (destination !== entry.source)
    throw new Error("Download destination is outside its root.");
  await directories(root);
  if (!(await statIfExists(root))?.isDirectory())
    throw new Error("Download destination folder is missing.");
  const existing = await checkDestination(destination, !!entry.directory);
  if (entry.directory) {
    signal.throwIfAborted();
    await directories(destination, true);
    return "done";
  }
  const recovered = await recoverPublication(
    destination,
    existing,
    job,
    entry,
    signal,
  );
  if (existing && !job.overwrite && !recovered) return "skipped";
  if (!entry.etag)
    throw new Error(
      "Download has no source ETag. Create a new download batch.",
    );
  await directories(path.dirname(destination), true);
  const hash = createHash("sha256")
    .update(`${root}\0${entry.key}`)
    .digest("hex")
    .slice(0, 32);
  const temporary = path.join(
    path.dirname(destination),
    `.objectfilemanager-${hash}.part`,
  );
  const stale = await statIfExists(temporary);
  if (stale) {
    if (!stale.isFile() || stale.isSymbolicLink())
      throw new Error("Unsafe download temporary file.");
    await fs.unlink(temporary);
  }
  if (recovered) return "done";
  let file, body;
  let ownedTemporary = false;
  const abort = () => body?.destroy?.();
  try {
    file = await fs.open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW || 0),
      0o600,
    );
    ownedTemporary = true;
    const response = await s3.send(
      new GetObjectCommand({
        Bucket: job.bucket,
        Key: entry.key,
        ...(entry.etag ? { IfMatch: entry.etag } : {}),
      }),
      { abortSignal: signal },
    );
    body = response.Body;
    if (!body || !body[Symbol.asyncIterator])
      throw new Error("Storage returned no downloadable object body.");
    signal.addEventListener("abort", abort, { once: true });
    signal.throwIfAborted();
    let loaded = 0;
    for await (const chunk of body) {
      signal.throwIfAborted();
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (job.throttle) await job.throttle(bytes.length, signal);
      signal.throwIfAborted();
      loaded += bytes.length;
      if (loaded > entry.size)
        throw new Error("Source size changed since this download was queued.");
      await file.writeFile(bytes);
      onProgress(loaded);
    }
    signal.throwIfAborted();
    if (loaded !== entry.size)
      throw new Error(
        "Download ended before the expected object size was received.",
      );
    await file.sync();
    await file.close();
    file = null;
    await checkDestination(destination, false);
    signal.throwIfAborted();
    if (job.overwrite) {
      await fs.rename(temporary, destination);
    } else {
      try {
        await fs.link(temporary, destination);
      } catch (error) {
        if (
          ["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV"].includes(
            error.code,
          )
        )
          return await publishWithoutLinks(
            temporary,
            destination,
            job,
            entry,
            signal,
          );
        if (error.code !== "EEXIST") throw error;
        await checkDestination(destination, false);
        return "skipped";
      }
    }
    return "done";
  } finally {
    signal.removeEventListener("abort", abort);
    body?.destroy?.();
    await file?.close();
    if (ownedTemporary) {
      await directories(path.dirname(temporary));
      await fs.unlink(temporary).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
}

module.exports = { plan, transfer };
