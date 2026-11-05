// Private server administration only. Never expose this entrypoint as an HTTP API.
import { Pool } from 'pg';
import { createCustomAppTokenProvider } from './feishu-auth.mjs';
import { FeishuBitableClient } from './bitable-client.mjs';
import { inspectConnection, resolveMapping, fullSync } from './bitable-sync.mjs';
import { createAssetStore } from './asset-store.mjs';
import { createCredentialCipher } from './credential-crypto.mjs';
import { hashWebhookSecret } from './bitable-webhook.mjs';

const env = process.env;
const required = name => { if (!env[name]) throw new Error(`${name} is required`); return env[name]; };
const command = process.argv[2];
const pool = new Pool({connectionString: required('DATABASE_URL')});
try {
  const tenant = required('SYNC_TENANT_ID'), base = required('FEISHU_BASE_TOKEN');
  const table = env.FEISHU_TABLE_ID;
  const appId = required('FEISHU_APP_ID');
  const secret = required('FEISHU_APP_SECRET');
  const client = new FeishuBitableClient({getAccessToken:createCustomAppTokenProvider({clientId:appId,clientSecret:secret})});
  if (command === 'inspect') {
    const info = await inspectConnection(client,base,table);
    process.stdout.write(JSON.stringify(info,null,2)+'\n');
  } else if (command === 'sync') {
    if (!table) throw new Error('FEISHU_TABLE_ID is required');
    const mapping = JSON.parse(required('FEISHU_FIELD_MAPPING'));
    const info = await inspectConnection(client,base,table);
    resolveMapping(mapping,info.fields);
    const encrypted = createCredentialCipher(required('SYNC_CREDENTIAL_ENCRYPTION_KEY')).encrypt(secret);
    const webhook = required('SYNC_WEBHOOK_SECRET');
    if (webhook.length < 32) throw new Error('SYNC_WEBHOOK_SECRET must be at least 32 characters');
    const connection = await pool.query(`insert into feishu_connections
      (tenant_id,app_mode,token_mode,app_id,app_token,table_id,field_mapping,credential_ciphertext,credential_nonce,credential_tag,webhook_secret_hash)
      values ($1,'custom_app','tenant_access_token',$2,$3,$4,$5::jsonb,$6,$7,$8,$9)
      on conflict (tenant_id,app_token,table_id) do update set app_id=excluded.app_id,field_mapping=excluded.field_mapping,
        credential_ciphertext=excluded.credential_ciphertext,credential_nonce=excluded.credential_nonce,
        credential_tag=excluded.credential_tag,webhook_secret_hash=excluded.webhook_secret_hash,updated_at=now()
      where feishu_connections.status='active' returning id`,
      [tenant,appId,base,table,JSON.stringify(mapping),encrypted.ciphertext,encrypted.nonce,encrypted.tag,hashWebhookSecret(webhook)]);
    if (!connection.rowCount) throw new Error('Connection is not active');
    const id=connection.rows[0].id;
    const run=(await pool.query("insert into feishu_sync_runs (tenant_id,connection_id,status) values ($1,$2,'running') returning id",[tenant,id])).rows[0].id;
    try {
      const result=await fullSync({client,connection:{appToken:base,tableId:table,fieldMapping:mapping},store:createAssetStore(pool,tenant,id)});
      await pool.query('update feishu_sync_runs set status=$1, imported=$2, duplicates=$3, failed=$4, errors=$5::jsonb, finished_at=now() where id=$6 and tenant_id=$7', [result.failed?'partial':'completed',result.imported,result.duplicates,result.failed,JSON.stringify(result.errors),run,tenant]);
      if (!result.failed) await pool.query('update feishu_connections set last_full_sync_at=now() where id=$1 and tenant_id=$2',[id,tenant]);
      process.stdout.write(JSON.stringify({connectionId:id,runId:run,...result},null,2)+'\n');
      if (result.failed) process.exitCode=1;
    } catch (error) {
      await pool.query("update feishu_sync_runs set status='failed',errors=$1::jsonb,finished_at=now() where id=$2 and tenant_id=$3",[JSON.stringify([{reason:'Sync failed; inspect server configuration and Feishu access'}]),run,tenant]);
      throw error;
    }
  } else throw new Error('Use inspect or sync');
} catch (error) {
  // Do not print provider bodies, credentials or database errors.
  process.stderr.write(`Pilot command failed: ${error.name === 'FeishuApiError' ? `Feishu API code ${error.code ?? 'unknown'} (HTTP ${error.status ?? 'unknown'})` : 'check configuration or server logs'}\n`);
  process.exitCode=1;
} finally { await pool.end(); }
