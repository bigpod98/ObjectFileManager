const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const exec = promisify(execFile);

// This public key fixture is from https://download.docker.com/linux/debian/gpg.
// Exercise the installer with real checksum verification and isolated apt paths;
// only network calls and package installation are replaced.
test("Docker apt trust is installed only for the pinned key", async (t) => {
  const key = await fs.readFile(
    path.join(__dirname, "fixtures/docker-release.asc"),
  );
  for (const [name, bytes] of [
    ["upstream", key],
    ["substituted", Buffer.from("untrusted key")],
    ["modified", Buffer.concat([key, Buffer.from("extra key")])],
    ["empty", Buffer.alloc(0)],
  ]) {
    await t.test(name, async (t) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "ofm-docker-key-"));
      t.after(() => fs.rm(root, { recursive: true, force: true }));
      const bin = path.join(root, "bin");
      const apt = path.join(root, "apt");
      await fs.mkdir(bin);
      await fs.mkdir(path.join(apt, "sources.list.d"), { recursive: true });
      const input = path.join(root, "download.asc");
      const log = path.join(root, "apt.log");
      await fs.writeFile(input, bytes);
      for (const [cmd, body] of [
        ["curl", 'cp "$FIXTURE_KEY" "${@: -1}"'],
        ["apt-get", 'printf "%s\\n" "$*" >> "$FIXTURE_APT_LOG"'],
        ["docker", "exit 0"],
      ]) {
        await fs.writeFile(
          path.join(bin, cmd),
          `#!/usr/bin/env bash\n${body}\n`,
          { mode: 0o755 },
        );
      }
      const source = await fs.readFile(
        path.join(__dirname, "../scripts/ci/install-deps.sh"),
        "utf8",
      );
      const script = path.join(root, "install.sh");
      await fs.writeFile(script, source.replaceAll("/etc/apt", apt));
      const result = await exec("bash", [script, "packages"], {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          FIXTURE_KEY: input,
          FIXTURE_APT_LOG: log,
        },
      }).then(
        () => 0,
        (error) => error.code,
      );
      const packages = await fs.readFile(log, "utf8");
      const installed = path.join(apt, "keyrings/docker.asc");
      const repo = path.join(apt, "sources.list.d/docker.sources");
      if (name === "upstream") {
        assert.equal(result, 0);
        assert.deepEqual(await fs.readFile(installed), key);
        assert.match(
          await fs.readFile(repo, "utf8"),
          /Signed-By: .*\/keyrings\/docker.asc/,
        );
        assert.match(packages, /install .* docker-ce-cli/);
      } else {
        assert.notEqual(result, 0);
        await assert.rejects(fs.stat(installed), { code: "ENOENT" });
        await assert.rejects(fs.stat(repo), { code: "ENOENT" });
        assert.doesNotMatch(packages, /docker-ce-cli/);
      }
    });
  }
});
