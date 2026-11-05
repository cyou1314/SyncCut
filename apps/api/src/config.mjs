export function loadConfig(env = process.env) {
  const port = Number.parseInt(env.PORT ?? "8787", 10);
  const maxBodyBytes = Number.parseInt(env.MAX_WEBHOOK_BODY_BYTES ?? "1048576", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be a valid TCP port.");
  }
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1024 || maxBodyBytes > 4 * 1024 * 1024) {
    throw new Error("MAX_WEBHOOK_BODY_BYTES must be between 1 KiB and 4 MiB.");
  }
  return {
    nodeEnv: env.NODE_ENV ?? "development",
    port,
    databaseUrl: env.DATABASE_URL ?? "",
    maxBodyBytes,
  };
}
