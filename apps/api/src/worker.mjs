// SyncCut cloud worker entrypoint (M2.2).
// Runs the sync worker loop: reap expired leases, fold webhook inbox
// events into queued jobs, execute sync jobs, archive attachments to
// object storage, and periodically enqueue compensation syncs.
// Configuration comes from the environment (see .env.example additions):
// DATABASE_URL, FEISHU_APP_ID, FEISHU_APP_SECRET,
// SYNC_CREDENTIAL_ENCRYPTION_KEY, S3_ENDPOINT, S3_BUCKET,
// S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_REGION,
// WORKER_POLL_MS, WORKER_COMPENSATION_MINUTES.
import { Pool } from "pg";
import { createCredentialCipher } from "./credential-crypto.mjs";
import { createUserGrantStore } from "./user-grant-store.mjs";
import { FeishuBitableClient } from "./bitable-client.mjs";
import { createTaskQueue } from "./task-queue.mjs";
import { createObjectStore } from "./object-store.mjs";
import { createSyncWorker } from "./sync-worker.mjs";

const required = ["DATABASE_URL", "FEISHU_APP_ID", "FEISHU_APP_SECRET", "SYNC_CREDENTIAL_ENCRYPTION_KEY", "S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"];
for (const name of required) {
  if (!process.env[name]) throw new Error(`${name} is required for the worker.`);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5, application_name: "synccut-worker" });
const cipher = createCredentialCipher(process.env.SYNC_CREDENTIAL_ENCRYPTION_KEY);
const grants = createUserGrantStore({
  pool,
  cipher,
  clientId: process.env.FEISHU_APP_ID,
  clientSecret: process.env.FEISHU_APP_SECRET,
  fetchImpl: fetch,
});
const queue = createTaskQueue(pool);
const objectStore = createObjectStore({
  endpoint: process.env.S3_ENDPOINT,
  bucket: process.env.S3_BUCKET,
  accessKeyId: process.env.S3_ACCESS_KEY_ID,
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  region: process.env.S3_REGION ?? "us-east-1",
});
const worker = createSyncWorker({
  pool,
  queue,
  objectStore,
  makeClient: (connection) => new FeishuBitableClient({
    getAccessToken: grants.provider(connection.tenant_id, connection.connected_by_member_id),
    fetchImpl: fetch,
  }),
  compensationMinutes: Number(process.env.WORKER_COMPENSATION_MINUTES ?? 15),
  maxAttachmentBytes,
  log: (event, details) => process.stderr.write(`[worker] ${event} ${JSON.stringify(details)}\n`),
});

const pollMs = Number(process.env.WORKER_POLL_MS ?? 3000);
const maxAttachmentBytes = Number(process.env.WORKER_MAX_ATTACHMENT_BYTES ?? 256 * 1024 * 1024);
if (!Number.isInteger(pollMs) || pollMs < 250) throw new Error("WORKER_POLL_MS must be an integer of at least 250.");
if (!Number.isInteger(maxAttachmentBytes) || maxAttachmentBytes < 1) throw new Error("WORKER_MAX_ATTACHMENT_BYTES must be a positive integer.");
let stopped = false;
let compensationTimer = null;
let compensationInFlight = null;

async function loop() {
  while (!stopped) {
    try {
      await worker.tick();
    } catch (error) {
      process.stderr.write(`[worker] tick failed: ${error.message}\n`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

async function compensationLoop() {
  if (compensationInFlight) return compensationInFlight;
  compensationInFlight = (async () => {
    try { await worker.compensationPass(); }
    catch (error) { process.stderr.write(`[worker] compensation failed: ${error.message}\\n`); }
    finally { compensationInFlight = null; }
  })();
  return compensationInFlight;
}

process.stdout.write("SyncCut worker started\\n");
compensationLoop();
compensationTimer = setInterval(compensationLoop, Math.max(1, Number(process.env.WORKER_COMPENSATION_MINUTES ?? 15)) * 60 * 1000);
const mainLoop = loop();

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  stopped = true;
  if (compensationTimer) clearInterval(compensationTimer);
  await Promise.allSettled([mainLoop, compensationInFlight].filter(Boolean));
  await pool.end().catch(() => {});
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
