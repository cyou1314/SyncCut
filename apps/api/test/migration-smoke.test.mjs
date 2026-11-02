import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { createProvisioningJournal } from "../src/provisioning-journal.mjs";
import { createOAuthStateStore } from "../src/oauth-state-store.mjs";
import { createUserGrantStore } from "../src/user-grant-store.mjs";
import { createCredentialCipher } from "../src/credential-crypto.mjs";
import { randomBytes } from "node:crypto";
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

    await client.query(await readFile(new URL("../migrations/0003_attachment_extra.sql", import.meta.url), "utf8"));

    await client.query(await readFile(new URL("../migrations/0004_provisioning.sql", import.meta.url), "utf8"));

    await client.query(await readFile(new URL("../migrations/0005_user_credentials.sql", import.meta.url), "utf8"));

    await client.query(await readFile(new URL("../migrations/0006_oauth_states.sql", import.meta.url), "utf8"));

    const states = createOAuthStateStore({db:client,cipher:createCredentialCipher(randomBytes(32).toString("base64"))});
    await states.create({hash:"d".repeat(64),sessionId:"browser-one",verifier:"verifier",expiresAt:Date.now()+60000});
    assert.equal(await states.consume({hash:"d".repeat(64),sessionId:"browser-two",now:Date.now()}),null);
    assert.equal((await states.consume({hash:"d".repeat(64),sessionId:"browser-one",now:Date.now()})).verifier,"verifier");
    assert.equal(await states.consume({hash:"d".repeat(64),sessionId:"browser-one",now:Date.now()}),null);

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
    let clock = 1000000, refreshCalls = 0;
    const grants = createUserGrantStore({pool:storePool,cipher:createCredentialCipher(randomBytes(32).toString('base64')),clientId:'cli',clientSecret:'secret',now:()=>clock,fetchImpl:async()=>{refreshCalls++;return new Response(JSON.stringify({code:0,access_token:'new-access',refresh_token:'new-refresh',expires_in:3600}));}});
    await grants.saveGrant(tenantA,memberA,{accessToken:'old-access',refreshToken:'old-refresh',expiresIn:30});
    assert.equal(await grants.provider(tenantA,memberA)(),'new-access');
    assert.equal(await grants.provider(tenantA,memberA)(),'new-access');
    assert.equal(refreshCalls,1);
    await assert.rejects(grants.provider(tenantB,memberA)(), /authorization required/);
    await grants.revoke(tenantA,memberA);
    await assert.rejects(grants.provider(tenantA,memberA)(), /authorization required/);
    await grants.saveGrant(tenantA,memberA,{accessToken:'again',refreshToken:'again-refresh',expiresIn:3600});
    assert.equal(await grants.provider(tenantA,memberA)(),'again');
    clock += 4000000;
    const failingGrants = createUserGrantStore({pool:storePool,cipher:createCredentialCipher(randomBytes(32).toString('base64')),clientId:'cli',clientSecret:'secret',now:()=>clock});
    // A different cipher cannot decrypt a grant and cannot expose it across stores.
    await assert.rejects(failingGrants.provider(tenantA,memberA)());
    const journal = createProvisioningJournal(storePool);
    await journal.withLock(tenantA, async j => {
      await j.save({workspaceId:tenantA,creatorId:memberA,status:'running'});
      assert.equal((await j.load(tenantA)).status,'running');
      await assert.rejects(j.load(tenantB), /Workspace mismatch/);
    });
    await assert.rejects(journal.withLock(tenantB, j => j.save({workspaceId:tenantB,creatorId:memberA})), error => error.code === '23503');
    const store = createAssetStore(storePool, tenantA, connectionA);
    const asset = { recordId: 'rec1', name: 'rain', kind: 'sfx', project: null, episode: 'EP015', scene: null, shot: null, tags: [], notes: null, timing: {}, modified: null, attachment: {fileToken:'file1', name:'rain.wav', mimeType:'audio/wav', size:100} };
    await store.upsert({...asset,attachment:{...asset.attachment,extra:'old'}});
    await store.upsert({...asset,attachment:{...asset.attachment,extra:'new'}});
    assert.equal((await client.query('select download_extra from asset_versions')).rows[0].download_extra, 'new');
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
