const fs = require("node:fs/promises");
const { openAsBlob } = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");

function assetPaths(version) {
  return [
    `native/deb/objectfilemanager_${version}-1_amd64.deb`,
    `native/rpm/objectfilemanager-${version}-1.x86_64.rpm`,
    `native/alpm/objectfilemanager-${version}-1-x86_64.pkg.tar.zst`,
    `objectfilemanager-${version}-linux-x64.tar.gz`,
    `native/deb/objectfilemanager_${version}-1_arm64.deb`,
    `native/rpm/objectfilemanager-${version}-1.aarch64.rpm`,
    `native/alpm/objectfilemanager-${version}-1-aarch64.pkg.tar.zst`,
    `objectfilemanager-${version}-linux-arm64.tar.gz`,
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
  const repository = env.GITHUB_REPOSITORY;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository || ""))
    throw new Error("GITHUB_REPOSITORY must be owner/repository.");
  if (!env.GITHUB_TOKEN)
    throw new Error("A GitHub token with contents:write access is required.");
  const base = `https://api.github.com/repos/${repository}`;
  const headers = {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2026-03-10",
  };
  async function api(route, { method = "GET", body } = {}) {
    const response = await request(base + route, {
      method,
      redirect: "error",
      headers: {
        ...headers,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(300000),
    });
    if (!response.ok)
      throw new Error(
        `GitHub ${method} ${route} failed (HTTP ${response.status}).`,
      );
    return response.status === 204 ? null : response.json();
  }
  async function list(route) {
    const result = [];
    for (let page = 1; ; page++) {
      const rows = await api(`${route}?page=${page}&per_page=100`);
      if (!Array.isArray(rows))
        throw new Error("Invalid GitHub list response.");
      result.push(...rows);
      if (rows.length < 100) return result;
    }
  }
  async function findRelease() {
    // Listing includes drafts for callers with push access; the by-tag endpoint
    // is documented for published releases and cannot recover an interrupted draft.
    const matches = (await list("/releases")).filter(
      (row) => row.tag_name === release.tag,
    );
    if (matches.length > 1)
      throw new Error(`Duplicate release for ${release.tag}.`);
    return matches[0];
  }
  async function verifyTag() {
    // Explicit refs/tags/ avoids a same-named branch and resolves annotated tags to
    // their commit, unlike comparing a Git reference's tag-object SHA directly.
    const remote = await api(
      `/commits/${encodeURIComponent(`refs/tags/${release.tag}`)}`,
    );
    if (remote.sha !== release.sha)
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
  let record = await findRelease();
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
          body: `Linux x86_64 and ARM64 packages for ObjectFileManager ${release.version}.\n\nIncludes DEB, RPM, Arch and a portable archive. Verify downloads with SHA256SUMS.\n\nBuilt from commit ${release.sha}.`,
        },
      });
    } catch (error) {
      // A timeout or another run may have created it. Read before retrying.
      record = await findRelease();
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
  const uploadURL = new URL(record.upload_url.replace(/\{\?name,label\}$/, ""));
  if (
    uploadURL.origin !== "https://uploads.github.com" ||
    uploadURL.username ||
    uploadURL.password ||
    uploadURL.search ||
    uploadURL.hash ||
    uploadURL.pathname !== `/repos/${repository}/releases/${record.id}/assets`
  )
    throw new Error("Unexpected release asset upload URL.");
  async function attachments() {
    const assets = await list(`/releases/${record.id}/assets`);
    const seen = new Set();
    for (const asset of assets) {
      if (seen.has(asset.name))
        throw new Error(`Duplicate release asset: ${asset.name}`);
      seen.add(asset.name);
    }
    for (const asset of assets)
      if (!names.includes(asset.name))
        throw new Error(
          `Unexpected release asset: ${asset.name}. Refusing to alter this release.`,
        );
    return assets;
  }
  async function verifyAsset(asset, name) {
    if (
      !Number.isSafeInteger(asset.id) ||
      asset.id < 1 ||
      asset.state !== "uploaded"
    )
      throw new Error(`Release asset is not fully uploaded: ${name}`);
    let url = new URL(`${base}/releases/assets/${asset.id}`);
    let response;
    for (let redirects = 0; ; redirects++) {
      response = await request(url, {
        redirect: "manual",
        headers: {
          ...(redirects === 0 ? headers : {}),
          Accept: "application/octet-stream",
        },
        signal: AbortSignal.timeout(300000),
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      await response.body?.cancel();
      if (redirects >= 5 || !response.headers.get("location"))
        throw new Error("Invalid release asset download redirect.");
      url = new URL(response.headers.get("location"), url);
      // Signed storage URLs need no token. Never forward GitHub credentials to
      // a redirected host (or allow a downgrade to plaintext HTTP).
      if (url.protocol !== "https:" || url.username || url.password)
        throw new Error("Unsafe release asset download redirect.");
    }
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
      const body = await openAsBlob(path.join(directory, name));
      const url = new URL(uploadURL);
      url.searchParams.set("name", name);
      try {
        const response = await request(url, {
          method: "POST",
          redirect: "error",
          headers: {
            ...headers,
            "Content-Type": "application/octet-stream",
            "Content-Length": String(body.size),
          },
          body,
          signal: AbortSignal.timeout(300000),
        });
        if (!response.ok)
          throw new Error(
            `GitHub asset upload failed (HTTP ${response.status}).`,
          );
        await response.arrayBuffer();
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
  if ((await attachments()).length !== names.length)
    throw new Error("Release asset set changed during verification.");
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
    `https://github.com/${repository}/releases/tag/${release.tag}`
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
