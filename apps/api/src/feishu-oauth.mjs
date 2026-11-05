import { createHash, randomBytes } from 'node:crypto';

const TOKEN_ENDPOINT = 'https://accounts.feishu.cn/oauth/v3/token';
const AUTHORIZE_ENDPOINT = 'https://accounts.feishu.cn/open-apis/authen/v1/authorize';
const USER_INFO_ENDPOINT = 'https://open.feishu.cn/open-apis/authen/v1/user_info';

// stateStore must atomically consume the hash and bind it to an existing browser session.
export async function startUserAuthorization({stateStore, sessionId, clientId, redirectUri, scopes}) {
  if (!sessionId || !clientId || !redirectUri || !Array.isArray(scopes) || !scopes.includes('offline_access')) throw new Error('Invalid OAuth configuration');
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(state).digest('hex');
  await stateStore.create({hash, sessionId, verifier, expiresAt: Date.now() + 300000});
  const url = new URL(AUTHORIZE_ENDPOINT);
  // PKCE is intentionally not used: in real-environment testing Feishu's
  // authorize redirect chain dropped code_challenge, and the v3 token
  // endpoint then rejected the exchange with 20049 (invalid_grant). This is
  // a confidential server-side client; the client secret authenticates the
  // exchange. The verifier is still generated and stored with the state so
  // PKCE can be re-enabled without a schema change.
  for (const [key,value] of Object.entries({client_id:clientId,redirect_uri:redirectUri,response_type:'code',scope:scopes.join(' '),state})) url.searchParams.set(key,value);
  return url.toString();
}

async function tokenRequest(fetchImpl, body) {
  const response = await fetchImpl(TOKEN_ENDPOINT,{method:'POST',headers:{'Content-Type':'application/json; charset=utf-8'},body:JSON.stringify(body)});
  const json = await response.json().catch(()=>({}));
  if (!response.ok || json.code !== 0 || typeof json.access_token !== 'string' || typeof json.refresh_token !== 'string' || !Number.isFinite(json.expires_in) || json.expires_in <= 0) throw new Error('Feishu user token request failed');
  return { accessToken:json.access_token, refreshToken:json.refresh_token, expiresIn:json.expires_in, refreshExpiresIn:json.refresh_token_expires_in ?? null, scope:json.scope ?? '' };
}

export async function completeUserAuthorization({stateStore,sessionId,state,code,clientId,clientSecret,redirectUri,appMode='custom_app',fetchImpl=fetch}) {
  if (!['custom_app','store_app'].includes(appMode)) throw new Error('Invalid Feishu app mode');
  if (!sessionId || typeof state !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(state) || !code) throw new Error('Invalid OAuth callback');
  const hash=createHash('sha256').update(state).digest('hex');
  const attempt=await stateStore.consume({hash,sessionId,now:Date.now()});
  if (!attempt) throw new Error('Invalid or expired OAuth state');
  const tokens=await tokenRequest(fetchImpl,{grant_type:'authorization_code',client_id:clientId,client_secret:clientSecret,code,redirect_uri:redirectUri});
  const response=await fetchImpl(USER_INFO_ENDPOINT,{headers:{Authorization:`Bearer ${tokens.accessToken}`}});
  const json=await response.json().catch(()=>({}));
  if (!response.ok || json.code !== 0 || typeof json.data?.open_id !== 'string' || !json.data.open_id || (json.data.tenant_key != null && (typeof json.data.tenant_key !== 'string' || !json.data.tenant_key)) || (appMode === 'custom_app' && !json.data.tenant_key)) throw new Error('Unable to read Feishu user identity');
  return {tokens, user:{openId:json.data.open_id,tenantKey:json.data.tenant_key ?? null,name:json.data.name ?? ''}};
}

// Caller must serialize by credential across all processes and atomically replace the
// encrypted access AND refresh token. An ambiguous response requires reauthorization:
// Feishu invalidates the old refresh token immediately on successful rotation.
export async function refreshUserTokens({clientId,clientSecret,refreshToken,fetchImpl=fetch}) {
  return tokenRequest(fetchImpl,{grant_type:'refresh_token',client_id:clientId,client_secret:clientSecret,refresh_token:refreshToken});
}
