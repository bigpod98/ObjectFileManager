const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { target, verifyExecutable } = require("../scripts/package-target.cjs");

test("packaging rejects an executable for the wrong architecture", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "s3-package-target-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "electron");
  const header = Buffer.alloc(20);
  header.write("7f454c460201", "hex");
  header.writeUInt16LE(183, 18);
  fs.writeFileSync(file, header);
  verifyExecutable(file, target(["--arm64"]));
  assert.throws(
    () => verifyExecutable(file, target(["--x64"])),
    /not Linux x64/,
  );
  fs.writeFileSync(file, "not an ELF executable");
  assert.throws(
    () => verifyExecutable(file, target(["--arm64"])),
    /not Linux arm64/,
  );
  assert.throws(() => target(["--armv7l"]), /Options/);
  assert.throws(() => target(["--x64", "--arm64"]), /one architecture/);
});
