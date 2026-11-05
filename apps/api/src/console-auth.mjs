import {createHash,randomBytes} from 'node:crypto';
const digest = value => createHash('sha256').update(value).digest('hex');
export const newSessionId = () => randomBytes(32).toString('base64url');
export const sessionDigest = digest;
export function sessionFromCookie(header='') {
  const matches=header.split(';').map(s=>s.trim()).filter(s=>s.startsWith('synccut_session='));
  if(matches.length!==1) return null;
  const value=matches[0].slice('synccut_session='.length);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}
export function sessionCookie(id,{secure=true,maxAge=86400}={}) {
  return `synccut_session=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure?'; Secure':''}`;
}
export function requireSameOrigin(request,origin) {
  if(request.headers.origin!==origin || request.headers['sec-fetch-site']==='cross-site') throw Object.assign(new Error('Invalid request origin'),{status:403});
}
export async function findSession(db,id) {
  if(!id) return null;
  const result=await db.query(`select s.tenant_id,s.member_id,m.role,m.display_name,t.display_name as workspace_name
    from console_sessions s left join tenant_members m on m.id=s.member_id and m.tenant_id=s.tenant_id
    left join tenants t on t.id=s.tenant_id where s.session_hash=$1 and s.expires_at>now()
    and (s.member_id is null or (m.status='active' and t.status='active'))`,[digest(id)]);
  return result.rows[0] ?? null;
}
export async function bindPersonalWorkspace(pool,{user,appId,sessionId}) {
  const db=await pool.connect();
  try {
    await db.query('begin');
    if (!appId || !user.openId || (user.tenantKey != null && !user.tenantKey)) throw new Error('Invalid Feishu identity');
    const personal=user.tenantKey == null;
    const key=JSON.stringify([appId,personal?'personal':'tenant',user.tenantKey,user.openId]);
    await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[key]);
    let found=personal
      ? await db.query('select tenant_id,member_id from feishu_personal_accounts where app_id=$1 and feishu_open_id=$2',[appId,user.openId])
      : await db.query('select tenant_id,member_id from feishu_personal_workspaces where app_id=$1 and feishu_tenant_key=$2 and feishu_open_id=$3',[appId,user.tenantKey,user.openId]);
    let identity=found.rows[0];
    if(!identity) {
      const tenant=(await db.query('insert into tenants (display_name) values ($1) returning id',[`${user.name || '用户'}的工作区`])).rows[0].id;
      const member=(await db.query("insert into tenant_members (tenant_id,feishu_user_id,display_name,role) values ($1,$2,$3,'owner') returning id",[tenant,user.openId,user.name])).rows[0].id;
      if (personal) await db.query('insert into feishu_personal_accounts (app_id,feishu_open_id,tenant_id,member_id) values ($1,$2,$3,$4)',[appId,user.openId,tenant,member]);
      else await db.query('insert into feishu_personal_workspaces (app_id,feishu_tenant_key,feishu_open_id,tenant_id,member_id) values ($1,$2,$3,$4,$5)',[appId,user.tenantKey,user.openId,tenant,member]);
      identity={tenant_id:tenant,member_id:member};
    }
    const active=await db.query("select 1 from tenant_members m join tenants t on t.id=m.tenant_id where m.id=$1 and m.tenant_id=$2 and m.status='active' and t.status='active'",[identity.member_id,identity.tenant_id]);
    if(!active.rowCount) throw new Error('Workspace unavailable');
    const rotated=newSessionId();
    const old=await db.query('delete from console_sessions where session_hash=$1 and expires_at>now() returning session_hash',[digest(sessionId)]);
    if(!old.rowCount) throw new Error('Session expired');
    await db.query("insert into console_sessions (session_hash,tenant_id,member_id,expires_at) values ($1,$2,$3,now()+interval '1 day')",[digest(rotated),identity.tenant_id,identity.member_id]);
    await db.query('commit');return {...identity,sessionId:rotated};
  } catch(error) {await db.query('rollback');throw error;} finally {db.release();}
}
