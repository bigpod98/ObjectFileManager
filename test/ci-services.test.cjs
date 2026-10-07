const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const exec = promisify(execFile);

for (const code of [0, 7]) {
  test(`disposable service runner cleans up after command exit ${code}`, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "s3browser-ci-test-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const fixture = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const args = process.argv.slice(2);
const minio = args.includes('--address');
const port = minio ? args[args.indexOf('--address') + 1].split(':')[1] : args[args.indexOf('--blobPort') + 1];
const data = minio ? args.at(-1) : args[args.indexOf('--location') + 1];
fs.writeFileSync(path.join(process.env.FIXTURE_RECORD_DIR, minio ? 'minio.json' : 'azurite.json'), JSON.stringify({ pid: process.pid, data }));
http.createServer((req, res) => { res.statusCode = minio ? 200 : 400; res.end(); }).listen(Number(port), '127.0.0.1');
`;
    for (const file of [
      "bin/minio",
      "azurite/node_modules/.bin/azurite-blob",
    ]) {
      const target = path.join(root, file);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, fixture, { mode: 0o755 });
    }
    const result = await exec(
      "bash",
      [
        "scripts/ci/with-test-services.sh",
        process.execPath,
        "-e",
        `const assert = require('node:assert/strict');
       assert.match(process.env.S3_TEST_ENDPOINT, /^http:\\/\\/127\\.0\\.0\\.1:/);
       assert.match(process.env.AZURITE_TEST_ENDPOINT, /\\/s3browsertest$/);
       assert.equal(process.env.AZURITE_INTEGRATION, '1');
       assert.equal(process.env.S3_TEST_ACCESS_KEY, 's3browser-test');
       assert.equal(process.env.S3_TEST_SECRET_KEY, 's3browser-test-secret');
       process.exit(${code});`,
      ],
      {
        env: {
          ...process.env,
          S3_TEST_ACCESS_KEY: "inherited-key",
          S3_TEST_SECRET_KEY: "inherited-secret",
          S3BROWSER_TEST_SERVICE_DIR: root,
          FIXTURE_RECORD_DIR: root,
        },
        timeout: 15000,
      },
    ).then(
      () => 0,
      (error) => error.code,
    );
    assert.equal(result, code);
    for (const file of ["minio.json", "azurite.json"]) {
      const record = JSON.parse(
        await fs.readFile(path.join(root, file), "utf8"),
      );
      assert.throws(() => process.kill(record.pid, 0), { code: "ESRCH" });
      await assert.rejects(fs.stat(path.dirname(record.data)), {
        code: "ENOENT",
      });
    }
  });
}

test("readiness rejects a dead owned process even when an unrelated endpoint is healthy", async (t) => {
  const http = require("node:http");
  const server = http.createServer((request, response) =>
    response.end("ready"),
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { stdout } = await exec(process.execPath, [
    "-e",
    "console.log(process.pid)",
  ]);
  await assert.rejects(
    exec(process.execPath, ["scripts/ci/wait-storage.cjs"], {
      env: {
        ...process.env,
        S3_TEST_ENDPOINT: `http://127.0.0.1:${server.address().port}`,
        AZURITE_TEST_ENDPOINT: "",
        S3_TEST_SERVICE_PIDS: stdout.trim(),
      },
      timeout: 5000,
    }),
    (error) => error.code === 1 && /exited before readiness/.test(error.stderr),
  );
});
