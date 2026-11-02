import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { startUserAuthorization,completeUserAuthorization } from './feishu-oauth.mjs';
import { createOAuthStateStore } from './oauth-state-store.mjs';
import { createUserGrantStore } from './user-grant-store.mjs';
import { createProvisioningJournal } from './provisioning-journal.mjs';
import { createCredentialCipher } from './credential-crypto.mjs';
import { FeishuBitableClient } from './bitable-client.mjs';
import { provisionBitable } from './bitable-provisioner.mjs';
import { fullSync,inspectConnection } from './bitable-sync.mjs';
import { createAssetStore } from './asset-store.mjs';
import { newSessionId,sessionDigest,sessionFromCookie,sessionCookie,requireSameOrigin,findSession,bindPersonalWorkspace } from './console-auth.mjs';

export function createConsoleRoutes({pool,appId,appSecret,encryptionKey,publicOrigin,fetchImpl=fetch}) {
  const origin=new URL(publicOrigin);
  if(origin.origin!==publicOrigin || (origin.protocol!=='https:' && !(origin.protocol==='http:' && ['localhost','127.0.0.1'].includes(origin.hostname)))) throw new Error('PUBLIC_ORIGIN must be an HTTPS origin or loopback HTTP origin');
  const cipher=createCredentialCipher(encryptionKey), states=createOAuthStateStore({db:pool,cipher}), grants=createUserGrantStore({pool,cipher,clientId:appId,clientSecret:appSecret,fetchImpl}), journal=createProvisioningJournal(pool);
  const redirectUri=`${publicOrigin}/auth/feishu/callback`;
  const secure=origin.protocol==='https:';
  const clientFor = actor => new FeishuBitableClient({getAccessToken:grants.provider(actor.tenant_id,actor.member_id),fetchImpl});
  const send=(res,status,body,headers={})=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff',...headers});res.end(JSON.stringify(body));};
  const redirect=(res,location,headers={})=>{res.writeHead(303,{'location':location,'cache-control':'no-store','referrer-policy':'no-referrer',...headers});res.end();};
  const tasks=new Set();
  function startTask(key,work) {if(tasks.has(key))return false; tasks.add(key);void Promise.resolve().then(work).catch(()=>{}).finally(()=>tasks.delete(key));return true;}
  async function connection(actor) {
    const result=await pool.query("select * from feishu_connections where tenant_id=$1 and connected_by_member_id=$2 and token_mode='user_access_token' and status='active' order by created_at desc limit 1",[actor.tenant_id,actor.member_id]);return result.rows[0];
  }
  return async function route(req,res,url) {
    if(!url.pathname.startsWith('/api/console/') && !url.pathname.startsWith('/auth/feishu/')) return false;
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
        const result=await completeUserAuthorization({stateStore:states,sessionId:sid,state:url.searchParams.get('state'),code:url.searchParams.get('code'),clientId:appId,clientSecret:appSecret,redirectUri,fetchImpl});
        const identity=await bindPersonalWorkspace(pool,{user:result.user,appId,sessionId:sid});
        await grants.saveGrant(identity.tenant_id,identity.member_id,result.tokens);
        return redirect(res,'/feishu.html?auth=ok',{'Set-Cookie':sessionCookie(identity.sessionId,{secure})}),true;
      }
      if(!actor?.member_id) return send(res,401,{error:'login_required'}),true;
      if(req.method==='GET' && url.pathname==='/api/console/status') {
        const [prov,grant,conn]=await Promise.all([
          pool.query('select state from bitable_provisioning where tenant_id=$1',[actor.tenant_id]),
          pool.query('select status from feishu_user_grants where tenant_id=$1 and member_id=$2',[actor.tenant_id,actor.member_id]),connection(actor)]);
        const state=prov.rows[0]?.state; let stats={},run=null;
        if(conn){const r=await pool.query('select kind,count(*)::int as count from media_assets where tenant_id=$1 and connection_id=$2 group by kind',[actor.tenant_id,conn.id]);stats=Object.fromEntries(r.rows.map(x=>[x.kind,x.count]));run=(await pool.query('select status,imported,failed,duplicates,errors,started_at,finished_at from feishu_sync_runs where tenant_id=$1 and connection_id=$2 order by started_at desc limit 1',[actor.tenant_id,conn.id])).rows[0] ?? null;}
        return send(res,200,{user:actor.display_name,workspace:actor.workspace_name,role:actor.role,authorization:grant.rows[0]?.status??'needs_reauth',provision:state?{status:state.status,pending:state.pending,baseUrl:state.baseUrl,fieldCount:Object.keys(state.fields??{}).length,tableId:state.tableId,lastError:state.lastError??null}:null,stats,run,provisionRunning:tasks.has(`p:${actor.tenant_id}`),syncRunning:tasks.has(`s:${actor.tenant_id}`)}),true;
      }
      if(req.method==='POST') requireSameOrigin(req,publicOrigin);
      if(req.method==='POST' && url.pathname==='/api/console/provision') {
        if(!['owner','admin'].includes(actor.role))return send(res,403,{error:'insufficient_role'}),true;
        const started=startTask(`p:${actor.tenant_id}`,async()=>{
          let result;
          try {result=await provisionBitable({client:clientFor(actor),journal,workspaceId:actor.tenant_id,creatorId:actor.member_id});}
          catch(error) {
            await journal.withLock(actor.tenant_id,async locked=>{const state=await locked.load(actor.tenant_id);if(state && state.creatorId===actor.member_id){state.lastError=/^(Field conflict|Field options conflict|Field ID changed|Multiple matching fields):/.test(error.message)?error.message:'创建未完成，请检查授权或核对已有资源';if(!state.pending && state.status!=='needs_review')state.status='failed';await locked.save(state);}}).catch(()=>{});
            return;
          }
          const secretHash=createHash('sha256').update(randomBytes(32)).digest('hex');
          await pool.query(`insert into feishu_connections (tenant_id,app_mode,token_mode,app_id,app_token,table_id,field_mapping,webhook_secret_hash,connected_by_member_id)
            values ($1,'custom_app','user_access_token',$2,$3,$4,$5::jsonb,$6,$7)
            on conflict (tenant_id,app_token,table_id) do update set field_mapping=excluded.field_mapping,updated_at=now()
            where feishu_connections.connected_by_member_id=excluded.connected_by_member_id and feishu_connections.token_mode='user_access_token'`,[actor.tenant_id,appId,result.baseToken,result.tableId,JSON.stringify(result.fields),secretHash,actor.member_id]);
        });
        return send(res,202,{started}),true;
      }
      if(req.method==='POST' && url.pathname==='/api/console/check') {
        const conn=await connection(actor);if(!conn)return send(res,409,{error:'no_connection'}),true;
        await inspectConnection(clientFor(actor),conn.app_token,conn.table_id);return send(res,200,{ok:true}),true;
      }
      if(req.method==='POST' && url.pathname==='/api/console/sync') {
        if(!['owner','admin','editor'].includes(actor.role)) return send(res,403,{error:'insufficient_role'}),true;
        const conn=await connection(actor);if(!conn)return send(res,409,{error:'no_connection'}),true;
        const started=startTask(`s:${actor.tenant_id}`,async()=>{
          const db=await pool.connect();let locked=false,run;
          try {
            locked=(await db.query('select pg_try_advisory_lock(hashtextextended($1,0)) as locked',[`synccut-sync:${actor.tenant_id}`])).rows[0].locked;
            if(!locked)return;
            run=(await db.query("insert into feishu_sync_runs (tenant_id,connection_id,status) values ($1,$2,'running') returning id",[actor.tenant_id,conn.id])).rows[0].id;
            const result=await fullSync({client:clientFor(actor),connection:{appToken:conn.app_token,tableId:conn.table_id,fieldMapping:conn.field_mapping},store:createAssetStore(pool,actor.tenant_id,conn.id),onProgress:async p=>db.query('update feishu_sync_runs set imported=$1,duplicates=$2,failed=$3 where id=$4 and tenant_id=$5',[p.imported,p.duplicates,p.failed,run,actor.tenant_id])});
            await db.query('update feishu_sync_runs set status=$1,imported=$2,duplicates=$3,failed=$4,errors=$5::jsonb,finished_at=now() where id=$6 and tenant_id=$7',[result.failed?'partial':'completed',result.imported,result.duplicates,result.failed,JSON.stringify(result.errors),run,actor.tenant_id]);
          } catch {if(run)await db.query("update feishu_sync_runs set status='failed',errors=$1::jsonb,finished_at=now() where id=$2 and tenant_id=$3",[JSON.stringify([{reason:'同步中断，请检查连接后重试'}]),run,actor.tenant_id]).catch(()=>{});}
          finally {let broken=false;if(locked)await db.query('select pg_advisory_unlock(hashtextextended($1,0))',[`synccut-sync:${actor.tenant_id}`]).catch(()=>{broken=true});db.release(broken);}
        });return send(res,202,{started}),true;
      }
      return send(res,404,{error:'not_found'}),true;
    } catch(error) {return send(res,error.status??500,{error:error.status===403?'invalid_origin':'operation_failed'}),true;}
  };
}
