const test = require("node:test");
const assert = require("node:assert/strict");
const { buckets, browse } = require("../src/storage.cjs");

test("bucket discovery follows all pages including empty pages with a token", async () => {
  const requests = [];
  const pages = [
    { Buckets: [{ Name: "first" }], ContinuationToken: "two" },
    { Buckets: [], ContinuationToken: "three" },
    { Buckets: [{ Name: "last" }] },
  ];
  const result = await buckets({
    async send(command) {
      assert.equal(command.constructor.name, "ListBucketsCommand");
      requests.push(command.input);
      return pages.shift();
    },
  });
  assert.deepEqual(result, ["first", "last"]);
  assert.deepEqual(requests, [
    { MaxBuckets: 1000, ContinuationToken: undefined },
    { MaxBuckets: 1000, ContinuationToken: "two" },
    { MaxBuckets: 1000, ContinuationToken: "three" },
  ]);
});

test("bucket discovery supports an empty or already aggregated adapter response", async () => {
  assert.deepEqual(await buckets({ send: async () => ({}) }), []);
  assert.deepEqual(
    await buckets({
      send: async () => ({ Buckets: [{ Name: "one" }, { Name: "two" }] }),
    }),
    ["one", "two"],
  );
});

test("bucket discovery rejects repeated or malformed tokens and later-page failures", async () => {
  let calls = 0;
  await assert.rejects(
    buckets({
      send: async () => {
        calls++;
        return { ContinuationToken: "loop" };
      },
    }),
    /invalid bucket pagination/,
  );
  assert.equal(calls, 2);
  await assert.rejects(
    buckets({ send: async () => ({ ContinuationToken: {} }) }),
    /pagination/,
  );
  calls = 0;
  await assert.rejects(
    buckets({
      send: async () => {
        if (calls++) throw new Error("Access denied on later page");
        return { Buckets: [{ Name: "incomplete" }], ContinuationToken: "next" };
      },
    }),
    /Access denied/,
  );
});

test("browse rejects out-of-prefix and malformed objects and common prefixes", async () => {
  for (const page of [
    { Contents: [{ Key: "other/file" }] },
    { CommonPrefixes: [{ Prefix: "other/" }] },
    { Contents: [{}] },
    { CommonPrefixes: [{}] },
    { Contents: [{ Key: 42 }] },
    { Contents: [{ Key: "" }] },
  ]) {
    await assert.rejects(
      browse({ send: async () => page }, "bucket", "folder/"),
      /outside the requested folder/,
    );
  }
});

test("browse preserves valid folder markers, root listings and pagination", async () => {
  const page = {
    CommonPrefixes: [{ Prefix: "folder/nested/" }],
    Contents: [
      { Key: "folder/", Size: 0 },
      { Key: "folder/file", Size: 5 },
    ],
    NextContinuationToken: "next",
  };
  const adapter = { send: async () => page };
  const listing = await browse(adapter, "bucket", "folder/");
  assert.deepEqual(listing.folders, ["folder/nested/"]);
  assert.deepEqual(
    listing.objects.map((o) => o.key),
    ["folder/file"],
  );
  assert.equal(listing.token, "next");
  assert.equal((await browse(adapter, "bucket")).objects.length, 2);
});
