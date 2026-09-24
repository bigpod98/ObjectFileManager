const { spawnSync } = require("node:child_process");

function docker(args, capture = false) {
  const result = spawnSync("docker", args, {
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`Docker ${args[0]} failed (${result.status}).`);
  return result.stdout?.trim();
}

// docker cp also works when the runner workspace is inside a job container
// and is not a path on the Docker daemon's host. No host bind mounts required.
function containerTask({
  image,
  command,
  platform,
  env = {},
  inputs = [],
  output,
}) {
  const args = ["create"];
  if (platform) args.push("--platform", platform);
  for (const [key, value] of Object.entries(env))
    args.push("-e", `${key}=${value}`);
  const id = docker([...args, image, ...command], true);
  try {
    for (const [source, destination] of inputs)
      docker(["cp", source, `${id}:${destination}`]);
    docker(["start", "--attach", id]);
    // docker start may exit successfully even if the container command failed.
    const code = docker(
      ["inspect", "--format", "{{.State.ExitCode}}", id],
      true,
    );
    if (code !== "0")
      throw new Error(`Package container exited with status ${code}.`);
    if (output) docker(["cp", `${id}:${output[0]}`, output[1]]);
  } finally {
    docker(["rm", "--force", id]);
  }
}
module.exports = { containerTask };
