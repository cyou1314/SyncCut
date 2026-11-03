// Persistent task queue on top of the existing sync_jobs table (M2.2).
// PostgreSQL is the queue: claiming uses FOR UPDATE SKIP LOCKED, every
// claim carries a lease, workers heartbeat while running, expired leases
// are reaped back to queued, and failures retry with backoff until
// max_attempts. Enqueue is idempotent on (tenant_id, idempotency_key).
import { randomUUID } from "node:crypto";

const CLAIMABLE = `status = 'queued' and next_attempt_at <= now()`;

export function createTaskQueue(pool, { workerId = `worker-${randomUUID()}` } = {}) {
  if (!pool) throw new Error("A database pool is required");

  async function enqueue({ tenantId, connectionId = null, deviceId = null, jobType, idempotencyKey, payload = {}, maxAttempts = 3 }) {
    if (!tenantId || !jobType || !idempotencyKey) throw new Error("tenantId, jobType and idempotencyKey are required");
    const result = await pool.query(
      `insert into sync_jobs (tenant_id, connection_id, device_id, job_type, idempotency_key, payload, max_attempts)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7)
       on conflict (tenant_id, idempotency_key) do nothing
       returning id, status`,
      [tenantId, connectionId, deviceId, jobType, idempotencyKey, JSON.stringify(payload), maxAttempts],
    );
    if (result.rows[0]) return { id: result.rows[0].id, status: result.rows[0].status, created: true };
    const existing = await pool.query(
      `select id, status from sync_jobs where tenant_id = $1 and idempotency_key = $2`,
      [tenantId, idempotencyKey],
    );
    return { id: existing.rows[0].id, status: existing.rows[0].status, created: false };
  }

  // Claim the oldest due job of the given types. The row moves
  // queued -> leased -> (the caller confirms) running via begin().
  async function leaseNext({ jobTypes, leaseSeconds = 120 }) {
    if (!Array.isArray(jobTypes) || !jobTypes.length) throw new Error("jobTypes are required");
    const db = await pool.connect();
    try {
      await db.query("begin");
      const picked = await db.query(
        `select * from sync_jobs
          where ${CLAIMABLE} and job_type = any($1::text[])
          order by created_at asc
          for update skip locked
          limit 1`,
        [jobTypes],
      );
      if (!picked.rows[0]) { await db.query("commit"); return null; }
      const job = picked.rows[0];
      const updated = await db.query(
        `update sync_jobs
            set status = 'leased', leased_by = $2,
                lease_expires_at = now() + make_interval(secs => $3),
                heartbeat_at = now(), attempts = attempts + 1,
                started_at = coalesce(started_at, now()), updated_at = now()
          where id = $1
          returning *`,
        [job.id, workerId, leaseSeconds],
      );
      await db.query("commit");
      return updated.rows[0];
    } catch (error) {
      await db.query("rollback").catch(() => {});
      throw error;
    } finally {
      db.release();
    }
  }

  async function assertLease(db, jobId) {
    const check = await db.query(
      `select id from sync_jobs where id = $1 and leased_by = $2 and status in ('leased','running')`,
      [jobId, workerId],
    );
    if (!check.rowCount) throw new Error("Job lease lost");
  }

  async function begin(jobId, { leaseSeconds = 120 } = {}) {
    const db = await pool.connect();
    try {
      await assertLease(db, jobId);
      const updated = await db.query(
        `update sync_jobs
            set status = 'running', heartbeat_at = now(),
                lease_expires_at = now() + make_interval(secs => $2), updated_at = now()
          where id = $1
          returning *`,
        [jobId, leaseSeconds],
      );
      return updated.rows[0];
    } finally { db.release(); }
  }

  async function heartbeat(jobId, { leaseSeconds = 120 } = {}) {
    const updated = await pool.query(
      `update sync_jobs
          set heartbeat_at = now(),
              lease_expires_at = now() + make_interval(secs => $2), updated_at = now()
        where id = $1 and leased_by = $3 and status in ('leased','running')
        returning id`,
      [jobId, leaseSeconds, workerId],
    );
    if (!updated.rowCount) throw new Error("Job lease lost");
  }

  async function succeed(jobId, result = {}) {
    const updated = await pool.query(
      `update sync_jobs
          set status = 'succeeded', result = $2::jsonb, error_message = null,
              finished_at = now(), leased_by = null, lease_expires_at = null, updated_at = now()
        where id = $1 and leased_by = $3
        returning id`,
      [jobId, JSON.stringify(result), workerId],
    );
    if (!updated.rowCount) throw new Error("Job lease lost");
  }

  // Retry with exponential backoff while attempts remain, else mark failed.
  async function fail(jobId, error, { baseBackoffSeconds = 30 } = {}) {
    const db = await pool.connect();
    try {
      const row = (await db.query(`select attempts, max_attempts from sync_jobs where id = $1 and leased_by = $2`, [jobId, workerId])).rows[0];
      if (!row) throw new Error("Job lease lost");
      const message = error instanceof Error ? error.message : String(error);
      if (row.attempts < row.max_attempts) {
        const backoff = baseBackoffSeconds * 2 ** (row.attempts - 1);
        await db.query(
          `update sync_jobs
              set status = 'queued', error_message = $2, leased_by = null, lease_expires_at = null,
                  next_attempt_at = now() + make_interval(secs => $3), updated_at = now()
            where id = $1`,
          [jobId, message, backoff],
        );
        return { retried: true, backoffSeconds: backoff };
      }
      await db.query(
        `update sync_jobs
            set status = 'failed', error_message = $2, finished_at = now(),
                leased_by = null, lease_expires_at = null, updated_at = now()
          where id = $1`,
        [jobId, message],
      );
      return { retried: false };
    } finally { db.release(); }
  }

  async function cancel(jobId) {
    const updated = await pool.query(
      `update sync_jobs
          set status = 'cancelled', finished_at = now(), leased_by = null, lease_expires_at = null, updated_at = now()
        where id = $1 and status in ('queued','leased')
        returning id`,
      [jobId],
    );
    return updated.rowCount > 0;
  }

  // Jobs whose worker died: lease expired while leased/running -> requeue
  // (or fail when attempts are exhausted).
  async function reapExpired() {
    const requeued = await pool.query(
      `update sync_jobs
          set status = 'queued', leased_by = null, lease_expires_at = null,
              next_attempt_at = now(), updated_at = now()
        where status in ('leased','running') and lease_expires_at < now() and attempts < max_attempts
        returning id`,
    );
    const failed = await pool.query(
      `update sync_jobs
          set status = 'failed', error_message = coalesce(error_message, 'Lease expired and attempts exhausted'),
              finished_at = now(), leased_by = null, lease_expires_at = null, updated_at = now()
        where status in ('leased','running') and lease_expires_at < now() and attempts >= max_attempts
        returning id`,
    );
    return { requeued: requeued.rowCount, failed: failed.rowCount };
  }

  return { workerId, enqueue, leaseNext, begin, heartbeat, succeed, fail, cancel, reapExpired };
}
