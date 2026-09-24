const targets = {
  x64: {
    electron: "x64",
    machine: 62,
    deb: "amd64",
    native: "x86_64",
    platform: "linux/amd64",
    bundle: "linux-unpacked",
  },
  arm64: {
    electron: "arm64",
    machine: 183,
    deb: "arm64",
    native: "aarch64",
    platform: "linux/arm64",
    bundle: "linux-arm64-unpacked",
  },
};
function target(args) {
  const options = args.filter((arg) => arg.startsWith("--"));
  if (
    options.some((arg) => !["--x64", "--arm64", "--skip-bundle"].includes(arg))
  )
    throw new Error("Options: --x64 or --arm64, --skip-bundle");
  const selected = options.filter((arg) => arg !== "--skip-bundle");
  if (selected.length > 1)
    throw new Error("Select one architecture per native packaging command.");
  const arch = selected[0]?.slice(2) || process.arch;
  if (!targets[arch]) throw new Error(`Unsupported architecture: ${arch}`);
  return targets[arch];
}
function verifyExecutable(file, arch) {
  const fs = require("node:fs");
  const header = Buffer.alloc(20);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, header, 0, header.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (
    header.subarray(0, 4).toString("hex") !== "7f454c46" ||
    header[4] !== 2 ||
    header[5] !== 1 ||
    header.readUInt16LE(18) !== arch.machine
  )
    throw new Error(`Executable is not Linux ${arch.electron}: ${file}`);
}
module.exports = { target, verifyExecutable };
