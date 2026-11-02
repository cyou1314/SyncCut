import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createConsoleRoutes } from "./console-routes.mjs";
import { Pool } from "pg";
import { loadConfig } from "./config.mjs";
import { acceptBitableWebhook } from "./bitable-webhook.mjs";

const config = loadConfig();
if (!config.databaseUrl) {
  throw new Error("DATABASE_URL is required. Copy .env.example and configure a private PostgreSQL database.");
}

const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 10,
  application_name: "synccut-api",
});

const consoleEnabled = !!(process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET && process.env.SYNC_CREDENTIAL_ENCRYPTION_KEY && process.env.PUBLIC_ORIGIN);
const consoleRoutes = consoleEnabled ? createConsoleRoutes({pool,appId:process.env.FEISHU_APP_ID,appSecret:process.env.FEISHU_APP_SECRET,encryptionKey:process.env.SYNC_CREDENTIAL_ENCRYPTION_KEY,publicOrigin:process.env.PUBLIC_ORIGIN,appMode:process.env.FEISHU_APP_MODE ?? 'custom_app'}) : null;

function sendJson(response, status, body, requestId) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Request-Id": requestId,
  });
  response.end(JSON.stringify(body));
}

async function readJsonBody(request, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error("Request body too large.");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Request body must be valid JSON.");
    error.status = 400;
    throw error;
  }
}

const server = createServer(async (request, response) => {
  const requestId = randomUUID();
  const url = new URL(request.url ?? "/", "http://localhost");

  if (request.method === "GET" && (url.pathname === "/feishu.html" || url.pathname === "/")) {
    const file = new URL(url.pathname === "/" ? "../../web/index.html" : "../../web/feishu.html", import.meta.url);
    try {const html=await readFile(file);response.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer"});response.end(html);}
    catch {sendJson(response,500,{error:"page_unavailable"},requestId);} return;
  }
  if (consoleRoutes && (url.pathname.startsWith('/api/console/') || url.pathname.startsWith('/auth/feishu/'))) {
    try { await consoleRoutes(request,response,url); } catch { sendJson(response,500,{error:'internal_error'},requestId); } return;
  }
  if (request.method === "GET" && url.pathname === "/health") {
    try {
      await pool.query("select 1");
      return sendJson(response, 200, { status: "ok", service: "synccut-api" }, requestId);
    } catch {
      return sendJson(response, 503, { status: "database_unavailable" }, requestId);
    }
  }

  const match = url.pathname.match(/^\/webhooks\/feishu\/bitable\/([0-9a-f-]{36})$/i);
  if (request.method === "POST" && match) {
    try {
      const payload = await readJsonBody(request, config.maxBodyBytes);
      const result = await acceptBitableWebhook({
        db: pool,
        connectionId: match[1],
        authorization: request.headers.authorization,
        payload,
      });
      return sendJson(response, result.status, result.body, requestId);
    } catch (error) {
      const status = error.status ?? (error instanceof TypeError ? 400 : 500);
      if (status >= 500) {
        // Do not log headers, request bodies, or credentials.
        process.stderr.write(`[${requestId}] Webhook processing failed: ${error.message}\n`);
      }
      return sendJson(
        response,
        status,
        { error: status >= 500 ? "internal_error" : error.message },
        requestId,
      );
    }
  }

  return sendJson(response, 404, { error: "not_found" }, requestId);
});

server.listen(config.port, process.env.HOST ?? "127.0.0.1", () => {
  process.stdout.write(`SyncCut API listening on port ${config.port}\n`);
});

async function shutdown() {
  server.close();
  await pool.end();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
