// A store is bound to one already-authorized tenant and connection.
export function createAssetStore(pool, tenantId, connectionId) {
  if (!tenantId || !connectionId) throw new Error('Tenant and connection are required');
  return {
    async upsert(asset) {
      const db = await pool.connect();
      try {
        await db.query('begin');
        // Lock the connection to serialize concurrent version assignment.
        const owner = await db.query('select id from feishu_connections where id = $1 and tenant_id = $2 and status = $3 for update', [connectionId, tenantId, 'active']);
        if (!owner.rowCount) throw new Error('Connection unavailable');
        const row = await db.query(`insert into media_assets
          (tenant_id, connection_id, record_id, name, kind, project_name, episode_label, scene_name, shot_id, tags, notes, timeline_parameters, source_modified_at)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13)
          on conflict (connection_id, record_id) do update set name=excluded.name, kind=excluded.kind,
            project_name=excluded.project_name, episode_label=excluded.episode_label, scene_name=excluded.scene_name,
            shot_id=excluded.shot_id, tags=excluded.tags, notes=excluded.notes,
            timeline_parameters=excluded.timeline_parameters, source_modified_at=excluded.source_modified_at, updated_at=now()
          where media_assets.tenant_id = excluded.tenant_id returning id, current_version`,
          [tenantId, connectionId, asset.recordId, asset.name, asset.kind, asset.project, asset.episode, asset.scene, asset.shot, asset.tags, asset.notes, JSON.stringify(asset.timing),asset.modified]);
        if (!row.rowCount) throw new Error('Tenant mismatch');
        const {id, current_version: version} = row.rows[0];
        const prior = await db.query('select file_token, original_filename, mime_type, size_bytes from asset_versions where tenant_id=$1 and asset_id=$2 and version_number=$3', [tenantId,id,version]);
        const old = prior.rows[0], f = asset.attachment;
        if (!old || old.file_token !== f.fileToken || old.original_filename !== f.name || old.mime_type !== f.mimeType || (old.size_bytes == null ? null : Number(old.size_bytes)) !== f.size) {
          await db.query('insert into asset_versions (tenant_id, asset_id, version_number, file_token, original_filename, mime_type, size_bytes, source_modified_at) values ($1,$2,$3,$4,$5,$6,$7,$8)', [tenantId,id,version+1,f.fileToken,f.name,f.mimeType,f.size,asset.modified]);
          await db.query('update media_assets set current_version=$1 where id=$2 and tenant_id=$3', [version+1,id,tenantId]);
        }
        await db.query('commit');
      } catch (error) { await db.query('rollback'); throw error; }
      finally { db.release(); }
    },
  };
}
