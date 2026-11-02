import test from 'node:test';
import assert from 'node:assert/strict';
import {startUserAuthorization,completeUserAuthorization,refreshUserTokens} from '../src/feishu-oauth.mjs';
import {createHash} from 'node:crypto';
function store(){let saved;return {create:async v=>{saved=v},consume:async ({hash,sessionId,now})=>{if(!saved || saved.hash!==hash || saved.sessionId!==sessionId || saved.expiresAt<now)return null; const v=saved;saved=null;return v}}}
const config={clientId:'cli_test',clientSecret:'secret',redirectUri:'https://example.com/callback'};
test('state binds session, is single use and exchanges code with PKCE',async()=>{
 const stateStore=store(),url=new URL(await startUserAuthorization({stateStore,sessionId:'s',...config,scopes:['offline_access']}));
 const state=url.searchParams.get('state'); let called=0;
 const fetchImpl=async (url,opts)=>{called++;if(called===1){const body=JSON.parse(opts.body);assert.equal(body.grant_type,'authorization_code');assert.equal(createHash('sha256').update(body.code_verifier).digest('base64url'),new URL(url0).searchParams.get('code_challenge'));return new Response(JSON.stringify({code:0,access_token:'access',refresh_token:'refresh',expires_in:3600}));}return new Response(JSON.stringify({code:0,data:{open_id:'ou_1',tenant_key:'tenant',name:'User'}}));};
 const url0=url;
 await assert.rejects(completeUserAuthorization({stateStore,sessionId:'other',state,code:'code',...config,fetchImpl}),/state/);
 const result=await completeUserAuthorization({stateStore,sessionId:'s',state,code:'code',...config,fetchImpl});
 assert.equal(result.user.openId,'ou_1');assert.equal(result.tokens.refreshToken,'refresh');
 await assert.rejects(completeUserAuthorization({stateStore,sessionId:'s',state,code:'code',...config,fetchImpl}),/state/);
});
test('refresh returns rotated token and hides error response',async()=>{
 const r=await refreshUserTokens({...config,refreshToken:'old',fetchImpl:async (_,opts)=>{assert.equal(JSON.parse(opts.body).refresh_token,'old');return new Response(JSON.stringify({code:0,access_token:'new',refresh_token:'rotated',expires_in:60}));}});
 assert.equal(r.refreshToken,'rotated');
 await assert.rejects(refreshUserTokens({...config,refreshToken:'old',fetchImpl:async()=>new Response(JSON.stringify({code:1,detail:'secret'}))}),e=>!e.message.includes('secret'));
});
