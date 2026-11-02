import test from "node:test";
import assert from "node:assert/strict";
import { FeishuBitableClient, FeishuApiError } from "../src/bitable-client.mjs";

test("Bitable client reads a record with a server-side bearer token", async () => {
  let requestedUrl = "";
  const client = new FeishuBitableClient({
    getAccessToken: async () => "fake-token",
    fetchImpl: async (url, options) => {
      requestedUrl = String(url);
      assert.equal(options.headers.Authorization, "Bearer fake-token");
      return new Response(JSON.stringify({ code: 0, data: { record: { record_id: "rec_1" } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const result = await client.getRecord({ appToken: "base_1", tableId: "table_1", recordId: "rec_1" });
  assert.equal(result.record.record_id, "rec_1");
  assert.match(requestedUrl, /\/bitable\/v1\/apps\/base_1\/tables\/table_1\/records\/rec_1$/);
});

test("Bitable attachment download preserves supplied extra permission data", async () => {
  let requestedUrl = "";
  const client = new FeishuBitableClient({
    getAccessToken: async () => "fake-token",
    fetchImpl: async (url) => {
      requestedUrl = String(url);
      return new Response("audio-bytes", { status: 200 });
    },
  });
  const response = await client.downloadAttachment({
    fileToken: "file_1",
    extra: { bitablePerm: { tableId: "table_1" } },
  });
  assert.equal(await response.text(), "audio-bytes");
  assert.match(requestedUrl, /file_1\/download/);
  assert.match(decodeURIComponent(requestedUrl), /"bitablePerm"/);
});

test("Bitable API error code is surfaced without leaking the response body", async () => {
  const client = new FeishuBitableClient({
    getAccessToken: async () => "fake-token",
    fetchImpl: async () => new Response(JSON.stringify({ code: 1254302, msg: "permission denied" }), { status: 403 }),
  });
  await assert.rejects(
    client.getRecord({ appToken: "base", tableId: "table", recordId: "rec" }),
    (error) => error instanceof FeishuApiError && error.code === 1254302,
  );
});
