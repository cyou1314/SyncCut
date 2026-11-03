// Cloud sync worker: atomically hands webhook inbox batches to the durable job queue,
// processes full syncs, archives attachment bytes, and runs periodic compensation scans.
import { createHash } from "node:crypto";
import { runConnectionSync } from "./connection-sync.mjs";

const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function createSyncWorker({ pool, queue, objectStore, makeClient, compensationMinutes = 15, inboxBatchSize = 50, log = () => {} }) {
  if (!pool || !queue || !objectStore || !makeClient) throw new Error("pool, queue, objectStore and makeClient are required");

  async function loadConnection(tenantId, connectionId) {
    const result = await pool.query(
      `select * from feishu_connections where id = $1 and tenant_id = $2 and status = 'active'`,
      [connectionId, tenantId],
    );
    return result.rows[0] ?? null;
  }

  // Claim inbox rows and create the corresponding sync job in one DB transaction.
  // A process crash rolls the whole transaction back, so no event is stranded in processing.
  async function consumeInbox() {
    const due = await pool.query(
      `select distinct connection_id, tenant_id from feishu_event_inbox
        where status = 'queued' and next_attempt_at <= now()`,
    );
    let enqueued = 0;
    for (const { connection_id: connectionId, tenant_id: tenantId } of due.rows) {
      const db = await pool.connect();
      try {
        await db.query("begin");
        const claimed = await db.query(
          `select id from feishu_event_inbox
            where connection_id = $1 and tenant_id = $2 and status = 'queued' and next_attempt_at <= now()
            order by received_at asc, id asc
            for update skip locked
            limit $3`,
          [connectionId, tenantId, inboxBatchSize],
        );
        if (!claimed.rowCount) { await db.query("commit"); continue; }
        const ids = claimed.rows.map((row) => row.id);
        const idempotencyKey = `inbox:${connectionId}:${createHash("sha256").update(ids.join("\n")).digest("hex")}`;
        const job = await queue.enqueueWithClient(db, {
          tenantId,
          connectionId,
          jobType: "full_sync",
          idempotencyKey,
          payload: { source: "webhook", eventIds: ids },
        });
        await db.query(
          `update feishu_event_inbox
              set status = 'enqueued', attempts = attempts + 1, job_id = $2,
                  processed_at = now(), last_error = null
            where id = any($1::uuid[]) and tenant_id = $3 and status = 'queued'`,
          [ids, job.id, tenantId],
        );
        await db.query("commit");
        enqueued += 1;
      } catch (error) {
        await db.query("rollback").catch(() => {});
        log("inbox_consume_error", { connectionId, message: error.message });
      } finally {
        db.release();
      }
    }
    return { enqueued };
  }

  // Reconcile the rare crash window between a job state transition and inbox bookkeeping.
  async function reconcileInbox() {
    const completed = await pool.query(
      `update feishu_event_inbox e
          set status = 'completed', processed_at = coalesce(e.processed_at, now()), last_error = null
         from sync_jobs j
        where e.job_id = j.id and e.tenant_id = j.tenant_id
          and e.status = 'enqueued' and j.status in ('succeeded','completed')`,
    );
    const failed = await pool.query(
      `update feishu_event_inbox e
          set status = 'failed', last_error = coalesce(j.error_message, 'Sync job failed')
         from sync_jobs j
        where e.job_id = j.id and e.tenant_id = j.tenant_id
          and e.status = 'enqueued' and j.status in ('failed','cancelled')`,
    );
    return { completed: completed.rowCount, failed: failed.rowCount };
  }

  async function archiveAttachments(connection, client) {
    const pending = await pool.query(
      `select v.id, v.asset_id, v.version_number, v.file_token, v.original_filename, v.mime_type, v.download_extra
         from asset_versions v
         join media_assets a on a.id = v.asset_id and a.tenant_id = v.tenant_id
        where v.tenant_id = $1 and a.connection_id = $2 and v.storage_key is null
        order by v.created_at asc`,
      [connection.tenant_id, connection.id],
    );
    let archived = 0;
    for (const version of pending.rows) {
      const response = await client.downloadAttachment({ fileToken: version.file_token, extra: version.download_extra });
      const bytes = Buffer.from(await response.arrayBuffer());
      const digest = sha256Hex(bytes);
      const safeName = (version.original_filename ?? "audio").replace(/[\\/]/g, "_");
      const key = `tenants/${connection.tenant_id}/assets/${version.asset_id}/v${version.version_number}/${safeName}`;
      await objectStore.put(key, bytes, { contentType: version.mime_type ?? "application/octet-stream" });
      await pool.query(
        `update asset_versions set storage_key = $2, sha256 = $3, stored_at = now() where id = $1 and tenant_id = $4`,
        [version.id, key, digest, connection.tenant_id],
      );
      archived += 1;
    }
    return archived;
  }

  async function executeJob(job) {
    await queue.begin(job.id);
    const heartbeat = setInterval(() => { queue.heartbeat(job.id).catch((error) => log("job_heartbeat_error", { jobId: job.id, message: error.message })); }, 30000);
    heartbeat.unref?.();
    try {
      const connection = await loadConnection(job.tenant_id, job.connection_id);
      if (!connection) {
        await pool.query(
          `update feishu_event_inbox set status = 'failed', last_error = 'connection_inactive'
            where job_id = $1 and tenant_id = $2 and status = 'enqueued'`,
          [job.id, job.tenant_id],
        );
        await queue.succeed(job.id, { skipped: "connection_inactive" });
        return { skipped: true };
      }
      const client = makeClient(connection);
      const sync = await runConnectionSync({ pool, tenantId: job.tenant_id, connection, client });
      if (!sync.started) {
        // Do not discard the event: defer without consuming another retry attempt.
        await queue.defer(job.id, 5);
        return { deferred: true };
      }
      if (sync.failed) throw new Error("Connection sync failed; see feishu_sync_runs");
      const archived = await archiveAttachments(connection, client);
      const outcome = { runId: sync.runId, imported: sync.result.imported, duplicates: sync.result.duplicates, failedRecords: sync.result.failed, archived };
      await queue.succeed(job.id, outcome);
      await pool.query(
        `update feishu_event_inbox set status = 'completed', processed_at = now(), last_error = null
          where job_id = $1 and tenant_id = $2 and status = 'enqueued'`,
        [job.id, job.tenant_id],
      );
      return outcome;
    } catch (error) {
      const failure = await queue.fail(job.id, error);
      if (!failure.retried) {
        await pool.query(
          `update feishu_event_inbox set status = 'failed', last_error = $3
            where job_id = $1 and tenant_id = $2 and status = 'enqueued'`,
          [job.id, job.tenant_id, error.message],
        );
      }
      return { error: error.message };
    } finally {
      clearInterval(heartbeat);
    }
  }

  async function runJobs({ maxJobs = 5 } = {}) {
    let processed = 0;
    for (let i = 0; i < maxJobs; i += 1) {
      const job = await queue.leaseNext({ jobTypes: ["full_sync", "refresh_record"] });
      if (!job) break;
      await executeJob(job);
      processed += 1;
    }
    return { processed };
  }

  async function compensationPass(now = new Date()) {
    if (!compensationMinutes) return { enqueued: 0 };
    const bucketMs = compensationMinutes * 60 * 1000;
    const bucket = Math.floor(now.getTime() / bucketMs);
    const connections = await pool.query(`select id, tenant_id from feishu_connections where status = 'active'`);
    let enqueued = 0;
    for (const connection of connections.rows) {
      const result = await queue.enqueue({
        tenantId: connection.tenant_id,
        connectionId: connection.id,
        jobType: "full_sync",
        idempotencyKey: `compensate:${connection.id}:${bucket}`,
        payload: { source: "compensation" },
      });
      if (result.created) enqueued += 1;
    }
    return { enqueued };
  }

  async function tick() {
    const reaped = await queue.reapExpired();
    const inbox = await consumeInbox();
    const jobs = await runJobs();
    const reconciled = await reconcileInbox();
    return { reaped, inbox, jobs, reconciled };
  }

  return { tick, consumeInbox, runJobs, compensationPass, archiveAttachments, reconcileInbox };
}
