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
    GITHUB_REPOSITORY: "owner/project",
    GITHUB_TOKEN: "test-token",
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
    releases: [],
    calls: [],
    remoteSha: env.RELEASE_SHA,
    ambiguous: false,
    ambiguousUpload: false,
    failUpload: false,
    redirect: null,
  };
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status });
  const page = (rows, url) => {
    assert.equal(url.searchParams.get("per_page"), "100");
    assert.equal(url.searchParams.has("limit"), false);
    const offset = (Number(url.searchParams.get("page")) - 1) * 100;
    return rows.slice(offset, offset + 100);
  };
  state.fetch = async (url, options = {}) => {
    url = new URL(url);
    const method = options.method || "GET";
    state.calls.push({
      method,
      path: url.pathname,
      host: url.host,
      query: url.search,
    });
    if (url.host === "release-assets.githubusercontent.com") {
      assert.equal(options.headers.Authorization, undefined);
      assert.equal(options.redirect, "manual");
      return new Response(
        state.assets.find((a) => String(a.id) === url.pathname.slice(1)).bytes,
      );
    }
    assert.equal(options.headers.Authorization, `Bearer ${env.GITHUB_TOKEN}`);
    assert.equal(options.headers["X-GitHub-Api-Version"], "2026-03-10");
    const route = url.pathname.replace("/repos/owner/project", "");
    if (url.host === "uploads.github.com") {
      assert.equal(route, "/releases/7/assets");
      assert.equal(method, "POST");
      assert.equal(options.redirect, "error");
      assert.equal(options.headers["Content-Type"], "application/octet-stream");
      assert.ok(options.body instanceof Blob);
      assert.equal(
        Number(options.headers["Content-Length"]),
        options.body.size,
      );
      if (state.failUpload) return json({}, 500);
      const name = url.searchParams.get("name");
      const asset = {
        id: state.assets.length + 1,
        name,
        state: "uploaded",
        bytes: Buffer.from(await options.body.arrayBuffer()),
      };
      state.assets.push(asset);
      if (state.ambiguousUpload)
        throw new Error("Connection closed after upload");
      return json({ id: asset.id }, 201);
    }
    assert.equal(url.origin, "https://api.github.com");
    if (route.startsWith("/releases/assets/")) {
      assert.equal(options.headers.Accept, "application/octet-stream");
      assert.equal(options.redirect, "manual");
      const asset = state.assets.find(
        (a) => String(a.id) === route.split("/").at(-1),
      );
      if (state.redirect)
        return new Response(null, {
          status: 302,
          headers: { location: `${state.redirect}/${asset.id}` },
        });
      return new Response(asset.bytes);
    }
    assert.equal(options.redirect, "error");
    if (route === "/commits/tags%2Fv1.2.3")
      return json({ sha: state.remoteSha });
    if (route === "/releases" && method === "GET")
      return json(
        page(
          [...state.releases, ...(state.release ? [state.release] : [])],
          url,
        ),
      );
    if (route === "/releases" && method === "POST") {
      state.release = {
        ...JSON.parse(options.body),
        id: 7,
        html_url: "https://github.com/owner/project/releases/tag/v1.2.3",
        upload_url:
          "https://uploads.github.com/repos/owner/project/releases/7/assets{?name,label}",
      };
      if (state.ambiguous)
        throw new Error("Connection closed after creating release");
      return json(state.release, 201);
    }
    if (route === "/releases/7/assets" && method === "GET")
      return json(
        page(
          state.assets.map(({ bytes, ...asset }) => asset),
          url,
        ),
      );
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

test("publisher recovers drafts and ambiguous uploads across paginated releases", async (t) => {
  const f = await fixture(t);
  // The event may contain the annotated tag object, while the API commit is dereferenced.
  f.env.RELEASE_SHA = f.git("rev-parse", "refs/tags/v1.2.3");
  await prepare(f.root, f.env);
  const s = server(f.env);
  s.remoteSha = f.git("rev-parse", "HEAD");
  s.releases = Array.from({ length: 100 }, (_, i) => ({
    id: i + 100,
    tag_name: `old-${i}`,
  }));
  s.ambiguous = true;
  s.ambiguousUpload = true;
  await publish(f.root, f.env, s.fetch);
  assert.equal(s.release.draft, false);
  assert.equal(s.assets.length, 9);
  assert.equal(
    s.calls.filter((c) => c.method === "POST" && c.path.endsWith("/releases"))
      .length,
    1,
  );
  assert.ok(s.calls.some((c) => c.query === "?page=2&per_page=100"));
});
test("asset verification follows signed downloads without forwarding credentials", async (t) => {
  const f = await fixture(t);
  await prepare(f.root, f.env);
  const s = server(f.env);
  s.redirect = "https://release-assets.githubusercontent.com";
  await publish(f.root, f.env, s.fetch);
  assert.equal(
    s.calls.filter((c) => c.host === "release-assets.githubusercontent.com")
      .length,
    9,
  );
  s.redirect = "http://release-assets.githubusercontent.com";
  await assert.rejects(publish(f.root, f.env, s.fetch), /Unsafe.*redirect/);
});
test("publisher rejects upload URL changes and incomplete server-side assets", async (t) => {
  const f = await fixture(t);
  await prepare(f.root, f.env);
  const s = server(f.env);
  await publish(f.root, f.env, s.fetch);
  const uploadURL = s.release.upload_url;
  for (const url of [
    "https://uploads.example/assets",
    "https://uploads.github.com/repos/other/project/releases/7/assets",
  ]) {
    s.release.upload_url = url;
    await assert.rejects(
      publish(f.root, f.env, s.fetch),
      /Unexpected.*upload URL/,
    );
  }
  s.release.upload_url = uploadURL;
  s.assets[0].state = "starter";
  await assert.rejects(publish(f.root, f.env, s.fetch), /not fully uploaded/);
});
test("asset pagination detects a duplicate beyond the first page", async (t) => {
  const f = await fixture(t);
  await prepare(f.root, f.env);
  const s = server(f.env);
  await publish(f.root, f.env, s.fetch);
  const first = s.assets[0];
  for (let id = 10; id <= 100; id++)
    s.assets.push({ id, name: `unrelated-${id}`, state: "uploaded" });
  s.assets.push({ ...first, id: 101 });
  await assert.rejects(
    publish(f.root, f.env, s.fetch),
    /Duplicate release asset/,
  );
  assert.ok(
    s.calls.some(
      (c) => c.path.endsWith("/assets") && c.query === "?page=2&per_page=100",
    ),
  );
});

test("publisher refuses unrelated remote assets without deleting or replacing them", async (t) => {
  const f = await fixture(t);
  await prepare(f.root, f.env);
  const s = server(f.env);
  await publish(f.root, f.env, s.fetch);
  s.assets.push({ id: 20, name: "unexpected.zip", state: "uploaded" });
  const count = s.calls.length;
  await assert.rejects(
    publish(f.root, f.env, s.fetch),
    /Unexpected release asset/,
  );
  assert.ok(s.calls.slice(count).every((c) => c.method === "GET"));
});
test("publisher rejects missing GitHub configuration before network requests", async (t) => {
  const f = await fixture(t);
  const request = () => {
    throw new Error("Unexpected network request");
  };
  await assert.rejects(
    publish(f.root, { ...f.env, GITHUB_TOKEN: "" }, request),
    /contents:write/,
  );
  await assert.rejects(
    publish(
      f.root,
      { ...f.env, GITHUB_REPOSITORY: "https://github.com/owner/project" },
      request,
    ),
    /owner\/repository/,
  );
});
