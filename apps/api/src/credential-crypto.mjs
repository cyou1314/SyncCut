import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const NONCE_BYTES = 12;
const KEY_BYTES = 32;

function decodeKey(base64Key) {
  if (typeof base64Key !== "string" || !base64Key.trim()) {
    throw new Error("SYNC_CREDENTIAL_ENCRYPTION_KEY is required.");
  }
  const key = Buffer.from(base64Key, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error("SYNC_CREDENTIAL_ENCRYPTION_KEY must decode to exactly 32 bytes.");
  }
  return key;
}

export function createCredentialCipher(base64Key) {
  const key = decodeKey(base64Key);
  return {
    encrypt(plaintext) {
      if (typeof plaintext !== "string") throw new TypeError("plaintext must be a string.");
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv(ALGORITHM, key, nonce);
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return { ciphertext, nonce, tag: cipher.getAuthTag() };
    },
    decrypt({ ciphertext, nonce, tag }) {
      if (!Buffer.isBuffer(ciphertext) || !Buffer.isBuffer(nonce) || !Buffer.isBuffer(tag)) {
        throw new TypeError("ciphertext, nonce and tag must be Buffers.");
      }
      const decipher = createDecipheriv(ALGORITHM, key, nonce);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    },
  };
}
