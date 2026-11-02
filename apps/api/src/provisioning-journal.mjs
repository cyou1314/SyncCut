// Hold a PostgreSQL session advisory lock across external calls. Every save is
// committed independently before the next remote mutation, so crashes leave a
// durable pending marker rather than repeating a possibly successful request.
export function createProvisioningJournal(pool) {
  return {
    async withLock(workspaceId,fn) {
      const db=await pool.connect();
      let locked=false;
      try {
        await db.query('select pg_advisory_lock(hashtextextended($1, 0))',[`synccut-provision:${workspaceId}`]);locked=true;
        const scoped={
          async load(id) {
            if(id!==workspaceId) throw new Error('Workspace mismatch');
            const result=await db.query('select state from bitable_provisioning where tenant_id=$1',[id]);
            return result.rows[0]?.state ?? null;
          },
          async save(state) {
            if(state.workspaceId!==workspaceId) throw new Error('Workspace mismatch');
            const result=await db.query(`insert into bitable_provisioning (tenant_id,creator_member_id,state)
              values ($1,$2,$3::jsonb) on conflict (tenant_id) do update set state=excluded.state,updated_at=now()
              where bitable_provisioning.creator_member_id=excluded.creator_member_id returning tenant_id`,[workspaceId,state.creatorId,JSON.stringify(state)]);
            if(!result.rowCount) throw new Error('Provisioning owner mismatch');
          },
        };
        return await fn(scoped);
      } finally {
        if(locked) await db.query('select pg_advisory_unlock(hashtextextended($1, 0))',[`synccut-provision:${workspaceId}`]).catch(()=>{});
        db.release();
      }
    },
  };
}
