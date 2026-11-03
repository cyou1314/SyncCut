import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool } from "pg";
import { createTaskQueue } from "../src/task-queue.mjs";

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

async function migratedPool() {
  const schema = `synccut_queue_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`create schema "${schema}"`);
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema},public` });
  await applyMigrations(pool);
  return { pool, admin, schema };
}

test("task queue: idempotent enqueue, lease, heartbeat, succeed", { skip: !process.env.TEST_DATABASE_URL, timeout: 30000 }, async () => {
  const { pool, admin, schema } = await migratedPool();
  try {
    const tenant = (await pool.query("insert into tenants (display_name) values ('Q') returning id")).rows[0].id;
    const queue = createTaskQueue(pool, { workerId: "w1" });
    const first = await queue.enqueue({ tenantId: tenant, jobType: "full_sync", idempotencyKey: "k1" });
    const again = await queue.enqueue({ tenantId: tenant, jobType: "full_sync", idempotencyKey: "k1" });
    assert.equal(first.created, true);
    assert.equal(again.created, false);
    assert.equal(again.id, first.id);

    const job = await queue.leaseNext({ jobTypes: ["full_sync"] });
    assert.equal(job.id, first.id);
    assert.equal(job.status, "leased");
    assert.equal(job.attempts, 1);
    // A second worker cannot claim the leased job.
    const other = createTaskQueue(pool, { workerId: "w2" });
    assert.equal(await other.leaseNext({ jobTypes: ["full_sync"] }), null);

    await queue.begin(job.id);
    await queue.heartbeat(job.id);
    await queue.succeed(job.id, { imported: 2 });
    const row = (await pool.query("select status, result from sync_jobs where id = $1", [job.id])).rows[0];
    assert.equal(row.status, "succeeded");
    assert.equal(row.result.imported, 2);
  } finally {
    await pool.end();
    await admin.query(`drop schema "${schema}" cascade`);
    await admin.end();
  }
});

test("task queue: failure retries with backoff, expired leases are reaped", { skip: !process.env.TEST_DATABASE_URL, timeout: 30000 }, async () => {
  const { pool, admin, schema } = await migratedPool();
  try {
    const tenant = (await pool.query("insert into tenants (display_name) values ('Q2') returning id")).rows[0].id;
    const queue = createTaskQueue(pool, { workerId: "w1" });
    const { id } = await queue.enqueue({ tenantId: tenant, jobType: "full_sync", idempotencyKey: "k2", maxAttempts: 2 });
    const job = await queue.leaseNext({ jobTypes: ["full_sync"] });
    await queue.begin(job.id);
    const retry = await queue.fail(job.id, new Error("boom"), { baseBackoffSeconds: 1 });
    assert.equal(retry.retried, true);
    let row = (await pool.query("select status, attempts from sync_jobs where id = $1", [id])).rows[0];
    assert.equal(row.status, "queued");

    // Make it due and leased again, then let the lease expire.
    await pool.query("update sync_jobs set next_attempt_at = now() - interval '1 second' where id = $1", [id]);
    const job2 = await queue.leaseNext({ jobTypes: ["full_sync"] });
    assert.equal(job2.attempts, 2);
    await pool.query("update sync_jobs set lease_expires_at = now() - interval '1 second' where id = $1", [id]);
    const reaped = await queue.reapExpired();
    assert.equal(reaped.failed, 1);
    row = (await pool.query("select status from sync_jobs where id = $1", [id])).rows[0];
    assert.equal(row.status, "failed");
  } finally {
    await pool.end();
    await admin.query(`drop schema "${schema}" cascade`);
    await admin.end();
  }
});

test("task queue fences an expired worker from beginning, heartbeating, failing or completing", { skip: !process.env.TEST_DATABASE_URL, timeout: 30000 }, async () => {
  const { pool, admin, schema } = await migratedPool();
  try {
    const tenant = (await pool.query("insert into tenants (display_name) values ('Fence') returning id")).rows[0].id;
    const stale = createTaskQueue(pool, { workerId: "stale-worker" });
    const current = createTaskQueue(pool, { workerId: "current-worker" });
    const { id } = await stale.enqueue({ tenantId: tenant, jobType: "full_sync", idempotencyKey: "fence-1" });
    const leased = await stale.leaseNext({ jobTypes: ["full_sync"], leaseSeconds: 2 });
    assert.equal(leased.id, id);
    await stale.begin(id, { leaseSeconds: 2 });
    await pool.query("update sync_jobs set lease_expires_at = now() - interval '1 second' where id = $1", [id]);
    await assert.rejects(stale.heartbeat(id), /lease lost or expired/i);
    await assert.rejects(stale.succeed(id, { stale: true }), /lease lost or expired/i);
    await assert.rejects(stale.fail(id, new Error("stale failure")), /lease lost or expired/i);
    await stale.reapExpired();
    const replacement = await current.leaseNext({ jobTypes: ["full_sync"] });
    assert.equal(replacement.id, id);
    await assert.rejects(stale.begin(id), /lease lost or expired/i);
    await current.begin(id);
    await current.succeed(id, { current: true });
    const row = (await pool.query("select status, result from sync_jobs where id = $1", [id])).rows[0];
    assert.equal(row.status, "succeeded");
    assert.equal(row.result.current, true);
  } finally {
    await pool.end();
    await admin.query(`drop schema "${schema}" cascade`);
    await admin.end();
  }
});
