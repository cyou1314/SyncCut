import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,readdir} from 'node:fs/promises';
import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createConsoleRoutes} from '../src/console-routes.mjs';

test('OAuth session, provisioning, sync and workspace isolation over HTTP', {skip:!process.env.TEST_DATABASE_URL,timeout:30000}, async()=>{
 const schema=`synccut_console_${randomUUID().replaceAll('-','')}`, admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});
 await admin.query(`create schema "${schema}"`);
 const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema},public`});
 let server;
 try {
  for(const file of (await readdir(new URL('../migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort()) await pool.query(await readFile(new URL(`../migrations/${file}`,import.meta.url),'utf8'));
  let tables=[],fields=[],user='user-a',tenantKey='enterprise';const json=value=>new Response(JSON.stringify({code:0,data:value}),{status:200});
  const mock=async (url,opts={})=>{const u=new URL(url);if(u.hostname==='accounts.feishu.cn')return new Response(JSON.stringify({code:0,access_token:'fake',refresh_token:'refresh',expires_in:3600}));if(u.pathname.endsWith('/user_info'))return json({open_id:user,...(tenantKey?{tenant_key:tenantKey}:{}),name:user});if(u.pathname.endsWith('/bitable/v1/apps')&&opts.method==='POST')return json({app:{app_token:'base',url:'https://example.feishu.cn/base/base'}});if(u.pathname.endsWith('/apps/base')&&!opts.body)return json({app:{app_token:'base'}});if(u.pathname.endsWith('/tables')){if(opts.method==='POST'){tables=[{table_id:'tbl',name:'素材表'}];fields=[{field_id:'f_name',field_name:'素材名称',type:1,is_primary:true}];return json({table_id:'tbl'})}return json({items:tables,has_more:false})}if(u.pathname.endsWith('/fields')){if(opts.method==='POST'){const field={...JSON.parse(opts.body),field_id:`f_${fields.length}`};fields.push(field);return json({field})}return json({items:fields,has_more:false})}if(u.pathname.endsWith('/records'))return json({items:[{record_id:'rec',fields:{素材名称:'雨声',素材类型:'音效',音频附件:[{file_token:'file',name:'rain.wav',type:'audio/wav',size:2}],集数:'EP015'}}],has_more:false});throw Error('Unexpected mock request')};
  const route=createConsoleRoutes({pool,appId:'cli_test',appSecret:'test-secret',encryptionKey:randomBytes(32).toString('base64'),publicOrigin:'http://127.0.0.1:8787',appMode:'store_app',fetchImpl:mock});
  server=createServer((req,res)=>{route(req,res,new URL(req.url,'http://127.0.0.1:8787')).catch(()=>{res.writeHead(500);res.end()})});await new Promise(r=>server.listen(0,'127.0.0.1',r));const root=`http://127.0.0.1:${server.address().port}`,origin='http://127.0.0.1:8787';
  async function login(){let r=await fetch(root+'/api/console/login',{method:'POST',headers:{origin}});assert.equal(r.status,200);let cookie=r.headers.get('set-cookie').split(';')[0];let state=new URL((await r.json()).authorizeUrl).searchParams.get('state');r=await fetch(`${root}/auth/feishu/callback?state=${state}&code=test`,{headers:{cookie},redirect:'manual'});assert.equal(r.status,303);assert.equal(r.headers.get('location'),'/feishu.html?auth=ok');return r.headers.get('set-cookie').split(';')[0]}
  const cookie=await login();let r=await fetch(root+'/api/console/provision',{method:'POST',headers:{cookie,origin}});assert.equal(r.status,202);
  async function status(){const response=await fetch(root+'/api/console/status',{headers:{cookie}});assert.equal(response.status,200);return response.json()}
  let state;for(let i=0;i<100;i++){state=await status();if(state.provision?.status==='complete'&&!state.provisionRunning)break;await new Promise(r=>setTimeout(r,20))}assert.equal(state.provision?.status,'complete');assert.equal(state.provision.fieldCount,19);
  r=await fetch(root+'/api/console/sync',{method:'POST',headers:{cookie,origin}});assert.equal(r.status,202);
  for(let i=0;i<100;i++){state=await status();if(state.run?.status==='completed')break;await new Promise(r=>setTimeout(r,20))}assert.equal(state.run?.status,'completed');assert.equal(state.stats.sfx,1);assert.equal((await pool.query('select app_mode from feishu_connections')).rows[0].app_mode,'store_app');
  r=await fetch(root+'/api/console/provision',{method:'POST',headers:{cookie,origin:'https://evil.example'}});assert.equal(r.status,403);
  user='user-b';const other=await login();r=await fetch(root+'/api/console/status',{headers:{cookie:other}});const otherState=await r.json();assert.equal(otherState.provision,null);assert.deepEqual(otherState.stats,{});
  // Same app-scoped open_id in the personal and enterprise namespace must not share a workspace.
  user='user-a';tenantKey=null;const personal=await login();
  r=await fetch(root+'/api/console/status',{headers:{cookie:personal}});const personalState=await r.json();assert.equal(personalState.provision,null);assert.deepEqual(personalState.stats,{});
  const again=await login();r=await fetch(root+'/api/console/status',{headers:{cookie:again}});assert.equal((await r.json()).user,'user-a');
  const row=await pool.query('select count(*)::int as n from feishu_personal_accounts');assert.equal(row.rows[0].n,1);
  const identities=await pool.query('select p.tenant_id as person,e.tenant_id as enterprise from feishu_personal_accounts p join feishu_personal_workspaces e on p.app_id=e.app_id and p.feishu_open_id=e.feishu_open_id');assert.notEqual(identities.rows[0].person,identities.rows[0].enterprise);
 } finally {if(server)await new Promise(r=>server.close(r));await pool.end();await admin.query(`drop schema "${schema}" cascade`);await admin.end()}
});
