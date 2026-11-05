// Persistent PostgreSQL task queue with idempotent enqueue and fenced leases.
import { randomUUID } from "node:crypto";

const MAX_LEASE_SECONDS = 3600;
const MAX_BACKOFF_SECONDS = 3600;

function validateLeaseSeconds(value) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_LEASE_SECONDS) {
    throw new RangeError(`leaseSeconds must be an integer between 1 and ${MAX_LEASE_SECONDS}.`);
  }
}

async function enqueueWithClient(db, {
  tenantId, connectionId = null, deviceId = null, jobType,
  idempotencyKey, payload = {}, maxAttempts = 3,
}) {
  if (!tenantId || !jobType || !idempotencyKey) {
    throw new Error("tenantId, jobType and idempotencyKey are required");
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) {
    throw new RangeError("maxAttempts must be an integer between 1 and 20");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("payload must be a JSON object");
  }
  const result = await db.query(
    `insert into sync_jobs (tenant_id, connection_id, device_id, job_type, idempotency_key, payload, max_attempts)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7)
     on conflict (tenant_id, idempotency_key) do nothing
     returning id, status`,
    [tenantId, connectionId, deviceId, jobType, idempotencyKey, JSON.stringify(payload), maxAttempts],
  );
  if (result.rows[0]) return { id: result.rows[0].id, status: result.rows[0].status, created: true };
  const existing = await db.query(
    `select id, status, job_type, connection_id, device_id
       from sync_jobs where tenant_id = $1 and idempotency_key = $2`,
    [tenantId, idempotencyKey],
  );
  const row = existing.rows[0];
  if (!row) throw new Error("Idempotent job disappeared during enqueue.");
  if (row.job_type !== jobType || row.connection_id !== connectionId || row.device_id !== deviceId) {
    throw new Error("Idempotency key is already bound to a different job.");
  }
  return { id: row.id, status: row.status, created: false };
}

