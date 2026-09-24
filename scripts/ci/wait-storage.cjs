const endpoint = process.env.S3_TEST_ENDPOINT;
if (!endpoint) throw new Error("S3_TEST_ENDPOINT is required.");
(async () => {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const result = await fetch(
        `${endpoint.replace(/\/$/, "")}/minio/health/ready`,
        { signal: AbortSignal.timeout(2000) },
      );
      if (result.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("The disposable MinIO service did not become ready.");
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
