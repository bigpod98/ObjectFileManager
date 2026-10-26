const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const exec = promisify(execFile);
const root = path.resolve(__dirname, "..");
const imagePin = /@sha256:[a-f0-9]{64}$/;

test("workflow actions and CI images require immutable references", async () => {
  const dir = path.join(root, ".github/workflows");
  for (const file of await fs.readdir(dir)) {
    if (!/\.ya?ml$/.test(file)) continue;
    const source = await fs.readFile(path.join(dir, file), "utf8");
    for (const [, action] of source.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)/gm)) {
      if (action.startsWith("./")) continue;
      if (action.startsWith("docker://")) assert.match(action, imagePin);
      else assert.match(action, /^[\w.-]+\/[\w./-]+@[a-f0-9]{40}$/, file);
    }
    for (const [, image] of source.matchAll(/^\s*image:\s*(\S+)/gm))
      assert.match(image, imagePin, file);
  }
  const release = await fs.readFile(path.join(dir, "release.yml"), "utf8");
  // Pin the downloads made by setup actions as well as the actions themselves.
  assert.match(release, /node-version: "\d+\.\d+\.\d+"/);
  assert.match(
    release,
    /uses: docker\/setup-buildx-action@[^\n]+\n\s*with:\n\s*version: v\d+\.\d+\.\d+\n\s*driver-opts: image=\S+@sha256:[a-f0-9]{64}\s*\n/,
  );
});

test("every external package builder base image is digest pinned", async () => {
  for (const format of ["deb", "rpm", "alpm"]) {
    const dir = path.join(root, "packaging", format);
    for (const file of await fs.readdir(dir)) {
      if (!file.startsWith("Dockerfile")) continue;
      const source = await fs.readFile(path.join(dir, file), "utf8");
      const stages = new Set(["scratch"]);
      for (const [, image, stage] of source.matchAll(
        /^FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/gim,
      )) {
        if (!stages.has(image))
          assert.match(image, imagePin, `${format}/${file}`);
        if (stage) stages.add(stage);
      }
    }
  }
});

test("Azurite's separate lockfile includes integrity for every resolved dependency", async () => {
  const dir = path.join(root, "scripts/ci/test-services");
  const manifest = JSON.parse(
    await fs.readFile(path.join(dir, "package.json")),
  );
  const lock = JSON.parse(
    await fs.readFile(path.join(dir, "package-lock.json")),
  );
  assert.equal(manifest.private, true);
  assert.deepEqual(lock.packages[""].dependencies, manifest.dependencies);
  assert.match(manifest.dependencies.azurite, /^\d+\.\d+\.\d+$/);
  assert.equal(
    lock.packages["node_modules/azurite"].version,
    manifest.dependencies.azurite,
  );
  assert.ok(Object.keys(lock.packages).length > 1);
  for (const [name, dependency] of Object.entries(lock.packages)) {
    if (!name) continue;
    assert.match(
      dependency.resolved,
      /^https:\/\/registry\.npmjs\.org\//,
      name,
    );
    assert.match(dependency.integrity, /^sha512-[A-Za-z0-9+/]+=*$/, name);
  }
});

for (const npmExit of [0, 7]) {
  test(`test-service installer uses the committed lockfile and propagates npm exit ${npmExit}`, async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ofm ci pins "));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const bin = path.join(dir, "bin");
    const services = path.join(dir, "service cache");
    await fs.mkdir(bin);
    await fs.mkdir(path.join(services, "azurite"), { recursive: true });
    await fs.writeFile(path.join(services, "azurite/package.json"), "stale");
    for (const cmd of ["go", "npm"]) {
      await fs.writeFile(
        path.join(bin, cmd),
        `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(process.env.FIXTURE_RECORD + '/${cmd}.json', JSON.stringify({ args: process.argv.slice(2), gobin: process.env.GOBIN, toolchain: process.env.GOTOOLCHAIN }));
process.exit(${cmd === "npm" ? npmExit : 0});
`,
        { mode: 0o755 },
      );
    }
    const result = await exec(
      "bash",
      [path.join(root, "scripts/ci/install-test-services.sh")],
      {
        cwd: dir,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          OBJECTFILEMANAGER_TEST_SERVICE_DIR: services,
          FIXTURE_RECORD: dir,
        },
      },
    ).then(
      () => 0,
      (error) => error.code,
    );
    assert.equal(result, npmExit);
    const npm = JSON.parse(await fs.readFile(path.join(dir, "npm.json")));
    assert.equal(npm.args[0], "ci");
    assert.equal(
      npm.args[npm.args.indexOf("--prefix") + 1],
      path.join(services, "azurite"),
    );
    assert.ok(npm.args.includes("--ignore-scripts"));
    for (const file of ["package.json", "package-lock.json"])
      assert.deepEqual(
        await fs.readFile(path.join(services, "azurite", file)),
        await fs.readFile(path.join(root, "scripts/ci/test-services", file)),
      );
    const go = JSON.parse(await fs.readFile(path.join(dir, "go.json")));
    assert.equal(go.gobin, path.join(services, "bin"));
    assert.match(go.toolchain, /^go\d+\.\d+\.\d+$/);
    assert.match(go.args[1], /^github\.com\/minio\/minio@[a-f0-9]{40}$/);
  });
}
