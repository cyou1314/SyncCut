import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool } from "pg";
import { createTaskQueue } from "../src/task-queue.mjs";
import { createSyncWorker } from "../src/sync-worker.mjs";

async function applyMigrations(pool) {
  const files = (await readdir(new URL("../migrations/", import.meta.url))).filter((f) => f.endsWith(".sql")).sort();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      for (const file of files) await pool.query(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
      return;
    } catch (error) {
      // Parallel test files race on `create extension if not exists pgcrypto`;
      // the loser gets a unique violation on pg_extension. Migrations are
      // idempotent, so a short backoff and one more pass is safe.
      if (error.code !== "23505" || attempt === 2) throw error;
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
  }
}

const fields = [
  { field_id: "f1", field_name: "名称" },
  { field_id: "f2", field_name: "类型" },
  { field_id: "f3", field_name: "附件" },
  { field_id: "f4", field_name: "集数" },
  { field_id: "f5", field_name: "开始" },
];
const mapping = { name: "f1", kind: "f2", attachment: "f3", episode: "f4", start: "f5" };
const audio = Buffer.from("fake-wav-bytes");
const record = {
  record_id: "rec1",
  fields: {
    名称: [{ text: "雨声" }],
    类型: "音效",
    附件: [{ file_token: "file1", name: "rain.wav", type: "audio/wav", size: audio.length }],
    集数: "EP015",
    开始: "1.5",
  },
};

test("worker folds a webhook event into a sync job and archives the attachment", { skip: !process.env.TEST_DATABASE_URL, timeout: 30000 }, async () => {
  const schema = `synccut_worker_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`create schema "${schema}"`);
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema},public` });
  try {
    await applyMigrations(pool);
    const tenant = (await pool.query("insert into tenants (display_name) values ('W') returning id")).rows[0].id;
    const member = (await pool.query("insert into tenant_members (tenant_id, feishu_user_id, role) values ($1, 'ou_1', 'owner') returning id", [tenant])).rows[0].id;
    const connection = (await pool.query(
      `insert into feishu_connections (tenant_id, app_mode, token_mode, app_id, app_token, table_id, field_mapping, webhook_secret_hash, connected_by_member_id)
       values ($1, 'custom_app', 'user_access_token', 'cli_test', 'base', 'tbl', $2::jsonb, $3, $4) returning id`,
      [tenant, JSON.stringify(mapping), "a".repeat(64), member],
    )).rows[0].id;
    await pool.query(
      `insert into feishu_event_inbox (tenant_id, connection_id, event_key, event_type, record_id, payload)
       values ($1, $2, $3, 'record.updated', 'rec1', '{}'::jsonb)`,
      [tenant, connection, "b".repeat(64)],
    );

    const objects = new Map();
    const objectStore = {
      async put(key, bytes) { objects.set(key, Buffer.from(bytes)); return { key }; },
      async head(key) { const value = objects.get(key); return value ? { key, size: value.length } : null; },
      async get(key) { return objects.get(key); },
    };
    const client = {
      getBase: async () => ({ app: { name: "Base" } }),
      listTables: async () => ({ items: [{ table_id: "tbl" }] }),
      listFields: async () => ({ items: fields }),
      listRecords: async () => ({ items: [record], has_more: false }),
      downloadAttachment: async () => new Response(audio),
    };
    const queue = createTaskQueue(pool, { workerId: "test-worker" });
    const worker = createSyncWorker({ pool, queue, objectStore, makeClient: () => client, compensationMinutes: 0 });

    const outcome = await worker.tick();
    assert.equal(outcome.inbox.enqueued, 1);
    assert.equal(outcome.jobs.processed, 1);

    const event = (await pool.query("select status from feishu_event_inbox where connection_id = $1", [connection])).rows[0];
    assert.equal(event.status, "completed");
    const job = (await pool.query("select status, result from sync_jobs where tenant_id = $1", [tenant])).rows[0];
    assert.equal(job.status, "succeeded");
    assert.equal(job.result.imported, 1);
    assert.equal(job.result.archived, 1);

    const version = (await pool.query("select storage_key, sha256 from asset_versions where tenant_id = $1", [tenant])).rows[0];
    assert.ok(version.storage_key.endsWith("/v1/rain.wav"));
    assert.equal(version.sha256, createHash("sha256").update(audio).digest("hex"));
    assert.ok(objects.get(version.storage_key).equals(audio));

    // A second tick finds nothing to redo.
    const again = await worker.tick();
    assert.equal(again.jobs.processed, 0);
    assert.equal((await pool.query("select count(*)::int as n from sync_jobs where tenant_id = $1", [tenant])).rows[0].n, 1);
  } finally {
    await pool.end();
    await admin.query(`drop schema "${schema}" cascade`);
    await admin.end();
  }
});

