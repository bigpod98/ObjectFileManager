const fs = require("node:fs/promises");
const { randomUUID } = require("node:crypto");
const {
  PROVIDERS,
  restoreProfile,
  serializeProfile,
} = require("./profiles.cjs");

// Queue the whole read/modify/persist operation. A rejection must not poison
// later requests, and callers still receive their own operation's error.
function serialMutations() {
  let tail = Promise.resolve();
  return (operation) => {
    const result = tail.then(operation);
    tail = result.catch(() => {});
    return result;
  };
}

class JsonFile {
  constructor(target, { io = fs, report = () => {} } = {}) {
    this.target = target;
    this.io = io;
    this.report = report;
    this.blocked = new Error("Local state has not been loaded.");
  }

  async load(fallback, decode) {
    let original;
    try {
      original = await this.io.readFile(this.target);
    } catch (error) {
      if (error.code === "ENOENT") this.blocked = null;
      else {
        this.blocked = new Error(
          `Saving ${this.target} is disabled because it could not be read.`,
        );
        this.report(this.blocked.message);
      }
      return fallback;
    }
    let result = { value: fallback, invalid: true };
    try {
      result = decode(JSON.parse(original.toString("utf8")));
    } catch {
      // Never include a JSON parser error: it can contain credential material.
    }
    if (result.invalid) {
      const backup = `${this.target}.corrupt-${randomUUID()}.bak`;
      try {
        await this.io.writeFile(backup, original, { mode: 0o600, flag: "wx" });
        this.blocked = null;
        this.report(
          `Invalid local state was preserved in ${backup}. Valid entries were recovered.`,
        );
      } catch {
        this.blocked = new Error(
          `Saving ${this.target} is disabled because a backup of its invalid contents could not be created. Preserve the file and restart to retry.`,
        );
        this.report(this.blocked.message);
      }
    } else this.blocked = null;
    return result.value;
  }

  async recoveryCopy(value) {
    if (this.blocked) throw this.blocked;
    const backup = `${this.target}.recovery-${randomUUID()}.bak`;
    await this.io.writeFile(backup, JSON.stringify(value), {
      mode: 0o600,
      flag: "wx",
    });
    return backup;
  }

  async discardRecovery(backup) {
    if (backup) await this.io.unlink(backup).catch(() => {});
  }

  async save(value) {
    if (this.blocked) throw this.blocked;
    const temporary = `${this.target}.${randomUUID()}.tmp`;
    try {
      await this.io.writeFile(temporary, JSON.stringify(value), {
        mode: 0o600,
        flag: "wx",
      });
      await this.io.rename(temporary, this.target);
    } finally {
      await this.io.unlink(temporary).catch(() => {});
    }
  }
}

const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const nonempty = (value) => typeof value === "string" && !!value.trim();
function decodeProfiles(value, safeStorage) {
  if (!Array.isArray(value)) return { value: [], invalid: true };
  const ids = new Set();
  let invalid = false;
  const profiles = [];
  for (const entry of value) {
    if (
      !record(entry) ||
      !nonempty(entry.id) ||
      !nonempty(entry.name) ||
      !PROVIDERS.includes(entry.provider) ||
      !nonempty(entry.credentials) ||
      ids.has(entry.id) ||
      Object.entries(entry).some(([key, field]) =>
        ["remember", "pathStyle"].includes(key)
          ? typeof field !== "boolean"
          : [
              "endpoint",
              "region",
              "bucket",
              "projectId",
              "swiftAuth",
              "authUrl",
              "projectName",
              "domainName",
              "domainId",
              "googleAuth",
              "azureAuth",
            ].includes(key) && typeof field !== "string",
      )
    ) {
      invalid = true;
      continue;
    }
    ids.add(entry.id);
    // Every entry on disk is a remembered profile, including legacy entries
    // without an explicit remember flag. Locked payloads are serialized intact.
    profiles.push({ ...restoreProfile(entry, safeStorage), remember: true });
  }
  return { value: profiles, invalid };
}
function encodeProfiles(profiles, safeStorage) {
  return profiles
    .filter((profile) => profile.remember)
    .map((profile) => serializeProfile(profile, safeStorage));
}
function cleanLocation(value) {
  if (
    !record(value) ||
    !nonempty(value.profile) ||
    !nonempty(value.bucket) ||
    (value.prefix !== undefined && typeof value.prefix !== "string")
  )
    throw new Error(
      "A saved location requires a connection, bucket, and string prefix.",
    );
  return {
    profile: value.profile,
    bucket: value.bucket,
    prefix: value.prefix || "",
  };
}
function decodeLocations(value) {
  if (!record(value))
    return { value: { bookmarks: [], recent: [] }, invalid: true };
  let invalid = false;
  const result = {};
  for (const key of ["bookmarks", "recent"]) {
    result[key] = [];
    if (!Array.isArray(value[key])) {
      invalid = true;
      continue;
    }
    for (const location of value[key]) {
      try {
        result[key].push(cleanLocation(location));
      } catch {
        invalid = true;
      }
    }
  }
  return { value: result, invalid };
}
function withoutProfile(locations, id) {
  return Object.fromEntries(
    ["bookmarks", "recent"].map((key) => [
      key,
      locations[key].filter((location) => location.profile !== id),
    ]),
  );
}
module.exports = {
  JsonFile,
  serialMutations,
  decodeProfiles,
  encodeProfiles,
  cleanLocation,
  decodeLocations,
  withoutProfile,
};
