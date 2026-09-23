const { spawnSync } = require("node:child_process");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const version = require("../package.json").version;
const formats =
  process.argv.length > 2 ? process.argv.slice(2) : ["deb", "rpm", "alpm"];
for (const format of formats) {
  if (!["deb", "rpm", "alpm"].includes(format))
    throw new Error("Formats: deb rpm alpm");
  const result = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "-e",
      `S3_PACKAGE_VERSION=${version}`,
      "-v",
      `${root}/dist/native/${format}:/packages:ro`,
      "-v",
      `${root}/packaging:/recipes:ro`,
      `s3browser-packaging-${format}`,
      "bash",
      "/recipes/validate-native.sh",
      format,
    ],
    { stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