test("webhook inbox handoff is atomic: enqueue failure leaves events queued, success links the job", { skip: !process.env.TEST_DATABASE_URL, timeout: 30000 }, async () => {
  const schema = `synccut_inbox_atomic_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`create schema "${schema}"`);
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema},public` });
  try {
    await applyMigrations(pool);
    const tenant = (await pool.query("insert into tenants (display_name) values ('Inbox') returning id")).rows[0].id;
    const member = (await pool.query("insert into tenant_members (tenant_id, feishu_user_id, role) values ($1, 'ou_inbox', 'owner') returning id", [tenant])).rows[0].id;
    const connection = (await pool.query(
      `insert into feishu_connections (tenant_id,app_mode,token_mode,app_id,app_token,table_id,field_mapping,webhook_secret_hash,connected_by_member_id)
       values ($1,'custom_app','user_access_token','cli_inbox','base_inbox','tbl_inbox',$2::jsonb,$3,$4) returning id`,
      [tenant, JSON.stringify(mapping), "d".repeat(64), member],
    )).rows[0].id;
    await pool.query(
      `insert into feishu_event_inbox (tenant_id,connection_id,event_key,event_type,record_id,payload)
       values ($1,$2,$3,'record.updated','rec_atomic','{}'::jsonb)`,
      [tenant, connection, "e".repeat(64)],
    );
    const objectStore = { put: async () => ({ key: "unused" }) };
    const failingQueue = { enqueueWithClient: async () => { throw new Error("simulated enqueue failure"); } };
    const failingWorker = createSyncWorker({ pool, queue: failingQueue, objectStore, makeClient: () => ({}), compensationMinutes: 0 });
    const failedAttempt = await failingWorker.consumeInbox();
    assert.equal(failedAttempt.enqueued, 0);
    let event = (await pool.query("select id,status,job_id,attempts from feishu_event_inbox where connection_id=$1", [connection])).rows[0];
    assert.equal(event.status, "queued");
    assert.equal(event.job_id, null);
    assert.equal(event.attempts, 0);
    assert.equal((await pool.query("select count(*)::int as n from sync_jobs where tenant_id=$1", [tenant])).rows[0].n, 0);

    const realQueue = createTaskQueue(pool, { workerId: "inbox-worker" });
    const worker = createSyncWorker({ pool, queue: realQueue, objectStore, makeClient: () => ({}), compensationMinutes: 0 });
    const handedOff = await worker.consumeInbox();
    assert.equal(handedOff.enqueued, 1);
    event = (await pool.query("select id,status,job_id,attempts from feishu_event_inbox where connection_id=$1", [connection])).rows[0];
    assert.equal(event.status, "enqueued");
    assert.ok(event.job_id);
    assert.equal(event.attempts, 1);
    const job = (await pool.query("select id,payload,status from sync_jobs where tenant_id=$1", [tenant])).rows[0];
    assert.equal(job.id, event.job_id);
    assert.equal(job.status, "queued");
    assert.deepEqual(job.payload.eventIds, [event.id]);
  } finally {
    await pool.end();
    await admin.query(`drop schema "${schema}" cascade`);
    await admin.end();
  }
});
