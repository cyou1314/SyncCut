import test from "node:test";
import assert from "node:assert/strict";
import { createCustomAppTokenProvider } from "../src/feishu-auth.mjs";

test("custom-app token provider caches token using expires_in", async () => {
  let calls = 0;
  let now = 1_000_000;
  const provider = createCustomAppTokenProvider({
    clientId: "cli_test",
    clientSecret: "secret_test",
    now: () => now,
    fetchImpl: async (url, options) => {
      calls += 1;
      assert.equal(String(url), "https://accounts.feishu.cn/oauth/v3/token");
      const body = JSON.parse(options.body);
      assert.equal(body.grant_type, "client_credentials");
      assert.equal(body.client_id, "cli_test");
      return new Response(JSON.stringify({ code: 0, access_token: "token-test", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.equal(await provider(), "token-test");
  assert.equal(await provider(), "token-test");
  assert.equal(calls, 1);
  now += 3_550_000;
  assert.equal(await provider(), "token-test");
  assert.equal(calls, 2);
});

test("custom-app token provider does not expose provider response details", async () => {
  const provider = createCustomAppTokenProvider({
    clientId: "cli_test",
    clientSecret: "secret_test",
    fetchImpl: async () => new Response(JSON.stringify({ code: 20002, error_description: "secret detail" }), { status: 400 }),
  });
  await assert.rejects(provider(), /Unable to obtain Feishu tenant access token/);
});

test('simultaneous token requests share a single refresh', async () => {
  let calls=0;
  const provider=createCustomAppTokenProvider({clientId:'id',clientSecret:'secret',fetchImpl:async()=>{calls++; await new Promise(resolve=>setTimeout(resolve,5)); return new Response(JSON.stringify({code:0,access_token:'token',expires_in:3600}));}});
  assert.deepEqual(await Promise.all([provider(),provider(),provider()]),['token','token','token']);
  assert.equal(calls,1);
});
