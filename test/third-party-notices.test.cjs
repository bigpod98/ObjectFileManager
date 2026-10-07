const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { finished } = require("node:stream/promises");
const asar = require("@electron/asar");
const afterPack = require("../scripts/third-party-notices.cjs");
const { generate, inventory, verifyBundled, NOTICE_FILE } = afterPack;

const MIT_GRANT =
  "Copyright (c) 2020 Example Author\n\nPermission is hereby granted, free of charge, to any person.";

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
// A project whose lockfile lists production packages, one dev-only package,
// and whatever extra packages a test adds.
function project(t, packages = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "s3-notices-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const all = {
    "node_modules/alpha": { version: "1.0.0", files: { LICENSE: MIT_GRANT } },
    "node_modules/@scope/beta": {
      version: "2.0.0",
      files: { "LICENSE.md": "Beta license", NOTICE: "Beta notice" },
    },
    "node_modules/devtool": {
      version: "3.0.0",
      dev: true,
      files: { LICENSE: "Dev only" },
    },
    ...packages,
  };
  const lock = { packages: { "": { version: "0.0.0" } } };
  for (const [location, spec] of Object.entries(all)) {
    const name = location.split("node_modules/").pop();
    lock.packages[location] = { version: spec.version, dev: spec.dev };
    write(
      path.join(dir, location, "package.json"),
      JSON.stringify({
        name,
        version: spec.installed || spec.version,
        license: "MIT",
      }),
    );
    for (const [file, content] of Object.entries(spec.files || {}))
      write(path.join(dir, location, file), content);
  }
  write(path.join(dir, "package-lock.json"), JSON.stringify(lock));
  write(path.join(dir, "LICENSE"), "Project MIT license\n");
  return dir;
}

test("notices reproduce production licenses deterministically", (t) => {
  const dir = project(t);
  const notices = generate(dir);
  assert.equal(generate(dir), notices);
  assert.match(
    notices,
    /alpha 1\.0\.0[\s\S]*--- LICENSE ---\n\nCopyright \(c\) 2020/,
  );
  assert.match(notices, /--- LICENSE\.md ---\n\nBeta license/);
  assert.match(notices, /--- NOTICE ---\n\nBeta notice/);
  assert.doesNotMatch(notices, /devtool|Dev only/);
  assert.ok(notices.indexOf("@scope/beta") < notices.indexOf("alpha 1.0.0"));
});

test("packages without license files need a complete or reviewed source", (t) => {
  const bare = project(t, {
    "node_modules/bare": {
      version: "1.0.0",
      files: { "README.md": "# Bare\n\n## License\n\nMIT\n" },
    },
  });
  assert.throws(() => generate(bare), /bare 1\.0\.0 ships no license file/);

  const readme = project(t, {
    "node_modules/readme": {
      version: "1.0.0",
      files: {
        "README.md": `# Readme\n\n## License\n\n${MIT_GRANT}\n\n## Other\n\nUnrelated`,
      },
    },
  });
  const notices = generate(readme);
  assert.match(
    notices,
    /License section of the package README ---\n\nCopyright/,
  );
  assert.doesNotMatch(notices, /Unrelated/);

  const upstream =
    "Copyright (c) 2019 Upstream\n\nPermission is hereby granted.";
  write(path.join(bare, "packaging/licenses/upstream/bare.txt"), upstream);
  const entry = {
    file: "bare.txt",
    source: "https://example.invalid/bare/blob/abc/LICENSE",
    sha256: createHash("sha256").update(upstream).digest("hex"),
    note: "Fixture provenance.",
  };
  const manifest = path.join(bare, "packaging/licenses/upstream.json");
  write(manifest, JSON.stringify({ "bare@1.0.0": entry }));
  assert.match(
    generate(bare),
    /Source: https:\/\/example\.invalid\/bare\/blob\/abc\/LICENSE\nProvenance: Fixture provenance\.\n\nCopyright \(c\) 2019 Upstream/,
  );
  // A review applies to one exact version and file content.
  write(manifest, JSON.stringify({ "bare@0.9.0": entry }));
  assert.throws(() => generate(bare), /ships no license file/);
  write(
    manifest,
    JSON.stringify({ "bare@1.0.0": { ...entry, sha256: "0".repeat(64) } }),
  );
  assert.throws(() => generate(bare), /does not match its recorded SHA-256/);
});

