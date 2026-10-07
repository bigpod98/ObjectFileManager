const endpoint = process.env.S3_TEST_ENDPOINT;
if (!endpoint) throw new Error("S3_TEST_ENDPOINT is required.");
function assertServicesAlive() {
  for (const value of (process.env.S3_TEST_SERVICE_PIDS || "")
    .split(",")
    .filter(Boolean)) {
    const pid = Number(value);
    if (!Number.isSafeInteger(pid) || pid <= 0)
      throw new Error("Invalid test service PID.");
    try {
      process.kill(pid, 0);
    } catch {
      throw new Error(
        `Disposable storage service process ${pid} exited before readiness.`,
      );
    }
  }
}
async function waitFor(name, url, ready) {
  for (let attempt = 0; attempt < 60; attempt++) {
    assertServicesAlive();
    let readyResult = false;
    try {
      const result = await fetch(url, { signal: AbortSignal.timeout(2000) });
      await result.body?.cancel();
      readyResult = ready(result);
    } catch {}
    assertServicesAlive();
    if (readyResult) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`The disposable ${name} service did not become ready.`);
}
Promise.all([
  waitFor(
    "MinIO",
    `${endpoint.replace(/\/$/, "")}/minio/health/ready`,
    (r) => r.ok,
  ),
  ...(process.env.AZURITE_TEST_ENDPOINT
    ? [
        waitFor(
          "Azurite",
          process.env.AZURITE_TEST_ENDPOINT,
          (r) => r.status === 400 || r.status === 403,
        ),
      ]
    : []),
]).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
