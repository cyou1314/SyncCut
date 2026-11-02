import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { createAssetStore } from "../src/asset-store.mjs";

test("PostgreSQL migration creates tenant-scoped tables and rejects cross-tenant job links", {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
  const client = await pool.connect();
  const schema = `synccut_test_${randomUUID().replaceAll("-", "")}`;

  try {
    await client.query(`create schema "${schema}"`);
    await client.query(`set search_path to "${schema}", public`);

    const migration = await readFile(
      new URL("../migrations/0001_feishu_control_plane.sql", import.meta.url),
      "utf8",
    );
    await client.query(migration);
    await client.query(await readFile(new URL("../migrations/0002_full_sync.sql", import.meta.url), "utf8"));

    const tenantA = (await client.query(
      "insert into tenants (display_name) values ('Team A') returning id",
    )).rows[0].id;
    const tenantB = (await client.query(
      "insert into tenants (display_name) values ('Team B') returning id",
    )).rows[0].id;

    const memberA = (await client.query(
      "insert into tenant_members (tenant_id, feishu_user_id, role) values ($1, 'user_a', 'owner') returning id",
      [tenantA],
    )).rows[0].id;

    const connectionA = (await client.query(
      `insert into feishu_connections
        (tenant_id, app_mode, token_mode, app_id, app_token, table_id, webhook_secret_hash, connected_by_member_id)
       values ($1, 'custom_app', 'tenant_access_token', 'cli_a', 'base_a', 'table_a', $2, $3)
       returning id`,
      [tenantA, "a".repeat(64), memberA],
    )).rows[0].id;

    const storePool = { connect: async () => ({ query: client.query.bind(client), release() {} }) };
    const store = createAssetStore(storePool, tenantA, connectionA);
    const asset = { recordId: 'rec1', name: 'rain', kind: 'sfx', project: null, episode: 'EP015', scene: null, shot: null, tags: [], notes: null, timing: {}, modified: null, attachment: {fileToken:'file1', name:'rain.wav', mimeType:'audio/wav', size:100} };
    await store.upsert(asset);
    await store.upsert(asset);
    assert.equal((await client.query('select count(*)::int as n from asset_versions')).rows[0].n, 1);
    await store.upsert({...asset, attachment:{...asset.attachment,fileToken:'file2'}});
    assert.equal((await client.query('select count(*)::int as n from asset_versions')).rows[0].n, 2);
    await assert.rejects(createAssetStore(storePool, tenantB, connectionA).upsert(asset), /Connection unavailable/);

    const deviceA = (await client.query(
      "insert into sync_devices (tenant_id, device_name, device_token_hash) values ($1, 'Mac A', $2) returning id",
      [tenantA, "b".repeat(64)],
    )).rows[0].id;
    const deviceB = (await client.query(
      "insert into sync_devices (tenant_id, device_name, device_token_hash) values ($1, 'Mac B', $2) returning id",
      [tenantB, "c".repeat(64)],
    )).rows[0].id;

    await assert.rejects(
      client.query(
        `insert into sync_jobs (tenant_id, connection_id, device_id, job_type, idempotency_key)
         values ($1, $2, $3, 'import_media', 'cross-tenant-job')`,
        [tenantA, connectionA, deviceB],
      ),
      (error) => error.code === "23503",
    );

    await client.query(
      `insert into sync_jobs (tenant_id, connection_id, device_id, job_type, idempotency_key)
       values ($1, $2, $3, 'import_media', 'valid-job')`,
      [tenantA, connectionA, deviceA],
    );

    const count = await client.query(
      "select count(*)::int as total from sync_jobs where tenant_id = $1",
      [tenantA],
    );
    assert.equal(count.rows[0].total, 1);
  } finally {
    await client.query("reset search_path").catch(() => {});
    await client.query(`drop schema if exists "${schema}" cascade`).catch(() => {});
    client.release();
    await pool.end();
  }
});
