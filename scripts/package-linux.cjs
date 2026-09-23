const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const root = path.resolve(__dirname, "..");
process.chdir(root);
const version = require("../package.json").version;
if (!/^\d+\.\d+\.\d+$/.test(version))
  throw new Error(
    "Native packaging currently requires a stable major.minor.patch version.",
  );
if (process.platform !== "linux" || process.arch !== "x64")
  throw new Error("These package recipes currently target Linux x86_64 only.");
const requested = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const formats = requested.length ? requested : ["deb", "rpm", "alpm"];
if (formats.some((f) => !["deb", "rpm", "alpm"].includes(f)))
  throw new Error("Formats: deb rpm alpm");
function run(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${cmd} failed with status ${result.status}`);
}
if (!process.argv.includes("--skip-bundle"))
  run("npm", ["run", "pack", "--", "--linux", "--x64"]);
const bundle = path.join(root, "dist/linux-unpacked");
if (!fs.existsSync(path.join(bundle, "resources/app.asar")))
  throw new Error("Build the application first: npm run pack");
const work = path.join(root, "dist/native");
fs.mkdirSync(work, { recursive: true });
const input = fs.mkdtempSync(path.join(work, "input-"));
const payload = path.join(input, "payload");
const appDir = path.join(payload, "opt/s3-browser");
fs.mkdirSync(path.dirname(appDir), { recursive: true });
fs.cpSync(bundle, appDir, { recursive: true });
fs.chmodSync(path.join(appDir, "chrome-sandbox"), 0o4755);
function copy(source, target) {
  const dest = path.join(payload, target);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(source, dest);
  fs.chmodSync(dest, 0o644);
}
fs.mkdirSync(path.join(payload, "usr/bin"), { recursive: true });
fs.symlinkSync(
  "/opt/s3-browser/s3-browser",
  path.join(payload, "usr/bin/s3-browser"),
);
copy(
  "packaging/s3-browser.desktop",
  "usr/share/applications/com.tuxbase.s3browser.desktop",
);
copy(
  "assets/icon.png",
  "usr/share/icons/hicolor/512x512/apps/com.tuxbase.s3browser.png",
);
copy("README.md", "usr/share/doc/s3-browser/README.md");
copy(
  path.join(bundle, "LICENSE.electron.txt"),
  "usr/share/licenses/s3-browser/LICENSE.electron.txt",
);
copy(
  path.join(bundle, "LICENSES.chromium.html"),
  "usr/share/licenses/s3-browser/LICENSES.chromium.html",
);
fs.writeFileSync(
  path.join(payload, "usr/share/licenses/s3-browser/NOTICE"),
  "S3 Browser: no application redistribution license has been specified.\nBundled third-party components retain their respective licenses.\nSee the Electron and Chromium notices in this directory.\n",
);
copy(
  path.join(payload, "usr/share/licenses/s3-browser/NOTICE"),
  "usr/share/doc/s3-browser/copyright",
);
function render(source, target, extra = {}) {
  let content = fs
    .readFileSync(source, "utf8")
    .replaceAll("@VERSION@", version);
  for (const [key, value] of Object.entries(extra))
    content = content.replaceAll(`@${key}@`, value);
  fs.writeFileSync(path.join(input, target), content);
}
const size = spawnSync("du", ["-sk", payload], { encoding: "utf8" });
if (size.status) throw new Error("Could not calculate installed size");
render("packaging/deb/control.in", "control", {
  SIZE: size.stdout.split(/\s/)[0],
});
render("packaging/rpm/s3-browser.spec.in", "s3-browser.spec");
if (formats.includes("alpm")) {
  run("tar", [
    "-czf",
    path.join(input, "payload.tar.gz"),
    "-C",
    input,
    "payload",
  ]);
  const checksum = createHash("sha256")
    .update(fs.readFileSync(path.join(input, "payload.tar.gz")))
    .digest("hex");
  render("packaging/alpm/PKGBUILD.in", "PKGBUILD", { SHA256: checksum });
}
try {
  for (const format of formats) {
    const output = path.join(work, format);
    fs.mkdirSync(output, { recursive: true });
    run("docker", [
      "build",
      "-t",
      `s3browser-packaging-${format}`,
      "-f",
      `packaging/${format}/Dockerfile`,
      "packaging",
    ]);
    run("docker", [
      "run",
      "--rm",
      "-v",
      `${input}:/input:ro`,
      "-v",
      `${output}:/output`,
      "-v",
      `${root}/packaging:/recipes:ro`,
      `s3browser-packaging-${format}`,
      "bash",
      "/recipes/build-native.sh",
      format,
    ]);
  }
} finally {
  fs.rmSync(input, { recursive: true, force: true });
}
console.log("Native packages are in dist/native/{deb,rpm,alpm}.");
