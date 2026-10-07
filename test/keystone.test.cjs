const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { Readable } = require("node:stream");
const { ListBucketsCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
const { client } = require("../src/providers/swift.cjs");
const {
  tokenUrl,
  client: keystoneClient,
} = require("../src/providers/keystone.cjs");

async function fixture(t, options = {}) {
  const calls = { auth: [], storage: [] };
  let origin;
  const server = http.createServer(async (req, res) => {
    try {
      if (req.url === "/identity/v3/auth/tokens") {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        calls.auth.push(JSON.parse(Buffer.concat(chunks).toString()));
        if (options.auth) await options.auth(req, res, calls);
        if (res.writableEnded || res.destroyed) return;
        res.writeHead(201, { "x-subject-token": `token-${calls.auth.length}` });
        res.end(
          JSON.stringify({
            token: {
              expires_at: new Date(Date.now() + 3600000).toISOString(),
              project: { id: "project" },
              catalog: [
                {
                  type: "object-store",
                  endpoints: [
                    {
                      interface: "public",
                      region: "other",
                      url: `${origin}/v1/AUTH_wrong`,
                    },
                    {
                      interface: "public",
                      region: "RegionOne",
                      url: `${origin}/v1/AUTH_project`,
                    },
                  ],
                },
              ],
            },
          }),
        );
      } else {
        calls.storage.push({
          url: req.url,
          token: req.headers["x-auth-token"],
          method: req.method,
        });
        if (options.storage) await options.storage(req, res, calls);
        if (!res.writableEnded) res.end("[]");
      }
    } catch (error) {
      res.destroy(error);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  const profile = {
    provider: "OpenStack Swift",
    swiftAuth: "keystone",
    authUrl: `${origin}/identity/v3`,
    username: "user",
    password: " password ",
    projectName: "project",
    domainName: "Default",
    region: "RegionOne",
    ...options.profile,
  };
  const swift = client(profile);
  t.after(async () => {
    swift.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { swift, calls, origin };
}

test("Keystone accepts root, v3, and token URLs without duplicating path segments", () => {
  for (const path of [
    "/identity",
    "/identity/v3",
    "/identity/v3/",
    "/identity/v3/auth/tokens",
  ])
    assert.equal(
      tokenUrl(`https://example.test${path}`),
      "https://example.test/identity/v3/auth/tokens",
    );
  for (const value of [
    "file:///tmp/key",
    "https://user:secret@example.test",
    "https://example.test?secret=1",
    "https://example.test/#x",
    "invalid",
  ])
    assert.throws(() => tokenUrl(value), /Keystone URL/);
});

test("Keystone shares authentication, selects the region, and uses the existing Swift adapter", async (t) => {
  const { swift, calls } = await fixture(t);
  await Promise.all([
    swift.send(new ListBucketsCommand({})),
    swift.send(new ListBucketsCommand({})),
  ]);
  assert.equal(calls.auth.length, 1);
  assert.deepEqual(calls.auth[0].auth.identity.password.user, {
    name: "user",
    password: " password ",
    domain: { name: "Default" },
  });
  assert.deepEqual(calls.auth[0].auth.scope.project, {
    name: "project",
    domain: { name: "Default" },
  });
  assert.equal(calls.storage.length, 2);
  assert.ok(
    calls.storage.every(
      (call) =>
        call.url.startsWith("/v1/AUTH_project?") && call.token === "token-1",
    ),
  );
  assert.equal(swift.capabilities.conditionalDelete, false);
});

test("HTTPS Keystone rejects an HTTP catalog endpoint before any storage request", async (t) => {
  const { swift, calls, origin } = await fixture(t, {
    profile: { authUrl: "https://identity.example.test/v3" },
  });
  const fetch = t.mock.method(globalThis, "fetch", async (url) => {
    assert.equal(url, "https://identity.example.test/v3/auth/tokens");
    return new Response(
      JSON.stringify({
        token: {
          expires_at: new Date(Date.now() + 3600000).toISOString(),
          project: { id: "project" },
          catalog: [
            {
              type: "object-store",
              endpoints: [
                {
                  interface: "public",
                  region: "RegionOne",
                  url: `${origin}/v1/AUTH_project`,
                },
              ],
            },
          ],
        },
      }),
      { status: 201, headers: { "x-subject-token": "secret-token" } },
    );
  });
  await assert.rejects(swift.send(new ListBucketsCommand({})), (error) => {
    assert.match(error.message, /HTTPS.*HTTP Swift endpoint/);
    assert.ok(!error.message.includes("secret-token"));
    return true;
  });
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(calls.storage.length, 0);
});

test("Keystone permits HTTPS storage and explicitly configured HTTP deployments", async (t) => {
  for (const [authProtocol, storageProtocol] of [
    ["https", "https"],
    ["http", "http"],
    ["http", "https"],
  ]) {
    await t.test(
      `${authProtocol} authentication to ${storageProtocol} storage`,
      async (t) => {
        const endpoint = `${storageProtocol}://storage.example.test/v1/AUTH_project`;
        t.mock.method(
          globalThis,
          "fetch",
          async () =>
            new Response(
              JSON.stringify({
                token: {
                  expires_at: new Date(Date.now() + 3600000).toISOString(),
                  project: { id: "project" },
                  catalog: [
                    {
                      type: "object-store",
                      endpoints: [{ interface: "public", url: endpoint }],
                    },
                  ],
                },
              }),
              { status: 201, headers: { "x-subject-token": "token" } },
            ),
        );
        let created = 0;
        const swift = keystoneClient(
          { authUrl: `${authProtocol}://identity.example.test/v3` },
          (session) => {
            created++;
            assert.equal(session.endpoint, endpoint);
            assert.equal(session.swiftToken, "token");
            return { send: async () => ({ Buckets: [] }), destroy() {} };
          },
        );
        t.after(() => swift.destroy());
        assert.deepEqual(await swift.send(new ListBucketsCommand({})), {
          Buckets: [],
        });
        assert.equal(created, 1);
      },
    );
  }
});

test("Keystone refreshes expired tokens and retries an unauthorized read once", async (t) => {
  const { swift, calls } = await fixture(t, {
    storage(req, res) {
      if (req.headers["x-auth-token"] === "token-1") {
        res.writeHead(401);
        res.end();
      }
    },
  });
  await swift.send(new ListBucketsCommand({}));
  assert.equal(calls.auth.length, 2);
  const now = Date.now();
  t.mock.method(Date, "now", () => now + 3600000);
  await swift.send(new ListBucketsCommand({}));
  assert.equal(calls.auth.length, 3);
  assert.equal(calls.storage.at(-1).token, "token-3");
});

test("Keystone never falls back to a different region", async (t) => {
  const { swift, calls } = await fixture(t, { profile: { region: "missing" } });
  await assert.rejects(
    swift.send(new ListBucketsCommand({})),
    /selected region/,
  );
  assert.equal(calls.storage.length, 0);
});

test("Keystone cancellation does not cancel another caller's shared authentication", async (t) => {
  const started = Promise.withResolvers(),
    release = Promise.withResolvers();
  const { swift, calls } = await fixture(t, {
    async auth() {
      started.resolve();
      await release.promise;
    },
  });
  const controller = new AbortController();
  const aborted = assert.rejects(
    swift.send(new ListBucketsCommand({}), { abortSignal: controller.signal }),
    { name: "AbortError" },
  );
  const survivor = swift.send(new ListBucketsCommand({}));
  await started.promise;
  controller.abort();
  await aborted;
  release.resolve();
  await survivor;
  assert.equal(calls.auth.length, 1);
  assert.equal(calls.storage.length, 1);
});

test("Keystone does not replay a consumed upload after authorization failure", async (t) => {
  const { swift, calls } = await fixture(t, {
    async storage(req, res) {
      if (req.url === "/info") {
        res.end(JSON.stringify({ swift: { max_file_size: 1000 } }));
        return;
      }
      for await (const chunk of req) {
        void chunk;
      }
      res.writeHead(401);
      res.end();
    },
  });
  await assert.rejects(
    swift.upload({
      Bucket: "container",
      Key: "object",
      ContentLength: 3,
      Body: Readable.from(["abc"]),
    }),
    (error) => error.$metadata.httpStatusCode === 401,
  );
  assert.equal(calls.auth.length, 1);
  assert.equal(calls.storage.filter((call) => call.method === "PUT").length, 1);
});

test("Keystone closes pending authentication and rejects subsequent use", async (t) => {
  const started = Promise.withResolvers();
  const { swift } = await fixture(t, {
    async auth() {
      started.resolve();
      await new Promise(() => {});
    },
  });
  const pending = assert.rejects(swift.send(new ListBucketsCommand({})), {
    name: "AbortError",
  });
  await started.promise;
  swift.destroy();
  await pending;
  await assert.rejects(swift.send(new ListBucketsCommand({})), {
    name: "AbortError",
  });
});

test("Keystone refuses a changed account after token rejection", async (t) => {
  const { swift, calls } = await fixture(t, {
    auth(req, res, calls) {
      if (calls.auth.length < 2) return;
      res.writeHead(201, { "x-subject-token": "new-token" });
      res.end(
        JSON.stringify({
          token: {
            expires_at: new Date(Date.now() + 3600000).toISOString(),
            project: { id: "other-project" },
            catalog: [
              {
                type: "object-store",
                endpoints: [
                  {
                    interface: "public",
                    region: "RegionOne",
                    url: "https://other.example.com/v1/AUTH_other",
                  },
                ],
              },
            ],
          },
        }),
      );
    },
    storage(req, res) {
      res.writeHead(401);
      res.end();
    },
  });
  await assert.rejects(
    swift.send(new ListBucketsCommand({})),
    /different Swift account/,
  );
  assert.equal(calls.auth.length, 2);
  assert.equal(calls.storage.length, 1);
});

test("Keystone authentication failure closes upload bodies and never echoes secrets", async (t) => {
  const { swift, calls } = await fixture(t, {
    auth(req, res) {
      res.writeHead(401);
      res.end("password: supersecret");
    },
  });
  const stream = Readable.from(["abc"]);
  await assert.rejects(
    swift.send(
      new PutObjectCommand({ Bucket: "container", Key: "key", Body: stream }),
    ),
    (error) =>
      /HTTP 401/.test(error.message) && !error.message.includes("supersecret"),
  );
  assert.equal(stream.destroyed, true);
  assert.equal(calls.storage.length, 0);
});
