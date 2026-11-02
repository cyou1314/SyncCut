import test from "node:test";
import assert from "node:assert/strict";
import {
  hashWebhookSecret,
  bearerSecretMatches,
  validateBitableWebhookPayload,
  makeBitableEventKey,
} from "../src/bitable-webhook.mjs";

test("webhook bearer secret is stored as a SHA-256 hash", () => {
  const secret = "a-long-random-per-connection-secret";
  const hash = hashWebhookSecret(secret);
  assert.equal(hash.length, 64);
  assert.equal(bearerSecretMatches(`Bearer ${secret}`, hash), true);
  assert.equal(bearerSecretMatches("Bearer wrong-secret", hash), false);
  assert.equal(bearerSecretMatches(secret, hash), false);
});

test("Bitable webhook payload requires a record id", () => {
  assert.throws(() => validateBitableWebhookPayload({ event_type: "record.updated" }), /record_id/);
});

test("Bitable webhook payload accepts only supported event types", () => {
  assert.throws(
    () => validateBitableWebhookPayload({ event_type: "unknown", record_id: "rec_123" }),
    /Unsupported event_type/,
  );
  assert.equal(
    validateBitableWebhookPayload({ event_type: "record.created", record_id: "rec_123" }).recordId,
    "rec_123",
  );
});

test("event key is deterministic for the same event", () => {
  const eventA = validateBitableWebhookPayload({
    event_type: "record.updated",
    record_id: "rec_123",
    modified_time: "2026-11-02T10:00:00Z",
    payload: { a: 1, b: 2 },
  });
  const eventB = validateBitableWebhookPayload({
    payload: { b: 2, a: 1 },
    modified_time: "2026-11-02T10:00:00Z",
    record_id: "rec_123",
    event_type: "record.updated",
  });
  assert.equal(makeBitableEventKey("connection-1", eventA), makeBitableEventKey("connection-1", eventB));
});
