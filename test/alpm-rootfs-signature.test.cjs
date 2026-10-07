const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const recipes = path.join(__dirname, "../packaging/alpm");
const script = path.join(recipes, "verify-signature.sh");
const vendoredKey = path.join(recipes, "archlinuxarm-builder.asc");
const pinned = /verify-signature\.sh \S+ ([0-9A-F]{40}) /.exec(
  fs.readFileSync(path.join(recipes, "Dockerfile.arm64"), "utf8"),
)?.[1];
const tools = ["gpg", "gpgv", "gpgconf"].every(
  (tool) => spawnSync(tool, ["--version"]).status === 0,
);

function run(cmd, args, options = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", ...options });
}
function verify(key, fingerprint, file, signature) {
  return run("bash", [script, key, fingerprint, file, signature]);
}

test("the ARM rootfs is verified against the pinned upstream key", () => {
  assert.equal(pinned, "68B3537F39A313B3E574D06777193F152BDBE6A6");
  const dockerfile = fs.readFileSync(
    path.join(recipes, "Dockerfile.arm64"),
    "utf8",
  );
  // Extraction must be chained after verification of the downloaded file.
  assert.match(
    dockerfile,
    /verify-signature\.sh[^\n]*\/rootfs\.tar\.gz \/rootfs\.tar\.gz\.sig \\\n\s*&& mkdir \/rootfs \\\n\s*&& bsdtar -xpf \/rootfs\.tar\.gz/,
  );
});

test(
  "rootfs signature verification rejects tampering and other keys",
  { skip: !tools && "GnuPG is unavailable" },
  (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "s3-sig-"));
    const home = path.join(dir, "gnupg");
    fs.mkdirSync(home, { mode: 0o700 });
    t.after(() => {
      run("gpgconf", ["--homedir", home, "--kill", "all"]);
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const gpg = (...args) => {
      const result = run("gpg", [
        "--batch",
        "--homedir",
        home,
        "--passphrase",
        "",
        "--pinentry-mode",
        "loopback",
        ...args,
      ]);
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    };
    gpg(
      "--quick-gen-key",
      "Fixture signer <fixture@example.invalid>",
      "ed25519",
      "sign",
      "never",
    );
    const fingerprint = gpg("--with-colons", "--fingerprint")
      .split("\n")
      .find((line) => line.startsWith("fpr:"))
      .split(":")[9];
    const key = path.join(dir, "fixture.asc");
    fs.writeFileSync(key, gpg("--armor", "--export", fingerprint));
    const file = path.join(dir, "rootfs.tar.gz");
    fs.writeFileSync(file, "fixture root filesystem");
    gpg("--detach-sign", "--output", `${file}.sig`, file);

    const ok = verify(key, fingerprint.toLowerCase(), file, `${file}.sig`);
    assert.equal(ok.status, 0, ok.stderr);

    fs.appendFileSync(file, "x");
    const tampered = verify(key, fingerprint, file, `${file}.sig`);
    assert.equal(tampered.status, 1);
    assert.match(tampered.stderr, /BAD signature|verification failed/);
    fs.writeFileSync(file, "fixture root filesystem");

    // A valid signature from another key fails against the vendored key.
    const foreign = verify(vendoredKey, pinned, file, `${file}.sig`);
    assert.equal(foreign.status, 1);
    assert.match(foreign.stderr, /verification failed/);
    // A substituted key file fails the independent fingerprint pin.
    const substituted = verify(key, pinned, file, `${file}.sig`);
    assert.equal(substituted.status, 1);
    assert.match(substituted.stderr, /Signing key mismatch/);
    assert.equal(
      verify(key, fingerprint, file, path.join(dir, "missing.sig")).status,
      1,
    );
  },
);
