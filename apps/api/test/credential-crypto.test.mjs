import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createCredentialCipher } from "../src/credential-crypto.mjs";

test("AES-256-GCM encrypts and decrypts a Feishu token", () => {
  const key = randomBytes(32).toString("base64");
  const cipher = createCredentialCipher(key);
  const encrypted = cipher.encrypt("test-access-token");
  assert.equal(cipher.decrypt(encrypted), "test-access-token");
  assert.notEqual(encrypted.ciphertext.toString("utf8"), "test-access-token");
});

test("AES-256-GCM rejects a wrong key", () => {
  const cipherA = createCredentialCipher(randomBytes(32).toString("base64"));
  const cipherB = createCredentialCipher(randomBytes(32).toString("base64"));
  const encrypted = cipherA.encrypt("secret");
  assert.throws(() => cipherB.decrypt(encrypted));
});

test("credential key must decode to exactly 32 bytes", () => {
  assert.throws(() => createCredentialCipher(randomBytes(16).toString("base64")), /32 bytes/);
});
