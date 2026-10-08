const { containerTask } = require("./docker-task.cjs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const version = require("../package.json").version;
const { target } = require("./package-target.cjs");
const arch = target(process.argv.slice(2));
const requested = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const formats = requested.length ? requested : ["deb", "rpm", "alpm"];
for (const format of formats) {
  if (!["deb", "rpm", "alpm"].includes(format))
    throw new Error("Formats: deb rpm alpm");
  containerTask({
    image: `objectfilemanager-packaging-${format}-${arch.electron}`,
    platform: arch.platform,
    command: ["bash", "/recipes/validate-native.sh", format],
    env: {
      S3_PACKAGE_VERSION: version,
      S3_DEB_ARCH: arch.deb,
      S3_EMULATED: arch.electron !== process.arch ? "1" : "0",
      S3_NATIVE_ARCH: arch.native,
      S3_SMOKE_TIMEOUT: arch.electron === "arm64" ? "180" : "40",
    },
    inputs: [
      [path.join(root, "dist/native", format), "/packages"],
      [path.join(root, "packaging"), "/recipes"],
    ],
  });
}
