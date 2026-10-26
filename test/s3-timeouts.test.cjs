const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { Readable, PassThrough } = require("node:stream");
const { setTimeout: delay } = require("node:timers/promises");
const {
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
} = require("@aws-sdk/client-s3");
const { client } = require("../src/storage.cjs");

// Exercise the actual SDK handler and retry middleware against loopback HTTP.
// Only shorten its public timeout settings; do not replace timers or the handler.
async function fixture(t, respond, timeouts = {}) {
  const requests = [];
  const closed = [];
  const server = http.createServer((request, response) => {
    requests.push(request);
    // An aborted partial upload may emit a server-side HTTP parser error before
    // closing. We are checking transport closure, not expecting a valid EOF.
    closed.push(
      new Promise((resolve) => request.socket.once("close", resolve)),
    );
    respond(request, response, requests.length);
  });
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const s3 = client({
    endpoint: `http://127.0.0.1:${server.address().port}`,
    region: "us-east-1",
    pathStyle: true,
    accessKeyId: "test-key",
    secretAccessKey: "test-secret",
  });
  t.after(() => s3.destroy());
  for (const [key, value] of Object.entries(timeouts))
    s3.config.requestHandler.updateHttpClientConfig(key, value);
  return { s3, requests, closed };
}

const head = () => new HeadObjectCommand({ Bucket: "bucket", Key: "object" });
const get = () => new GetObjectCommand({ Bucket: "bucket", Key: "object" });

test("S3 enforces finite connection, idle and request limits without reducing SDK attempts", async (t) => {
  const { s3 } = await fixture(t, (request, response) => response.end());
  await s3.send(head());
  const config = s3.config.requestHandler.httpHandlerConfigs();
  assert.equal(config.connectionTimeout, 15000);
  assert.equal(config.socketTimeout, 120000);
  assert.equal(config.requestTimeout, 24 * 60 * 60 * 1000);
  assert.equal(config.throwOnRequestTimeout, true);
  assert.equal(await s3.config.maxAttempts(), 5);
});

test(
  "S3 request duration destroys silent requests and exhausts five real SDK attempts",
  { timeout: 20000 },
  async (t) => {
    const { s3, requests, closed } = await fixture(t, () => {}, {
      connectionTimeout: 1000,
      requestTimeout: 80,
      socketTimeout: 1000,
    });
    await assert.rejects(s3.send(head()), (error) => {
      assert.equal(error.name, "TimeoutError");
      assert.equal(error.code, "ETIMEDOUT");
      assert.match(error.message, /80 ms requestTimeout/);
      assert.equal(error.$metadata.attempts, 5);
      return true;
    });
    assert.equal(requests.length, 5);
    await Promise.all(closed);
    assert.ok(requests.every((request) => request.socket.destroyed));
  },
);

test(
  "S3 idle timeout destroys a stalled attempt and SDK retry can succeed",
  { timeout: 10000 },
  async (t) => {
    const { s3, requests, closed } = await fixture(
      t,
      (request, response, attempt) => {
        if (attempt > 1) response.end();
      },
      { connectionTimeout: 1000, requestTimeout: 5000, socketTimeout: 100 },
    );
    const result = await s3.send(head());
    assert.equal(result.$metadata.attempts, 2);
    assert.equal(requests.length, 2);
    await closed[0];
    assert.equal(requests[0].socket.destroyed, true);
  },
);

test(
  "S3 duration limit stops response-header trickles that avoid the idle timeout",
  { timeout: 20000 },
  async (t) => {
    const { s3, requests, closed } = await fixture(
      t,
      (request, response) => {
        const socket = request.socket;
        socket.write("HTTP/1.1 200 OK\r\nX-Slow: ");
        const timer = setInterval(() => socket.write("a"), 40);
        socket.on("close", () => clearInterval(timer));
      },
      { requestTimeout: 250, socketTimeout: 1000 },
    );
    await assert.rejects(s3.send(head()), (error) => {
      assert.equal(error.name, "TimeoutError");
      assert.equal(error.code, "ETIMEDOUT");
      assert.match(error.message, /250 ms requestTimeout/);
      assert.equal(error.$metadata.attempts, 5);
      return true;
    });
    assert.equal(requests.length, 5);
    await Promise.all(closed);
  },
);

