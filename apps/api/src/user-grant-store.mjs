import { refreshUserTokens } from './feishu-oauth.mjs';

// An advisory session lock serializes rotation across all API processes. The
// refreshing marker commits before the remote call: if the process dies or a
// response is lost, the old one-use refresh token is never blindly retried.
export function createUserGrantStore({pool,cipher,clientId,clientSecret,fetchImpl=fetch,now=()=>Date.now()}) {
  async function locked(tenantId,memberId,fn) {
    if (!tenantId || !memberId) throw new Error('Workspace and member are required');
    const db=await pool.connect(), key=`synccut-grant:${tenantId}:${memberId}`; let hasLock=false;
    try {await db.query('select pg_advisory_lock(hashtextextended($1,0))',[key]);hasLock=true;return await fn(db);}
    finally {let broken=false; if(hasLock) await db.query('select pg_advisory_unlock(hashtextextended($1,0))',[key]).catch(()=>{broken=true});db.release(broken);}
  }
  function seal(tenantId,memberId,tokens) {
    if (!tokens.accessToken || !tokens.refreshToken || !Number.isFinite(tokens.expiresIn) || tokens.expiresIn<=0) throw new Error('Invalid user grant');
    return cipher.encrypt(JSON.stringify({tenantId,memberId,accessToken:tokens.accessToken,refreshToken:tokens.refreshToken}));
  }
  async function save(db,tenantId,memberId,tokens) {
    const value=seal(tenantId,memberId,tokens);
    await db.query(`insert into feishu_user_grants (tenant_id,member_id,ciphertext,nonce,tag,expires_at,status)
      values ($1,$2,$3,$4,$5,$6,'active') on conflict (tenant_id,member_id) do update set
      ciphertext=excluded.ciphertext,nonce=excluded.nonce,tag=excluded.tag,expires_at=excluded.expires_at,status='active',updated_at=now()`,
      [tenantId,memberId,value.ciphertext,value.nonce,value.tag,new Date(now()+tokens.expiresIn*1000)]);
  }
  return {
    // Call only after authenticating the Feishu identity and verifying membership.
    saveGrant:(tenantId,memberId,tokens)=>locked(tenantId,memberId,db=>save(db,tenantId,memberId,tokens)),
    revoke:(tenantId,memberId)=>locked(tenantId,memberId,db=>db.query("update feishu_user_grants set status='needs_reauth',updated_at=now() where tenant_id=$1 and member_id=$2",[tenantId,memberId])),
    provider(tenantId,memberId) {
      return ()=>locked(tenantId,memberId,async db=>{
        const result=await db.query('select * from feishu_user_grants where tenant_id=$1 and member_id=$2',[tenantId,memberId]);
        const row=result.rows[0];
        if(row?.status==='refreshing') await db.query("update feishu_user_grants set status='needs_reauth',updated_at=now() where tenant_id=$1 and member_id=$2",[tenantId,memberId]);
        if(!row || row.status!=='active') throw new Error('Feishu authorization required');
        const tokens=JSON.parse(cipher.decrypt({ciphertext:row.ciphertext,nonce:row.nonce,tag:row.tag}));
        if(tokens.tenantId!==tenantId || tokens.memberId!==memberId) throw new Error('Credential binding mismatch');
        if(new Date(row.expires_at).getTime()-now()>60000) return tokens.accessToken;
        await db.query("update feishu_user_grants set status='refreshing',updated_at=now() where tenant_id=$1 and member_id=$2",[tenantId,memberId]);
        try {
          const next=await refreshUserTokens({clientId,clientSecret,refreshToken:tokens.refreshToken,fetchImpl});
          await save(db,tenantId,memberId,next);
          return next.accessToken;
        } catch {
          await db.query("update feishu_user_grants set status='needs_reauth',updated_at=now() where tenant_id=$1 and member_id=$2",[tenantId,memberId]).catch(()=>{});
          throw new Error('Feishu authorization required');
        }
      });
    },
  };
}
