const fs = require("node:fs/promises");
const { openAsBlob } = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");

function assetPaths(version) {
  return [
    `native/deb/s3-browser_${version}-1_amd64.deb`,
    `native/rpm/s3-browser-${version}-1.x86_64.rpm`,
    `native/alpm/s3-browser-${version}-1-x86_64.pkg.tar.zst`,
    `s3-browser-${version}-linux-x64.tar.gz`,
    `native/deb/s3-browser_${version}-1_arm64.deb`,
    `native/rpm/s3-browser-${version}-1.aarch64.rpm`,
    `native/alpm/s3-browser-${version}-1-aarch64.pkg.tar.zst`,
    `s3-browser-${version}-linux-arm64.tar.gz`,
  ];
}
async function validate(root, env = process.env) {
  const tag = env.RELEASE_TAG;
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag || ""))
    throw new Error(
      "Release tag must be vMAJOR.MINOR.PATCH (stable versions only).",
    );
  const version = tag.slice(1);
  const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json")));
  const lock = JSON.parse(
    await fs.readFile(path.join(root, "package-lock.json")),
  );
  if (
    pkg.version !== version ||
    lock.version !== version ||
    lock.packages?.[""]?.version !== version
  )
    throw new Error(
      "Release tag must match package.json and package-lock.json versions.",
    );
  if (!/^[a-f0-9]{40,64}$/i.test(env.RELEASE_SHA || ""))
    throw new Error(
      "RELEASE_SHA must identify the commit that triggered this run.",
    );
  const git = (ref) =>
    execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
      cwd: root,
      encoding: "utf8",
    }).trim();
  const sha = git("HEAD");
  if (git(`refs/tags/${tag}`) !== sha || git(env.RELEASE_SHA) !== sha)
    throw new Error(
      "The release tag, event commit and checked-out commit must match.",
    );
  return { tag, version, sha };
}
async function digest(file) {
  const hash = createHash("sha256");
  for await (const chunk of (await openAsBlob(file)).stream())
    hash.update(chunk);
  return hash.digest("hex");
}
async function prepare(root, env = process.env) {
  const release = await validate(root, env);
  const files = assetPaths(release.version);
  // Validate the entire set before clearing a previous staging directory.
  for (const file of files) {
    const stat = await fs.lstat(path.join(root, "dist", file));
    if (!stat.isFile() || stat.size === 0)
      throw new Error(`Missing or empty release asset: ${file}`);
  }
  const out = path.join(root, "dist/release");
  await fs.rm(out, { recursive: true, force: true });
  await fs.mkdir(out, { recursive: true });
  for (const file of files)
    await fs.copyFile(
      path.join(root, "dist", file),
      path.join(out, path.basename(file)),
    );
  const sums = [];
  for (const name of files.map((file) => path.basename(file)).sort())
    sums.push(`${await digest(path.join(out, name))}  ${name}`);
  await fs.writeFile(path.join(out, "SHA256SUMS"), sums.join("\n") + "\n");
  return release;
}
async function publish(root, env = process.env, request = fetch) {
  const release = await validate(root, env);
  const origin = new URL(env.FORGEJO_URL);
  if (
    !["https:", "http:"].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash
  )
    throw new Error(
      "FORGEJO_URL must be an HTTP(S) instance URL without credentials or query parameters.",
    );
  const repository = env.FORGEJO_REPOSITORY;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository || ""))
    throw new Error("FORGEJO_REPOSITORY must be owner/repository.");
  if (!env.FORGEJO_TOKEN)
    throw new Error(
      "A Forgejo token with repository write access is required.",
    );
  const base = `${origin.href.replace(/\/$/, "")}/api/v1/repos/${repository}`;
  const token = { Authorization: `token ${env.FORGEJO_TOKEN}` };
  async function api(route, { method = "GET", body, missing = false } = {}) {
    const response = await request(base + route, {
      method,
      redirect: "error",
      headers: {
        ...token,
        ...(body && !(body instanceof FormData)
          ? { "Content-Type": "application/json" }
          : {}),
      },
      body:
        body instanceof FormData
          ? body
          : body
            ? JSON.stringify(body)
            : undefined,
      signal: AbortSignal.timeout(300000),
    });
    if (missing && response.status === 404) return null;
    if (!response.ok)
      throw new Error(
        `Forgejo ${method} ${route} failed (HTTP ${response.status}).`,
      );
    return response.status === 204 ? null : response.json();
  }
  const tagPath = encodeURIComponent(release.tag);
  async function verifyTag() {
    const remote = await api(`/tags/${tagPath}`);
    if (remote.commit?.sha !== release.sha)
      throw new Error(
        "Remote release tag does not match the tested commit; refusing publication.",
      );
  }
  const directory = path.join(root, "dist/release");
  const names = assetPaths(release.version)
    .map((file) => path.basename(file))
    .sort();
  const expectedSums = [];
  for (const name of names)
    expectedSums.push(`${await digest(path.join(directory, name))}  ${name}`);
  if (
    (await fs.readFile(path.join(directory, "SHA256SUMS"), "utf8")) !==
    expectedSums.join("\n") + "\n"
  )
    throw new Error("Release checksums do not match the staged assets.");
  names.push("SHA256SUMS");
  await verifyTag();
  let record = await api(`/releases/tags/${tagPath}`, { missing: true });
  if (!record) {
    try {
      record = await api("/releases", {
        method: "POST",
        body: {
          tag_name: release.tag,
          target_commitish: release.sha,
          name: release.tag,
          draft: true,
          prerelease: false,
          body: `Linux x86_64 and ARM64 packages for S3 Browser ${release.version}.\n\nIncludes DEB, RPM, Arch and a portable archive. Verify downloads with SHA256SUMS.\n\nBuilt from commit ${release.sha}.`,
        },
      });
    } catch (error) {
      // A timeout or another run may have created it. Read before retrying.
      record = await api(`/releases/tags/${tagPath}`, { missing: true });
      if (!record) throw error;
    }
  }
  if (
    record.tag_name !== release.tag ||
    !Number.isSafeInteger(record.id) ||
    record.prerelease
  )
    throw new Error(
      "Existing release is not the expected stable tagged release.",
    );
  async function attachments() {
    const result = [];
    for (let page = 1; ; page++) {
      const rows = await api(
        `/releases/${record.id}/assets?page=${page}&limit=50`,
      );
      result.push(...rows);
      if (rows.length < 50) return result;
    }
  }
  async function verifyAsset(asset, name) {
    const url = new URL(asset.browser_download_url);
    if (url.origin !== origin.origin)
      throw new Error("Unexpected release asset download origin.");
    const response = await request(url, {
      headers: token,
      signal: AbortSignal.timeout(300000),
    });
    if (!response.ok)
      throw new Error(
        `Could not verify uploaded asset ${name} (HTTP ${response.status}).`,
      );
    const hash = createHash("sha256");
    for await (const chunk of response.body) hash.update(chunk);
    if (hash.digest("hex") !== (await digest(path.join(directory, name))))
      throw new Error(
        `Existing release asset differs: ${name}. Refusing to replace published bytes.`,
      );
  }
  for (const name of names) {
    let matches = (await attachments()).filter((asset) => asset.name === name);
    if (matches.length > 1) throw new Error(`Duplicate release asset: ${name}`);
    if (!matches.length) {
      const body = new FormData();
      body.append(
        "attachment",
        await openAsBlob(path.join(directory, name)),
        name,
      );
      try {
        await api(
          `/releases/${record.id}/assets?name=${encodeURIComponent(name)}`,
          { method: "POST", body },
        );
      } catch (error) {
        matches = (await attachments()).filter((asset) => asset.name === name);
        if (!matches.length) throw error;
      }
      matches = (await attachments()).filter((asset) => asset.name === name);
    }
    if (matches.length !== 1)
      throw new Error(`Release asset is missing or duplicated: ${name}`);
    await verifyAsset(matches[0], name);
  }
  await verifyTag();
  // Preserve existing release notes/title. New or partially uploaded releases
  // remain drafts until every expected asset has been verified byte-for-byte.
  if (record.draft)
    await api(`/releases/${record.id}`, {
      method: "PATCH",
      body: { draft: false },
    });
  return (
    record.html_url ||
    `${origin.href.replace(/\/$/, "")}/${repository}/releases/tag/${release.tag}`
  );
}
if (require.main === module) {
  const root = path.resolve(__dirname, "../..");
  const actions = { validate, prepare, publish };
  const action = actions[process.argv[2]];
  if (!action)
    throw new Error(
      "Usage: node scripts/ci/release.cjs validate|prepare|publish",
    );
  action(root)
    .then((result) =>
      console.log(
        typeof result === "string"
          ? result
          : `Validated ${result.tag} at ${result.sha}`,
      ),
    )
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
module.exports = { validate, prepare, publish, assetPaths };