test(
  "S3 idle limit terminates a stalled streaming upload without replaying its source",
  { timeout: 10000 },
  async (t) => {
    const { s3, requests, closed } = await fixture(
      t,
      (request) => request.resume(),
      { requestTimeout: 5000, socketTimeout: 100 },
    );
    // The SDK warns that a consumed streaming request cannot be retried safely.
    const warning = t.mock.method(console, "warn", () => {});
    const body = new PassThrough();
    t.after(() => body.destroy());
    body.write("partial");
    await assert.rejects(
      s3.send(
        new PutObjectCommand({
          Bucket: "bucket",
          Key: "object",
          Body: body,
          ContentLength: 10,
        }),
      ),
      (error) => {
        assert.equal(error.name, "TimeoutError");
        assert.match(error.message, /100 ms of inactivity/);
        return true;
      },
    );
    assert.equal(requests.length, 1);
    assert.ok(
      warning.mock.calls.some((call) =>
        /non-retryable streaming request/.test(call.arguments[0]),
      ),
    );
    await Promise.all(closed);
  },
);

test(
  "S3 idle limit also terminates a download that stalls after response headers",
  { timeout: 10000 },
  async (t) => {
    const { s3, requests, closed } = await fixture(
      t,
      (request, response) => {
        response.writeHead(200, { "Content-Length": "10" });
        response.write("partial");
      },
      { requestTimeout: 5000, socketTimeout: 100 },
    );
    const result = await s3.send(get());
    await assert.rejects(result.Body.transformToString(), (error) => {
      assert.ok(
        error.code === "ECONNRESET" || error.name === "TimeoutError",
        `Unexpected stream error: ${error}`,
      );
      return true;
    });
    // The SDK has returned the stream; it must not silently replay a partial GET.
    assert.equal(result.$metadata.attempts, 1);
    assert.equal(requests.length, 1);
    await Promise.all(closed);
  },
);

test(
  "S3 permits an active throttled upload lasting several idle intervals",
  { timeout: 10000 },
  async (t) => {
    let received = "";
    const { s3 } = await fixture(
      t,
      (request, response) => {
        request.on("data", (chunk) => {
          received += chunk;
        });
        request.on("end", () => response.end());
      },
      { requestTimeout: 5000, socketTimeout: 200 },
    );
    const chunks = Array.from({ length: 12 }, () => "abcd");
    const body = Readable.from(
      (async function* () {
        for (const chunk of chunks) {
          // The queue's bandwidth limiter similarly delays each source chunk.
          await delay(60);
          yield Buffer.from(chunk);
        }
      })(),
    );
    t.after(() => body.destroy());
    const start = performance.now();
    const result = await s3.send(
      new PutObjectCommand({
        Bucket: "bucket",
        Key: "object",
        Body: body,
        ContentLength: chunks.join("").length,
      }),
    );
    assert.ok(performance.now() - start > 600);
    assert.equal(received, chunks.join(""));
    assert.equal(result.$metadata.attempts, 1);
  },
);

test(
  "S3 streaming downloads can outlive the header deadline while making progress",
  { timeout: 10000 },
  async (t) => {
    const chunks = Array.from({ length: 12 }, () => "abcd");
    const { s3 } = await fixture(
      t,
      (request, response) => {
        response.writeHead(200, {
          "Content-Length": String(chunks.join("").length),
        });
        response.flushHeaders();
        let index = 0;
        const timer = setInterval(() => {
          response.write(chunks[index++]);
          if (index === chunks.length) {
            clearInterval(timer);
            response.end();
          }
        }, 60);
        response.on("close", () => clearInterval(timer));
      },
      { requestTimeout: 200, socketTimeout: 200 },
    );
    const result = await s3.send(get());
    const start = performance.now();
    assert.equal(await result.Body.transformToString(), chunks.join(""));
    assert.ok(performance.now() - start > 600);
    assert.equal(result.$metadata.attempts, 1);
  },
);

test(
  "S3 cancellation closes an in-flight request without retrying",
  { timeout: 10000 },
  async (t) => {
    const accepted = Promise.withResolvers();
    const { s3, requests, closed } = await fixture(
      t,
      () => accepted.resolve(),
      { requestTimeout: 5000, socketTimeout: 5000 },
    );
    const controller = new AbortController();
    const sent = s3.send(head(), { abortSignal: controller.signal });
    const rejected = assert.rejects(sent, (error) => {
      assert.equal(error.name, "AbortError");
      assert.equal(error.$metadata.attempts, 1);
      return true;
    });
    await accepted.promise;
    controller.abort();
    await rejected;
    await Promise.all(closed);
    assert.equal(requests.length, 1);
  },
);

test(
  "S3 cancellation closes a response body after the SDK has returned it",
  { timeout: 10000 },
  async (t) => {
    const { s3, requests, closed } = await fixture(
      t,
      (request, response) => {
        response.writeHead(200, { "Content-Length": "10" });
        response.write("partial");
      },
      { requestTimeout: 5000, socketTimeout: 5000 },
    );
    const controller = new AbortController();
    const result = await s3.send(get(), { abortSignal: controller.signal });
    const rejected = assert.rejects(result.Body.transformToString());
    controller.abort();
    await rejected;
    await Promise.all(closed);
    assert.equal(requests.length, 1);
  },
);
