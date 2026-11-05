import test from "node:test";
import assert from "node:assert/strict";
import { createObjectStore } from "../src/object-store.mjs";

test("object store signs requests with SigV4 and round-trips through fetch", async () => {
  const seen = [];
  const fetchImpl = async (url, opts) => {
    seen.push({ url, opts });
    if (opts.method === "PUT") return new Response("", { status: 200, headers: { etag: '"abc"' } });
    if (opts.method === "HEAD") return new Response(null, { status: 200, headers: { "content-length": "5", etag: '"abc"' } });
    if (opts.method === "GET") return new Response(Buffer.from("hello"), { status: 200 });
    throw new Error("unexpected method");
  };
  const store = createObjectStore({
    endpoint: "https://s3.example.test",
    bucket: "synccut-assets",
    accessKeyId: "AKID",
    secretAccessKey: "secret",
    fetchImpl,
  });
  const put = await store.put("tenants/t1/assets/a1/v1/track.wav", Buffer.from("hello"), { contentType: "audio/wav" });
  assert.equal(put.etag, '"abc"');
  const auth = seen[0].opts.headers.Authorization;
  assert.match(auth, /^AWS4-HMAC-SHA256 Credential=AKID\/\d{8}\/us-east-1\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[a-f0-9]{64}$/);
  assert.equal(seen[0].url, "https://s3.example.test/synccut-assets/tenants/t1/assets/a1/v1/track.wav");
  const head = await store.head("tenants/t1/assets/a1/v1/track.wav");
  assert.equal(head.size, 5);
  const got = await store.get("tenants/t1/assets/a1/v1/track.wav");
  assert.equal(got.toString(), "hello");
  const url = store.presignGet("tenants/t1/assets/a1/v1/track.wav", { ttlSeconds: 60 });
  assert.match(url, /^https:\/\/s3\.example\.test\/synccut-assets\/tenants\/t1\/assets\/a1\/v1\/track\.wav\?X-Amz-Algorithm=AWS4-HMAC-SHA256&/);
  assert.match(url, /X-Amz-Expires=60/);
  assert.match(url, /X-Amz-Signature=[a-f0-9]{64}$/);
});

test("object store reports missing keys and HTTP failures", async () => {
  const store = createObjectStore({
    endpoint: "https://s3.example.test",
    bucket: "b",
    accessKeyId: "AKID",
    secretAccessKey: "secret",
    fetchImpl: async () => new Response("nope", { status: 404 }),
  });
  assert.equal(await store.head("missing"), null);
  await assert.rejects(store.get("missing"), /404/);
  await assert.rejects(store.put("x", Buffer.from("y")), /404/);
});

test("object store rejects insecure remote endpoints, unsafe keys and excessive presign TTLs", () => {
  assert.throws(() => createObjectStore({
    endpoint: "http://storage.example.test",
    bucket: "b",
    accessKeyId: "AKID",
    secretAccessKey: "secret",
  }), /HTTPS/);
  const store = createObjectStore({
    endpoint: "https://s3.example.test",
    bucket: "b",
    accessKeyId: "AKID",
    secretAccessKey: "secret",
  });
  assert.throws(() => store.presignGet("../outside"), /Object key is invalid/);
  assert.throws(() => store.presignGet("audio.wav", { ttlSeconds: 604801 }), /ttlSeconds/);
  assert.throws(() => store.presignGet("audio.wav", { ttlSeconds: 0 }), /ttlSeconds/);
});