export function createTaskQueue(pool, { workerId = `worker-${randomUUID()}` } = {}) {
  if (!pool) throw new Error("A database pool is required");

  async function enqueue(args) {
    return enqueueWithClient(pool, args);
  }

  async function leaseNext({ jobTypes, tenantId = null, deviceId = null, leaseSeconds = 120 }) {
    if (!Array.isArray(jobTypes) || !jobTypes.length) throw new Error("jobTypes are required");
    validateLeaseSeconds(leaseSeconds);
    if (deviceId && !tenantId) throw new Error("tenantId is required when leasing for a device");
    const db = await pool.connect();
    try {
      await db.query("begin");
      const picked = await db.query(
        `select * from sync_jobs
          where status = 'queued' and next_attempt_at <= now() and job_type = any($1::text[])
            and ($2::uuid is null or tenant_id = $2)
            and ($3::uuid is null or device_id = $3)
          order by created_at asc
          for update skip locked
          limit 1`,
        [jobTypes, tenantId, deviceId],
      );
      if (!picked.rows[0]) { await db.query("commit"); return null; }
      const job = picked.rows[0];
      const updated = await db.query(
        `update sync_jobs
            set status = 'leased', leased_by = $2,
                lease_expires_at = now() + make_interval(secs => $3),
                heartbeat_at = now(), attempts = attempts + 1,
                started_at = coalesce(started_at, now()), updated_at = now()
          where id = $1 and status = 'queued'
          returning *`,
        [job.id, workerId, leaseSeconds],
      );
      if (!updated.rowCount) throw new Error("Job could not be leased after selection.");
      await db.query("commit");
      return updated.rows[0];
    } catch (error) {
      await db.query("rollback").catch(() => {});
      throw error;
    } finally {
      db.release();
    }
  }

  async function begin(jobId, { leaseSeconds = 120 } = {}) {
    validateLeaseSeconds(leaseSeconds);
    const updated = await pool.query(
      `update sync_jobs
          set status = 'running', heartbeat_at = now(),
              lease_expires_at = now() + make_interval(secs => $2), updated_at = now()
        where id = $1 and leased_by = $3 and status = 'leased' and lease_expires_at > now()
        returning * `,
      [jobId, leaseSeconds, workerId],
    );
    if (!updated.rowCount) throw new Error("Job lease lost or expired before execution.");
    return updated.rows[0];
  }

  async function heartbeat(jobId, { leaseSeconds = 120 } = {}) {
    validateLeaseSeconds(leaseSeconds);
    const updated = await pool.query(
      `update sync_jobs
          set heartbeat_at = now(),
              lease_expires_at = now() + make_interval(secs => $2), updated_at = now()
        where id = $1 and leased_by = $3 and status = 'running' and lease_expires_at > now()
        returning id`,
      [jobId, leaseSeconds, workerId],
    );
    if (!updated.rowCount) throw new Error("Job lease lost or expired.");
  }

  async function succeed(jobId, result = {}, { status = 'succeeded' } = {}) {
    if (!['succeeded','partial'].includes(status)) throw new Error("Completion status must be succeeded or partial.");
    const updated = await pool.query(
      `update sync_jobs
          set status = $4, result = $2::jsonb, error_message = null,
              finished_at = now(), leased_by = null, lease_expires_at = null, updated_at = now()
        where id = $1 and leased_by = $3 and status = 'running' and lease_expires_at > now()
        returning id`,
      [jobId, JSON.stringify(result), workerId, status],
    );
    if (!updated.rowCount) throw new Error("Job lease lost or expired before completion.");
  }

  async function defer(jobId, delaySeconds = 5) {
    if (!Number.isInteger(delaySeconds) || delaySeconds < 1 || delaySeconds > MAX_BACKOFF_SECONDS) {
      throw new RangeError(`delaySeconds must be between 1 and ${MAX_BACKOFF_SECONDS}.`);
    }
    const updated = await pool.query(
      `update sync_jobs
          set status = 'queued', leased_by = null, lease_expires_at = null,
              next_attempt_at = now() + make_interval(secs => $2), updated_at = now()
        where id = $1 and leased_by = $3 and status = 'running' and lease_expires_at > now()
        returning id`,
      [jobId, delaySeconds, workerId],
    );
    if (!updated.rowCount) throw new Error("Job lease lost or expired before deferral.");
    return { deferred: true, delaySeconds };
  }

  async function fail(jobId, error, { baseBackoffSeconds = 30 } = {}) {
    if (!Number.isInteger(baseBackoffSeconds) || baseBackoffSeconds < 1 || baseBackoffSeconds > MAX_BACKOFF_SECONDS) {
      throw new RangeError(`baseBackoffSeconds must be between 1 and ${MAX_BACKOFF_SECONDS}.`);
    }
    const db = await pool.connect();
    try {
      await db.query("begin");
      const row = (await db.query(
        `select attempts, max_attempts from sync_jobs
          where id = $1 and leased_by = $2 and status = 'running' and lease_expires_at > now()
          for update`,
        [jobId, workerId],
      )).rows[0];
      if (!row) throw new Error("Job lease lost or expired.");
      const message = error instanceof Error ? error.message : String(error);
      if (row.attempts < row.max_attempts) {
        const backoff = Math.min(baseBackoffSeconds * 2 ** (row.attempts - 1), MAX_BACKOFF_SECONDS);
        await db.query(
          `update sync_jobs
              set status = 'queued', error_message = $2, leased_by = null, lease_expires_at = null,
                  next_attempt_at = now() + make_interval(secs => $3), updated_at = now()
            where id = $1 and leased_by = $4 and status = 'running'`,
          [jobId, message, backoff, workerId],
        );
        await db.query("commit");
        return { retried: true, backoffSeconds: backoff };
      }
      await db.query(
        `update sync_jobs
            set status = 'failed', error_message = $2, finished_at = now(),
                leased_by = null, lease_expires_at = null, updated_at = now()
          where id = $1 and leased_by = $3 and status = 'running'`,
        [jobId, message, workerId],
      );
      await db.query("commit");
      return { retried: false };
    } catch (error) {
      await db.query("rollback").catch(() => {});
      throw error;
    } finally { db.release(); }
  }

  async function cancel(jobId) {
    const updated = await pool.query(
      `update sync_jobs
          set status = 'cancelled', finished_at = now(), updated_at = now()
        where id = $1 and status = 'queued'
        returning id`,
      [jobId],
    );
    return updated.rowCount > 0;
  }

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

  return { workerId, enqueue, enqueueWithClient, leaseNext, begin, heartbeat, succeed, defer, fail, cancel, reapExpired };
}
