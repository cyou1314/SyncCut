import { createHash, timingSafeEqual } from "node:crypto";

export function hashWebhookSecret(secret) {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function bearerSecretMatches(authorization, expectedHash) {
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) return false;
  const secret = authorization.slice(7).trim();
  if (!secret || typeof expectedHash !== "string" || !/^[a-f0-9]{64}$/i.test(expectedHash)) return false;
  const actual = Buffer.from(hashWebhookSecret(secret), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function validateBitableWebhookPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("Webhook body must be a JSON object.");
  }
  if (typeof payload.record_id !== "string" || payload.record_id.length < 1 || payload.record_id.length > 128) {
    throw new TypeError("record_id is required.");
  }
  const eventType = payload.event_type ?? "record.updated";
  if (!["record.created", "record.updated"].includes(eventType)) {
    throw new TypeError("Unsupported event_type.");
  }
  return {
    eventType,
    recordId: payload.record_id,
    modifiedTime: payload.modified_time == null ? null : String(payload.modified_time),
    appToken: payload.app_token == null ? null : String(payload.app_token),
    tableId: payload.table_id == null ? null : String(payload.table_id),
    payload,
  };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function makeBitableEventKey(connectionId, normalizedEvent) {
  return createHash("sha256")
    .update(connectionId, "utf8")
    .update("\n", "utf8")
    .update(stableJson({
      event_type: normalizedEvent.eventType,
      record_id: normalizedEvent.recordId,
      modified_time: normalizedEvent.modifiedTime,
      payload: normalizedEvent.payload,
    }), "utf8")
    .digest("hex");
}

export async function acceptBitableWebhook({ db, connectionId, authorization, payload }) {
  const normalized = validateBitableWebhookPayload(payload);
  const connectionResult = await db.query(
    `select id, tenant_id, app_token, table_id, webhook_secret_hash
       from feishu_connections
      where id = $1 and status = 'active'`,
    [connectionId],
  );

  const connection = connectionResult.rows[0];
  if (!connection) return { status: 404, body: { error: "connection_not_found" } };
  if (!bearerSecretMatches(authorization, connection.webhook_secret_hash)) {
    return { status: 401, body: { error: "unauthorized" } };
  }
  if (normalized.appToken && normalized.appToken !== connection.app_token) {
    return { status: 409, body: { error: "app_token_mismatch" } };
  }
  if (normalized.tableId && normalized.tableId !== connection.table_id) {
    return { status: 409, body: { error: "table_id_mismatch" } };
  }

  const eventKey = makeBitableEventKey(connectionId, normalized);
  const inserted = await db.query(
    `insert into feishu_event_inbox
       (tenant_id, connection_id, event_key, event_type, record_id, payload)
     values ($1, $2, $3, $4, $5, $6::jsonb)
     on conflict (connection_id, event_key) do nothing
     returning id`,
    [
      connection.tenant_id,
      connection.id,
      eventKey,
      normalized.eventType,
      normalized.recordId,
      JSON.stringify(normalized.payload),
    ],
  );

  return { status: 202, body: { accepted: true, duplicate: inserted.rowCount === 0 } };
}
