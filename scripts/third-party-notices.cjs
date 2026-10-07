// Generates the license notices for production dependencies bundled in
// app.asar. The Electron and Chromium notices ship separately with the runtime.
// Also used as electron-builder's afterPack hook.
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

const root = path.resolve(__dirname, "..");
const NOTICE_FILE = "THIRD_PARTY_NOTICES.txt";
const LICENSE_FILE = /^(licen[cs]e|copying|notice|copyright)([.-].*)?$/i;
// Reviewed upstream texts for exact package versions that ship no license file.
const UPSTREAM = "packaging/licenses/upstream.json";
const RULE = "=".repeat(78);

function text(file) {
  return fs.readFileSync(file, "utf8").replace(/\r\n?/g, "\n").trimEnd();
}
// A README license section counts only if it has both notice and grant.
function readmeLicense(dir) {
  const readme = fs
    .readdirSync(dir)
    .sort()
    .find((name) => /^readme(\.md|\.markdown|\.txt)?$/i.test(name));
  if (!readme) return "";
  const lines = text(path.join(dir, readme)).split("\n");
  const heading = (i) =>
    /^#{1,6}\s/.test(lines[i]) || /^(-{3,}|={3,})\s*$/.test(lines[i + 1] ?? "");
  const start = lines.findIndex(
    (line, i) =>
      heading(i) &&
      /^#*\s*licen[cs]e\b/i.test(line.trim().replace(/^#+\s*/, "")),
  );
  if (start < 0) return "";
  const body = [];
  for (
    let i = start + (/^#/.test(lines[start]) ? 1 : 2);
    i < lines.length;
    i++
  ) {
    if (heading(i)) break;
    body.push(lines[i]);
  }
  return body.join("\n").trim();
}

// Production packages come from the lockfile; their texts must be installed.
function inventory(projectRoot = root) {
  const lock = JSON.parse(
    fs.readFileSync(path.join(projectRoot, "package-lock.json"), "utf8"),
  );
  const packages = [];
  for (const [location, entry] of Object.entries(lock.packages || {})) {
    if (!location || entry.dev || entry.devOptional) continue;
    const dir = path.join(projectRoot, location);
    if (!fs.existsSync(path.join(dir, "package.json"))) {
      if (entry.optional) continue;
      throw new Error(
        `Production dependency is not installed: ${location}. Run npm ci.`,
      );
    }
    const manifest = JSON.parse(
      fs.readFileSync(path.join(dir, "package.json"), "utf8"),
    );
    if (manifest.version !== entry.version)
      throw new Error(
        `${location} is ${manifest.version}, but package-lock.json requires ${entry.version}. Run npm ci.`,
      );
    const files = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((file) => file.isFile() && LICENSE_FILE.test(file.name))
      .map((file) => file.name)
      .sort();
    const license =
      typeof manifest.license === "string"
        ? manifest.license
        : (manifest.licenses || [])
            .map((item) => item.type || item)
            .join(" OR ") || "UNKNOWN";
    packages.push({
      name: manifest.name,
      version: manifest.version,
      location,
      license,
      repository:
        typeof manifest.repository === "string"
          ? manifest.repository
          : manifest.repository?.url || "",
      texts: files.map((file) => ({
        file,
        text: text(path.join(dir, file)),
      })),
      readme: files.length ? "" : readmeLicense(dir),
    });
  }
  return packages.sort((a, b) =>
    a.location < b.location ? -1 : a.location > b.location ? 1 : 0,
  );
}

// Packages without a license file need a reviewed upstream text or a complete
// README license section; a generic template cannot supply their notices.
function externalLicense(p, projectRoot) {
  const manifest = path.join(projectRoot, UPSTREAM);
  const reviewed = fs.existsSync(manifest)
    ? JSON.parse(fs.readFileSync(manifest, "utf8"))[`${p.name}@${p.version}`]
    : null;
  if (reviewed) {
    const file = path.join(path.dirname(manifest), "upstream", reviewed.file);
    const bytes = fs.readFileSync(file);
    if (createHash("sha256").update(bytes).digest("hex") !== reviewed.sha256)
      throw new Error(`${file} does not match its recorded SHA-256.`);
    return [
      "--- Upstream license (not included in the npm package) ---",
      `Source: ${reviewed.source}`,
      `Provenance: ${reviewed.note}`,
      "",
      text(file),
    ];
  }
  if (
    /copyright/i.test(p.readme) &&
    /permission is hereby granted|licensed under/i.test(p.readme)
  )
    return ["--- License section of the package README ---", "", p.readme];
  throw new Error(
    `${p.location} ${p.version} ships no license file. Review its upstream license and record it in ${UPSTREAM}.`,
  );
}

function generate(projectRoot = root, packages = inventory(projectRoot)) {
  const out = [
    "S3 Browser third-party notices",
    "",
    "S3 Browser is licensed under the MIT License; see LICENSE. It bundles the",
    "following production dependencies inside resources/app.asar. Each remains",
    "under its own license, reproduced below from the installed package or,",
    "where the package omits it, from the recorded upstream source.",
    "",
    "The Electron runtime is covered by LICENSE.electron.txt. Chromium, Node.js",
    "and other runtime components are covered by LICENSES.chromium.html.",
    "",
    "Summary (package, version, declared license):",
    "",
    ...packages.map((p) => `  ${p.name} ${p.version} (${p.license})`),
  ];
  for (const p of packages) {
    out.push("", RULE, `${p.name} ${p.version}`, `License: ${p.license}`);
    if (p.repository) out.push(`Repository: ${p.repository}`);
    for (const { file, text: body } of p.texts)
      out.push("", `--- ${file} ---`, "", body);
    if (!p.texts.length) out.push("", ...externalLicense(p, projectRoot));
  }
  return out.join("\n") + "\n";
}

// Fails when the archive bundles a package that the notices do not cover.
// electron-builder hoists nested lockfile packages, so packages are matched by
// name and version rather than by installation path.
function verifyBundled(archive, packages) {
  const asar = require("@electron/asar");
  const covered = new Set(packages.map((p) => `${p.name}@${p.version}`));
  const missing = [];
  // asar caches headers by path; a rebuilt archive must be read afresh.
  asar.uncache(archive);
  for (const entry of asar.listPackage(archive)) {
    const file = entry.replaceAll("\\", "/").replace(/^\//, "");
    const match =
      /^(.*node_modules\/((?:@[^/]+\/)?[^/]+))\/package\.json$/.exec(file);
    if (!match) continue;
    const manifest = JSON.parse(asar.extractFile(archive, file).toString());
    const id = `${manifest.name || match[2]}@${manifest.version}`;
    if (!covered.has(id)) missing.push(`${match[1]} (${id})`);
  }
  if (missing.length)
    throw new Error(
      `Bundled packages missing from ${NOTICE_FILE}: ${missing.join(", ")}`,
    );
}

// Writes the application and dependency licenses beside the Electron notices.
async function afterPack(context) {
  const mac = context.electronPlatformName === "darwin";
  const dir = mac
    ? path.join(
        context.appOutDir,
        `${context.packager.appInfo.productFilename}.app`,
        "Contents/Resources",
      )
    : context.appOutDir;
  const projectRoot = context.packager?.projectDir || root;
  const packages = inventory(projectRoot);
  verifyBundled(
    path.join(dir, mac ? "app.asar" : "resources/app.asar"),
    packages,
  );
  fs.copyFileSync(path.join(projectRoot, "LICENSE"), path.join(dir, "LICENSE"));
  fs.writeFileSync(
    path.join(dir, NOTICE_FILE),
    generate(projectRoot, packages),
  );
}

module.exports = afterPack;
module.exports.default = afterPack;
module.exports.generate = generate;
module.exports.inventory = inventory;
module.exports.verifyBundled = verifyBundled;
module.exports.NOTICE_FILE = NOTICE_FILE;

if (require.main === module) {
  const target = process.argv[2];
  if (target) fs.writeFileSync(target, generate());
  else process.stdout.write(generate());
}
