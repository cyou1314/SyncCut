import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { startUserAuthorization,completeUserAuthorization } from './feishu-oauth.mjs';
import { createOAuthStateStore } from './oauth-state-store.mjs';
import { createUserGrantStore } from './user-grant-store.mjs';
import { createProvisioningJournal } from './provisioning-journal.mjs';
import { createCredentialCipher } from './credential-crypto.mjs';
import { FeishuBitableClient } from './bitable-client.mjs';
import { provisionBitable } from './bitable-provisioner.mjs';
import { inspectConnection } from './bitable-sync.mjs';
import { runConnectionSync } from './connection-sync.mjs';
import { newSessionId,sessionDigest,sessionFromCookie,sessionCookie,requireSameOrigin,findSession,bindPersonalWorkspace } from './console-auth.mjs';

async function readJsonBody(request, maxBytes = 16 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('Request body too large.'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Request body must be valid JSON.'), { status: 400 }); }
}

function validOptionalText(value, maxLength) {
  return value == null ? null : (typeof value === 'string' && value.length <= maxLength ? value : undefined);
}

export function createConsoleRoutes({pool,appId,appSecret,encryptionKey,publicOrigin,appMode='custom_app',fetchImpl=fetch}) {
  if(!['custom_app','store_app'].includes(appMode)) throw new Error('Invalid FEISHU_APP_MODE');
  const origin=new URL(publicOrigin);
  if(origin.origin!==publicOrigin || (origin.protocol!=='https:' && !(origin.protocol==='http:' && ['localhost','127.0.0.1'].includes(origin.hostname)))) throw new Error('PUBLIC_ORIGIN must be an HTTPS origin or loopback HTTP origin');
  const cipher=createCredentialCipher(encryptionKey), states=createOAuthStateStore({db:pool,cipher}), grants=createUserGrantStore({pool,cipher,clientId:appId,clientSecret:appSecret,fetchImpl}), journal=createProvisioningJournal(pool);
  const redirectUri=`${publicOrigin}/auth/feishu/callback`;
  const secure=origin.protocol==='https:';
  const clientFor = actor => new FeishuBitableClient({getAccessToken:grants.provider(actor.tenant_id,actor.member_id),fetchImpl});
  const send=(res,status,body,headers={})=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff',...headers});res.end(JSON.stringify(body));};
  const redirect=(res,location,headers={})=>{res.writeHead(303,{'location':location,'cache-control':'no-store','referrer-policy':'no-referrer',...headers});res.end();};
  const tasks=new Set();
  const pairingAttempts=new Map();
  function allowPairingAttempt(req) {
    const key=req.socket?.remoteAddress ?? 'unknown';
    const now=Date.now();
    const entry=pairingAttempts.get(key) ?? { startedAt: now, count: 0 };
    if(now-entry.startedAt>=600000){entry.startedAt=now;entry.count=0;}
    entry.count+=1;
    pairingAttempts.set(key,entry);
    if(pairingAttempts.size>1000){
      for(const [ip,value] of pairingAttempts) if(now-value.startedAt>=600000) pairingAttempts.delete(ip);
    }
    return entry.count<=10;
  }
  async function authenticateDevice(req) {
    const header=req.headers.authorization;
    if(typeof header!=='string' || !header.startsWith('Bearer ')) return null;
    const token=header.slice(7).trim();
    if(!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const tokenHash=createHash('sha256').update(token,'utf8').digest('hex');
    const result=await pool.query(`select d.id,d.tenant_id,d.device_name,d.app_version,d.macos_version,d.jianying_version,d.status
      from sync_devices d join tenants t on t.id=d.tenant_id
      where d.device_token_hash=$1 and d.status='active' and t.status='active'`,[tokenHash]);
    const device=result.rows[0];
    if(!device) return null;
    await pool.query('update sync_devices set last_seen_at=now() where id=$1 and tenant_id=$2 and status=\'active\'',[device.id,device.tenant_id]);
    return device;
  }
  function startTask(key,work) {if(tasks.has(key))return false; tasks.add(key);void Promise.resolve().then(work).catch(()=>{}).finally(()=>tasks.delete(key));return true;}
  async function connection(actor) {
    const result=await pool.query("select * from feishu_connections where tenant_id=$1 and connected_by_member_id=$2 and token_mode='user_access_token' and status='active' order by created_at desc limit 1",[actor.tenant_id,actor.member_id]);return result.rows[0];
  }
  return async function route(req,res,url) {
    if(!url.pathname.startsWith('/api/console/') && !url.pathname.startsWith('/api/agent/') && !url.pathname.startsWith('/auth/feishu/')) return false;
    const sid=sessionFromCookie(req.headers.cookie), actor=await findSession(pool,sid);
    try {
      if(req.method==='POST' && url.pathname==='/api/console/login') {
        requireSameOrigin(req,publicOrigin);
        const fresh=newSessionId();
        await pool.query("insert into console_sessions (session_hash,expires_at) values ($1,now()+interval '10 minutes')",[sessionDigest(fresh)]);
        const location=await startUserAuthorization({stateStore:states,sessionId:fresh,clientId:appId,redirectUri,scopes:['bitable:app','offline_access']});
        return send(res,200,{authorizeUrl:location},{'Set-Cookie':sessionCookie(fresh,{secure,maxAge:600})}),true;
      }
      if(req.method==='GET' && url.pathname==='/auth/feishu/callback') {
        if(!sid || !actor || actor.member_id || url.searchParams.has('error')) return redirect(res,'/feishu.html?auth=failed'),true;
        const result=await completeUserAuthorization({stateStore:states,sessionId:sid,state:url.searchParams.get('state'),code:url.searchParams.get('code'),clientId:appId,clientSecret:appSecret,redirectUri,appMode,fetchImpl});
        const identity=await bindPersonalWorkspace(pool,{user:result.user,appId,sessionId:sid});
        await grants.saveGrant(identity.tenant_id,identity.member_id,result.tokens);
        return redirect(res,'/feishu.html?auth=ok',{'Set-Cookie':sessionCookie(identity.sessionId,{secure})}),true;
      }
      if(req.method==='POST' && url.pathname==='/api/agent/pair') {
        if(!allowPairingAttempt(req)) return send(res,429,{error:'pairing_rate_limited'}),true;
        const body=await readJsonBody(req);
        const code=typeof body.code==='string'?body.code.toUpperCase().replace(/[^A-F0-9]/g,''):'';
        const deviceName=typeof body.device_name==='string'?body.device_name.trim():'';
        const appVersion=validOptionalText(body.app_version,64);
        const macosVersion=validOptionalText(body.macos_version,64);
        const jianyingVersion=validOptionalText(body.jianying_version,64);
        if(!/^[A-F0-9]{16}$/.test(code) || !deviceName || deviceName.length>80 || appVersion===undefined || macosVersion===undefined || jianyingVersion===undefined) {
          return send(res,400,{error:'invalid_pairing_request'}),true;
        }
        const db=await pool.connect();
        const deviceToken=randomBytes(32).toString('base64url');
        try {
          await db.query('begin');
          const pairing=(await db.query(`select p.id,p.tenant_id from device_pairing_codes p
            join tenants t on t.id=p.tenant_id
            join tenant_members m on m.id=p.created_by_member_id and m.tenant_id=p.tenant_id
            where p.code_hash=$1 and p.consumed_at is null and p.expires_at>now()
              and t.status='active' and m.status='active'
            for update of p`,[createHash('sha256').update(code,'utf8').digest('hex')])).rows[0];
          if(!pairing) {
            await db.query('rollback');
            return send(res,401,{error:'invalid_or_expired_pairing_code'}),true;
          }
          await db.query('update device_pairing_codes set consumed_at=now() where id=$1',[pairing.id]);
          const device=(await db.query(`insert into sync_devices
            (tenant_id,device_name,device_token_hash,app_version,macos_version,jianying_version)
            values ($1,$2,$3,$4,$5,$6) returning id,tenant_id,device_name,paired_at`,
            [pairing.tenant_id,deviceName,createHash('sha256').update(deviceToken,'utf8').digest('hex'),appVersion,macosVersion,jianyingVersion])).rows[0];
          await db.query('commit');
          return send(res,201,{deviceId:device.id,tenantId:device.tenant_id,deviceName:device.device_name,deviceToken,pairedAt:device.paired_at}),true;
        } catch(error) {
          await db.query('rollback').catch(()=>{});
          throw error;
        } finally { db.release(); }
      }
      if(req.method==='GET' && url.pathname==='/api/agent/me') {
        const device=await authenticateDevice(req);
        if(!device) return send(res,401,{error:'device_unauthorized'}),true;
        return send(res,200,{deviceId:device.id,tenantId:device.tenant_id,deviceName:device.device_name,appVersion:device.app_version,macosVersion:device.macos_version,jianyingVersion:device.jianying_version}),true;
      }
      if(req.method==='POST' && url.pathname==='/api/agent/heartbeat') {
        const device=await authenticateDevice(req);
        if(!device) return send(res,401,{error:'device_unauthorized'}),true;
        const body=await readJsonBody(req);
        const appVersion=validOptionalText(body.app_version,64);
        const macosVersion=validOptionalText(body.macos_version,64);
        const jianyingVersion=validOptionalText(body.jianying_version,64);
        if(appVersion===undefined || macosVersion===undefined || jianyingVersion===undefined) return send(res,400,{error:'invalid_heartbeat'}),true;
        await pool.query(`update sync_devices set app_version=coalesce($1,app_version),macos_version=coalesce($2,macos_version),
          jianying_version=coalesce($3,jianying_version),last_seen_at=now()
          where id=$4 and tenant_id=$5 and status='active'`,[appVersion,macosVersion,jianyingVersion,device.id,device.tenant_id]);
        return send(res,200,{ok:true}),true;
      }
      if(!actor?.member_id) return send(res,401,{error:'login_required'}),true;
      if(req.method==='GET' && url.pathname==='/api/console/status') {
        const [prov,grant,conn]=await Promise.all([
          pool.query('select state from bitable_provisioning where tenant_id=$1',[actor.tenant_id]),
          pool.query('select status from feishu_user_grants where tenant_id=$1 and member_id=$2',[actor.tenant_id,actor.member_id]),connection(actor)]);
        const state=prov.rows[0]?.state; let stats={},run=null,webhookSecretAvailable=false;
        if(conn){
          const r=await pool.query('select kind,count(*)::int as count from media_assets where tenant_id=$1 and connection_id=$2 group by kind',[actor.tenant_id,conn.id]);
          stats=Object.fromEntries(r.rows.map(x=>[x.kind,x.count]));
          run=(await pool.query('select status,imported,failed,duplicates,errors,started_at,finished_at from feishu_sync_runs where tenant_id=$1 and connection_id=$2 order by started_at desc limit 1',[actor.tenant_id,conn.id])).rows[0] ?? null;
          webhookSecretAvailable=(await pool.query('select 1 from webhook_secret_reveals where tenant_id=$1 and connection_id=$2 and expires_at>now()',[actor.tenant_id,conn.id])).rowCount>0;
        }
        const webhookUrl=conn?`${publicOrigin}/webhooks/feishu/bitable/${conn.id}`:null;
        return send(res,200,{user:actor.display_name,workspace:actor.workspace_name,role:actor.role,authorization:grant.rows[0]?.status??'needs_reauth',provision:state?{status:state.status,pending:state.pending,baseUrl:state.baseUrl,fieldCount:Object.keys(state.fields??{}).length,tableId:state.tableId,lastError:state.lastError??null}:null,connected:!!conn,webhookUrl,webhookSecretAvailable,stats,run,provisionRunning:tasks.has(`p:${actor.tenant_id}`),syncRunning:tasks.has(`s:${actor.tenant_id}`)}),true;
      }
      if(req.method==='POST') requireSameOrigin(req,publicOrigin);
      if(req.method==='POST' && url.pathname==='/api/console/devices/pairing-code') {
        if(!['owner','admin'].includes(actor.role)) return send(res,403,{error:'insufficient_role'}),true;
        const active=await pool.query(`select count(*)::int as count from device_pairing_codes
          where tenant_id=$1 and consumed_at is null and expires_at>now()`,[actor.tenant_id]);
        if(active.rows[0].count>=5) return send(res,409,{error:'too_many_active_pairing_codes'}),true;
        const code=randomBytes(8).toString('hex').toUpperCase();
        const expires=(await pool.query(`insert into device_pairing_codes (tenant_id,created_by_member_id,code_hash,expires_at)
          values ($1,$2,$3,now()+interval '10 minutes') returning expires_at`,
          [actor.tenant_id,actor.member_id,createHash('sha256').update(code,'utf8').digest('hex')])).rows[0].expires_at;
        return send(res,201,{code,expiresAt:expires}),true;
      }
      if(req.method==='GET' && url.pathname==='/api/console/devices') {
        if(!['owner','admin'].includes(actor.role)) return send(res,403,{error:'insufficient_role'}),true;
        const devices=await pool.query(`select id,device_name,app_version,macos_version,jianying_version,status,last_seen_at,paired_at
          from sync_devices where tenant_id=$1 order by paired_at desc`,[actor.tenant_id]);
        return send(res,200,{devices:devices.rows}),true;
      }
      const revokeMatch=url.pathname.match(/^\/api\/console\/devices\/([0-9a-f-]{36})\/revoke$/i);
      if(req.method==='POST' && revokeMatch) {
        if(!['owner','admin'].includes(actor.role)) return send(res,403,{error:'insufficient_role'}),true;
        const result=await pool.query(`update sync_devices set status='revoked'
          where id=$1 and tenant_id=$2 and status<>'revoked' returning id`,[revokeMatch[1],actor.tenant_id]);
        return send(res,result.rowCount?200:404,{revoked:result.rowCount===1}),true;
      }

      if(req.method==='POST' && url.pathname==='/api/console/provision') {
        if(!['owner','admin'].includes(actor.role))return send(res,403,{error:'insufficient_role'}),true;
        const started=startTask(`p:${actor.tenant_id}`,async()=>{
          let result;
          try {result=await provisionBitable({client:clientFor(actor),journal,workspaceId:actor.tenant_id,creatorId:actor.member_id});}
          catch(error) {
            await journal.withLock(actor.tenant_id,async locked=>{const state=await locked.load(actor.tenant_id);if(state && state.creatorId===actor.member_id){state.lastError=/^(Field conflict|Field options conflict|Field ID changed|Multiple matching fields):/.test(error.message)?error.message:'创建未完成，请检查授权或核对已有资源';if(!state.pending && state.status!=='needs_review')state.status='failed';await locked.save(state);}}).catch(()=>{});
            return;
          }
          const webhookSecret=randomBytes(32).toString('base64url');
          const secretHash=createHash('sha256').update(webhookSecret,'utf8').digest('hex');
          const encryptedSecret=cipher.encrypt(webhookSecret);
          const db=await pool.connect();
          try {
            await db.query('begin');
            const inserted=await db.query(`insert into feishu_connections (tenant_id,app_mode,token_mode,app_id,app_token,table_id,field_mapping,webhook_secret_hash,connected_by_member_id)
              values ($1,$8,'user_access_token',$2,$3,$4,$5::jsonb,$6,$7)
              on conflict (tenant_id,app_token,table_id) do nothing
              returning id`,[actor.tenant_id,appId,result.baseToken,result.tableId,JSON.stringify(result.fields),secretHash,actor.member_id,appMode]);
            let connectionId=inserted.rows[0]?.id;
            if(connectionId){
              await db.query(`insert into webhook_secret_reveals (tenant_id,connection_id,ciphertext,nonce,tag,expires_at)
                values ($1,$2,$3,$4,$5,now()+interval '24 hours')`,[actor.tenant_id,connectionId,encryptedSecret.ciphertext,encryptedSecret.nonce,encryptedSecret.tag]);
            } else {
              const existing=await db.query(`select id,connected_by_member_id,app_mode,token_mode,app_id from feishu_connections
                where tenant_id=$1 and app_token=$2 and table_id=$3 for update`,[actor.tenant_id,result.baseToken,result.tableId]);
              const current=existing.rows[0];
              if(!current || current.connected_by_member_id!==actor.member_id || current.app_mode!==appMode || current.token_mode!=='user_access_token' || current.app_id!==appId){
                throw new Error('An existing connection conflicts with this account or app configuration.');
              }
              connectionId=current.id;
              await db.query('update feishu_connections set field_mapping=$1::jsonb,updated_at=now() where id=$2 and tenant_id=$3',[JSON.stringify(result.fields),connectionId,actor.tenant_id]);
            }
            await db.query('commit');
          } catch(error) {
            await db.query('rollback').catch(()=>{});
            throw error;
          } finally {
            db.release();
          }
        });
        return send(res,202,{started}),true;
      }
      if(req.method==='POST' && url.pathname==='/api/console/webhook-secret/reveal') {
        if(!['owner','admin'].includes(actor.role)) return send(res,403,{error:'insufficient_role'}),true;
        const conn=await connection(actor);if(!conn)return send(res,409,{error:'no_connection'}),true;
        const reveal=await pool.query(`delete from webhook_secret_reveals
          where tenant_id=$1 and connection_id=$2 and expires_at>now()
          returning ciphertext,nonce,tag`,[actor.tenant_id,conn.id]);
        if(!reveal.rows[0]) return send(res,404,{error:'secret_unavailable_or_already_viewed'}),true;
        const secret=cipher.decrypt(reveal.rows[0]);
        return send(res,200,{secret,webhookUrl:`${publicOrigin}/webhooks/feishu/bitable/${conn.id}`,expiresInSeconds:86400}),true;
      }
      if(req.method==='POST' && url.pathname==='/api/console/webhook-secret/rotate') {
        if(!['owner','admin'].includes(actor.role)) return send(res,403,{error:'insufficient_role'}),true;
        const conn=await connection(actor);if(!conn)return send(res,409,{error:'no_connection'}),true;
        const secret=randomBytes(32).toString('base64url');
        const encrypted=cipher.encrypt(secret);
        const db=await pool.connect();
        try {
          await db.query('begin');
          const updated=await db.query('update feishu_connections set webhook_secret_hash=$1,updated_at=now() where id=$2 and tenant_id=$3 and status=\'active\' returning id',
            [createHash('sha256').update(secret,'utf8').digest('hex'),conn.id,actor.tenant_id]);
          if(!updated.rowCount) throw new Error('Connection is no longer active.');
          await db.query(`insert into webhook_secret_reveals (tenant_id,connection_id,ciphertext,nonce,tag,expires_at)
            values ($1,$2,$3,$4,$5,now()+interval '24 hours')
            on conflict (connection_id) do update set tenant_id=excluded.tenant_id,ciphertext=excluded.ciphertext,nonce=excluded.nonce,tag=excluded.tag,expires_at=excluded.expires_at,created_at=now()`,
            [actor.tenant_id,conn.id,encrypted.ciphertext,encrypted.nonce,encrypted.tag]);
          await db.query('commit');
        } catch(error) {
          await db.query('rollback').catch(()=>{});
          throw error;
        } finally { db.release(); }
        return send(res,200,{rotated:true,webhookSecretAvailable:true}),true;
      }
      if(req.method==='POST' && url.pathname==='/api/console/check') {
        const conn=await connection(actor);if(!conn)return send(res,409,{error:'no_connection'}),true;
        await inspectConnection(clientFor(actor),conn.app_token,conn.table_id);return send(res,200,{ok:true}),true;
      }
      if(req.method==='POST' && url.pathname==='/api/console/sync') {
        if(!['owner','admin','editor'].includes(actor.role)) return send(res,403,{error:'insufficient_role'}),true;
        const conn=await connection(actor);if(!conn)return send(res,409,{error:'no_connection'}),true;
        const started=startTask(`s:${actor.tenant_id}`,async()=>{
          await runConnectionSync({pool,tenantId:actor.tenant_id,connection:conn,client:clientFor(actor)});
        });return send(res,202,{started}),true;
      }
      return send(res,404,{error:'not_found'}),true;
    } catch(error) {return send(res,error.status??500,{error:error.status===403?'invalid_origin':'operation_failed'}),true;}
  };
}
