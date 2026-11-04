import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

test("worker entrypoint boots with valid configuration", { timeout: 10000 }, async () => {
  const workerPath = fileURLToPath(new URL("../src/worker.mjs", import.meta.url));
  const child = spawn(process.execPath, [workerPath], {
    env: {
      ...process.env,
      DATABASE_URL: "postgresql://synccut:synccut@127.0.0.1:1/synccut_test",
      FEISHU_APP_ID: "cli_worker_smoke_test",
      FEISHU_APP_SECRET: "worker-smoke-secret",
      SYNC_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      S3_ENDPOINT: "https://s3.example.test",
      S3_BUCKET: "synccut-worker-smoke",
      S3_ACCESS_KEY_ID: "worker-smoke-access",
      S3_SECRET_ACCESS_KEY: "worker-smoke-secret",
      WORKER_POLL_MS: "250",
      WORKER_COMPENSATION_MINUTES: "0",
      WORKER_MAX_ATTACHMENT_BYTES: "1024",
      PGCONNECT_TIMEOUT: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  const startup = new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
      child.stdout.off("data", onData);
      callback(value);
    };
    const onExit = (code, signal) => finish(reject, new Error(
      `Worker exited before startup (code=${code}, signal=${signal}). stdout=${stdout} stderr=${stderr}`
    ));
    const onError = (error) => finish(reject, error);
    const onData = (chunk) => {
      stdout += chunk;
      if (stdout.includes("SyncCut worker started")) finish(resolve);
    };
    const timer = setTimeout(() => finish(reject, new Error(
      `Worker did not report startup within 5 seconds. stdout=${stdout} stderr=${stderr}`
    )), 5000);
    child.on("exit", onExit);
    child.on("error", onError);
    child.stdout.on("data", onData);
  });

  let startupError;
  try {
    await startup;
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(child.exitCode, null, `Worker exited after printing startup. stderr=${stderr}`);
  } catch (error) {
    startupError = error;
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const exited = await Promise.race([
        once(child, "exit").then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 3000)),
      ]);
      if (!exited) child.kill("SIGKILL");
    }
  }
  if (startupError) throw startupError;
  assert.equal(child.exitCode, 0, `Worker did not shut down cleanly. stderr=${stderr}`);
});
