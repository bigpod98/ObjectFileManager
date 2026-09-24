const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const {
  validate,
  prepare,
  publish,
  assetPaths,
} = require("../scripts/ci/release.cjs");

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "s3-release-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-b", "main");
  git("config", "user.email", "ci@example.invalid");
  git("config", "user.name", "CI test");
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ version: "1.2.3" }),
  );
  await fs.writeFile(
    path.join(root, "package-lock.json"),
    JSON.stringify({
      version: "1.2.3",
      packages: { "": { version: "1.2.3" } },
    }),
  );
  git("add", ".");
  git("commit", "-m", "fixture");
  git("tag", "-a", "v1.2.3", "-m", "release");
  const env = {
    RELEASE_TAG: "v1.2.3",
    RELEASE_SHA: git("rev-parse", "HEAD"),
    FORGEJO_URL: "https://forge.example",
    FORGEJO_REPOSITORY: "owner/project",
    FORGEJO_TOKEN: "test-token",
  };
  for (const file of assetPaths("1.2.3")) {
    await fs.mkdir(path.dirname(path.join(root, "dist", file)), {
      recursive: true,
    });
    await fs.writeFile(path.join(root, "dist", file), `fixture ${file}`);
  }
  return { root, env, git };
}
function server(env) {
  const state = {
    release: null,
    assets: [],
    calls: [],
    remoteSha: env.RELEASE_SHA,
    ambiguous: false,
    failUpload: false,
  };
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status });
  state.fetch = async (url, options = {}) => {
    url = new URL(url);
    const method = options.method || "GET";
    assert.equal(options.headers.Authorization, `token ${env.FORGEJO_TOKEN}`);
    state.calls.push({ method, path: url.pathname });
    if (url.pathname.startsWith("/download/"))
      return new Response(
        state.assets.find(
          (a) => a.name === decodeURIComponent(url.pathname.slice(10)),
        ).bytes,
      );
    const route = url.pathname.replace("/api/v1/repos/owner/project", "");
    if (route === "/tags/v1.2.3")
      return json({ commit: { sha: state.remoteSha } });
    if (route === "/releases/tags/v1.2.3")
      return state.release ? json(state.release) : json({}, 404);
    if (route === "/releases" && method === "POST") {
      state.release = {
        ...JSON.parse(options.body),
        id: 7,
        html_url: "https://forge.example/owner/project/releases/tag/v1.2.3",
      };
      if (state.ambiguous)
        throw new Error("Connection closed after creating release");
      return json(state.release, 201);
    }
    if (route === "/releases/7/assets" && method === "GET")
      return json(state.assets.map(({ bytes, ...asset }) => asset));
    if (route === "/releases/7/assets" && method === "POST") {
      if (state.failUpload) return json({}, 500);
      const name = url.searchParams.get("name");
      const asset = {
        id: state.assets.length + 1,
        name,
        browser_download_url: `https://forge.example/download/${encodeURIComponent(name)}`,
        bytes: Buffer.from(await options.body.get("attachment").arrayBuffer()),
      };
      state.assets.push(asset);
      return json({ id: asset.id }, 201);
    }
    if (route === "/releases/7" && method === "PATCH") {
      Object.assign(state.release, JSON.parse(options.body));
      return json(state.release);
    }
    throw new Error(`Unexpected ${method} ${route}`);
  };
  return state;
}
test("release validation binds stable tag, package versions and exact checkout", async (t) => {
  const f = await fixture(t);
  assert.equal((await validate(f.root, f.env)).sha, f.env.RELEASE_SHA);
  for (const tag of ["main", "v1.2.3-rc1", "v01.2.3", "v9.0.0"])
    await assert.rejects(validate(f.root, { ...f.env, RELEASE_TAG: tag }));
  await fs.writeFile(
    path.join(f.root, "package-lock.json"),
    JSON.stringify({
      version: "1.2.2",
      packages: { "": { version: "1.2.3" } },
    }),
  );
  await assert.rejects(validate(f.root, f.env), /versions/);
  await fs.writeFile(
    path.join(f.root, "package-lock.json"),
    JSON.stringify({
      version: "1.2.3",
      packages: { "": { version: "1.2.3" } },
    }),
  );
  f.git("commit", "--allow-empty", "-m", "new head");
  await assert.rejects(validate(f.root, f.env), /must match/);
});
test("asset preparation requires all eight packages and stages no unrelated files", async (t) => {
  const f = await fixture(t);
  await prepare(f.root, f.env);
  const out = path.join(f.root, "dist/release");
  assert.equal((await fs.readdir(out)).length, 9);
  assert.equal(
    (await fs.readFile(path.join(out, "SHA256SUMS"), "utf8")).trim().split("\n")
      .length,
    8,
  );
  await fs.rm(path.join(f.root, "dist", assetPaths("1.2.3")[0]));
  await assert.rejects(prepare(f.root, f.env));
});
test("publisher verifies remote tag, uploads eight packages plus checksums, then publishes draft", async (t) => {
  const f = await fixture(t);
  await prepare(f.root, f.env);
  const s = server(f.env);
  s.ambiguous = true;
  assert.match(await publish(f.root, f.env, s.fetch), /releases\/tag\/v1.2.3$/);
  assert.equal(s.assets.length, 9);
  assert.equal(s.release.draft, false);
  assert.equal(s.calls.at(-1).method, "PATCH");
  s.release.body = "Maintainer notes";
  const posts = s.calls.filter((c) => c.method === "POST").length;
  await publish(f.root, f.env, s.fetch);
  assert.equal(s.calls.filter((c) => c.method === "POST").length, posts);
  assert.equal(s.release.body, "Maintainer notes");
});
test("publisher rejects a moved tag and tampered assets before creating a release", async (t) => {
  const f = await fixture(t);
  await prepare(f.root, f.env);
  const s = server(f.env);
  s.remoteSha = "0".repeat(40);
  await assert.rejects(publish(f.root, f.env, s.fetch), /Remote release tag/);
  assert.equal(s.release, null);
  await fs.appendFile(
    path.join(f.root, "dist/release", path.basename(assetPaths("1.2.3")[0])),
    "changed",
  );
  await assert.rejects(publish(f.root, f.env, s.fetch), /checksums/);
});
test("publisher never overwrites differing assets and leaves failed uploads draft", async (t) => {
  const f = await fixture(t);
  await prepare(f.root, f.env);
  const s = server(f.env);
  s.failUpload = true;
  await assert.rejects(publish(f.root, f.env, s.fetch), /HTTP 500/);
  assert.equal(s.release.draft, true);
  s.failUpload = false;
  await publish(f.root, f.env, s.fetch);
  s.assets[0].bytes = Buffer.from("different release bytes");
  await assert.rejects(publish(f.root, f.env, s.fetch), /Refusing to replace/);
  assert.ok(s.calls.every((c) => c.method !== "DELETE"));
});
