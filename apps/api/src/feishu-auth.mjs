const TOKEN_ENDPOINT = "https://accounts.feishu.cn/oauth/v3/token";

/**
 * Server-side token provider for the initial single-tenant custom-app pilot.
 * A future store-app provider can implement the same async getAccessToken()
 * contract without changing the Bitable client.
 */
export function createCustomAppTokenProvider({
  clientId,
  clientSecret,
  fetchImpl = fetch,
  now = () => Date.now(),
}) {
  if (!clientId || !clientSecret) {
    throw new Error("Feishu App ID and App Secret are required.");
  }

  let cachedToken = null;
  let expiresAt = 0;
  let inflight = null;

  return async function getAccessToken() {
    if (cachedToken && expiresAt - now() > 60_000) {
      return cachedToken;
    }

    if (inflight) return inflight;
    inflight = (async () => {
    const response = await fetchImpl(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.code !== 0 || !payload.access_token) {
      // Deliberately omit response bodies and credentials from thrown errors.
      throw new Error("Unable to obtain Feishu tenant access token.");
    }

    const expiresIn = Number(payload.expires_in);
    if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new Error("Feishu returned an invalid token expiry.");
    }

    cachedToken = payload.access_token;
    expiresAt = now() + expiresIn * 1000;
    return cachedToken;
    })();
    try { return await inflight; } finally { inflight = null; }
  };
}
