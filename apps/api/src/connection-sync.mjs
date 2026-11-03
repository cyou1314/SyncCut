// Shared full-sync runner for one Feishu connection (M2.2 extraction).
// Used by the console "sync now" action and by the background worker so
// both paths share the same per-tenant advisory lock, the same
// feishu_sync_runs bookkeeping and the same failure recording. Never
// throws for sync failures: the run row records them, as the console path
// has always done.
import { fullSync } from "./bitable-sync.mjs";
import { createAssetStore } from "./asset-store.mjs";

export async function runConnectionSync({ pool, tenantId, connection, client }) {
  const db = await pool.connect();
  let locked = false;
  let run;
  try {
    locked = (await db.query("select pg_try_advisory_lock(hashtextextended($1,0)) as locked", [`synccut-sync:${tenantId}`])).rows[0].locked;
    if (!locked) return { started: false, reason: "locked" };
    run = (await db.query("insert into feishu_sync_runs (tenant_id,connection_id,status) values ($1,$2,'running') returning id", [tenantId, connection.id])).rows[0].id;
    const result = await fullSync({
      client,
      connection: { appToken: connection.app_token, tableId: connection.table_id, fieldMapping: connection.field_mapping },
      store: createAssetStore(pool, tenantId, connection.id),
      onProgress: async (p) => db.query("update feishu_sync_runs set imported=$1,duplicates=$2,failed=$3 where id=$4 and tenant_id=$5", [p.imported, p.duplicates, p.failed, run, tenantId]),
    });
    await db.query("update feishu_sync_runs set status=$1,imported=$2,duplicates=$3,failed=$4,errors=$5::jsonb,finished_at=now() where id=$6 and tenant_id=$7",
      [result.failed ? "partial" : "completed", result.imported, result.duplicates, result.failed, JSON.stringify(result.errors), run, tenantId]);
    return { started: true, runId: run, result };
  } catch {
    if (run) {
      await db.query("update feishu_sync_runs set status='failed',errors=$1::jsonb,finished_at=now() where id=$2 and tenant_id=$3",
        [JSON.stringify([{ reason: "同步中断，请检查连接后重试" }]), run, tenantId]).catch(() => {});
    }
    return { started: true, runId: run, failed: true };
  } finally {
    let broken = false;
    if (locked) await db.query("select pg_advisory_unlock(hashtextextended($1,0))", [`synccut-sync:${tenantId}`]).catch(() => { broken = true; });
    db.release(broken);
  }
}