test("notices reject an install that differs from the lockfile", (t) => {
  const dir = project(t, {
    "node_modules/drift": {
      version: "1.0.0",
      installed: "1.0.1",
      files: { LICENSE: "x" },
    },
  });
  assert.throws(
    () => inventory(dir),
    /drift is 1\.0\.1, but package-lock\.json requires 1\.0\.0/,
  );
  const missing = project(t);
  fs.rmSync(path.join(missing, "node_modules/alpha"), { recursive: true });
  assert.throws(() => inventory(missing), /not installed: node_modules\/alpha/);
});

test("afterPack writes licenses and rejects uncovered bundled packages", async (t) => {
  // delta is nested in the lockfile; electron-builder may hoist it in app.asar.
  const dir = project(t, {
    "node_modules/alpha/node_modules/delta": {
      version: "5.0.0",
      files: { LICENSE: "Delta license" },
    },
  });
  const out = path.join(dir, "out");
  const app = path.join(dir, "app");
  const archive = path.join(out, "resources/app.asar");
  const bundle = (location, manifest) =>
    write(path.join(app, location, "package.json"), JSON.stringify(manifest));
  write(path.join(app, "package.json"), "{}");
  bundle("node_modules/alpha", { name: "alpha", version: "1.0.0" });
  bundle("node_modules/alpha/dist", { type: "module" });
  bundle("node_modules/@scope/beta", { name: "@scope/beta", version: "2.0.0" });
  bundle("node_modules/delta", { name: "delta", version: "5.0.0" });
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  // asar 3 returns the output stream before its final writes have completed.
  await finished(await asar.createPackage(app, archive));
  await afterPack({
    appOutDir: out,
    electronPlatformName: "linux",
    packager: { projectDir: dir },
  });
  assert.equal(
    fs.readFileSync(path.join(out, "LICENSE"), "utf8"),
    "Project MIT license\n",
  );
  assert.equal(
    fs.readFileSync(path.join(out, NOTICE_FILE), "utf8"),
    generate(dir),
  );

  // Unknown packages, other versions and dev-only packages remain uncovered.
  bundle("node_modules/alpha/node_modules/gamma", {
    name: "gamma",
    version: "4.0.0",
  });
  bundle("node_modules/@scope/beta", { name: "@scope/beta", version: "2.0.1" });
  bundle("node_modules/devtool", { name: "devtool", version: "3.0.0" });
  await finished(await asar.createPackage(app, archive));
  assert.throws(
    () => verifyBundled(archive, inventory(dir)),
    (error) => {
      const missing = error.message.split(": ")[1].split(", ").sort();
      assert.deepEqual(missing, [
        "node_modules/@scope/beta (@scope/beta@2.0.1)",
        "node_modules/alpha/node_modules/gamma (gamma@4.0.0)",
        "node_modules/devtool (devtool@3.0.0)",
      ]);
      return true;
    },
  );
});

test("this project's installed production dependencies have complete notices", () => {
  const packages = inventory();
  const notices = generate();
  for (const p of packages)
    assert.ok(
      notices.includes(`\n${p.name} ${p.version}\nLicense: `),
      p.location,
    );
  const reviewed = require("../packaging/licenses/upstream.json");
  for (const key of Object.keys(reviewed))
    assert.ok(
      packages.some((p) => `${p.name}@${p.version}` === key),
      `${key} in upstream.json is no longer a bundled dependency`,
    );
});
