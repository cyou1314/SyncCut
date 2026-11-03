import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createConsoleRoutes } from "../src/console-routes.mjs";
import { newSessionId, sessionDigest } from "../src/console-auth.mjs";

test("Mac device pairing is one-time, tenant-scoped, and revocable", {
  skip: !process.env.TEST_DATABASE_URL,
  timeout: 30000,
}, async () => {
  const schema = `synccut_device_pairing_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`create schema "${schema}"`);
  const pool = new Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    options: `-c search_path=${schema},public`,
  });
  let server;
  try {
    for (const file of (await readdir(new URL("../migrations/", import.meta.url))).filter((f) => f.endsWith(".sql")).sort()) {
      await pool.query(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
    }
    const tenant = (await pool.query("insert into tenants (display_name) values ('Device Team') returning id")).rows[0].id;
    const member = (await pool.query(
      "insert into tenant_members (tenant_id,feishu_user_id,display_name,role) values ($1,'owner-1','Owner','owner') returning id",
      [tenant],
    )).rows[0].id;
    const session = newSessionId();
    await pool.query(
      "insert into console_sessions (session_hash,tenant_id,member_id,expires_at) values ($1,$2,$3,now()+interval '1 hour')",
      [sessionDigest(session), tenant, member],
    );
    const cookie = `synccut_session=${session}`;
    const origin = "http://127.0.0.1:8787";
    const route = createConsoleRoutes({
      pool,
      appId: "cli_device_test",
      appSecret: "test-secret",
      encryptionKey: randomBytes(32).toString("base64"),
      publicOrigin: origin,
    });
    server = createServer((req, res) => {
      route(req, res, new URL(req.url, origin)).catch(() => {
        if (!res.headersSent) { res.writeHead(500); res.end(); }
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const root = `http://127.0.0.1:${server.address().port}`;

    let response = await fetch(root + "/api/console/devices/pairing-code", {
      method: "POST", headers: { cookie, origin, "content-type": "application/json" }, body: "{}",
    });
    assert.equal(response.status, 201);
    const issued = await response.json();
    assert.match(issued.code, /^[A-F0-9]{16}$/);
    const storedCode = (await pool.query("select code_hash,expires_at from device_pairing_codes")).rows[0];
    assert.equal(storedCode.code_hash, createHash("sha256").update(issued.code).digest("hex"));
    assert.ok(new Date(storedCode.expires_at).getTime() > Date.now());

    response = await fetch(root + "/api/agent/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: issued.code,
        device_name: "Jay MacBook Pro",
        app_version: "0.3.0",
        macos_version: "15.1",
        jianying_version: "8.2.0",
      }),
    });
    assert.equal(response.status, 201);
    const paired = await response.json();
    assert.equal(paired.tenantId, tenant);
    assert.equal(paired.deviceName, "Jay MacBook Pro");
    assert.match(paired.deviceToken, /^[A-Za-z0-9_-]{43}$/);

    const storedDevice = (await pool.query(
      "select device_token_hash,status from sync_devices where id=$1 and tenant_id=$2",
      [paired.deviceId, tenant],
    )).rows[0];
    assert.equal(storedDevice.device_token_hash, createHash("sha256").update(paired.deviceToken).digest("hex"));
    assert.equal(storedDevice.status, "active");
    assert.notEqual(storedDevice.device_token_hash, paired.deviceToken);

    response = await fetch(root + "/api/agent/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: issued.code, device_name: "Second Mac" }),
    });
    assert.equal(response.status, 401);

    response = await fetch(root + "/api/agent/me", {
      headers: { authorization: `Bearer ${paired.deviceToken}` },
    });
    assert.equal(response.status, 200);
    const me = await response.json();
    assert.equal(me.deviceId, paired.deviceId);
    assert.equal(me.tenantId, tenant);
    assert.equal(me.deviceName, "Jay MacBook Pro");
    assert.equal(Object.hasOwn(me, "deviceToken"), false);

    response = await fetch(root + "/api/agent/heartbeat", {
      method: "POST",
      headers: { authorization: `Bearer ${paired.deviceToken}`, "content-type": "application/json" },
      body: JSON.stringify({ app_version: "0.3.1", macos_version: "15.2", jianying_version: "8.2.1" }),
    });
    assert.equal(response.status, 200);
    const heartbeat = (await pool.query("select app_version,macos_version,jianying_version,last_seen_at from sync_devices where id=$1", [paired.deviceId])).rows[0];
    assert.equal(heartbeat.app_version, "0.3.1");
    assert.equal(heartbeat.macos_version, "15.2");
    assert.equal(heartbeat.jianying_version, "8.2.1");
    assert.ok(heartbeat.last_seen_at);

    response = await fetch(root + "/api/console/devices", { headers: { cookie } });
    assert.equal(response.status, 200);
    const listed = await response.json();
    assert.equal(listed.devices.length, 1);
    assert.equal(listed.devices[0].id, paired.deviceId);
    assert.equal(Object.hasOwn(listed.devices[0], "device_token_hash"), false);

    response = await fetch(root + `/api/console/devices/${paired.deviceId}/revoke`, {
      method: "POST", headers: { cookie, origin, "content-type": "application/json" }, body: "{}",
    });
    assert.equal(response.status, 200);
    response = await fetch(root + "/api/agent/me", {
      headers: { authorization: `Bearer ${paired.deviceToken}` },
    });
    assert.equal(response.status, 401);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await pool.end();
    await admin.query(`drop schema "${schema}" cascade`);
    await admin.end();
  }
});
