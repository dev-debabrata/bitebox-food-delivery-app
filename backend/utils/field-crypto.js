import crypto from "node:crypto";
import { env } from "../config/env.js";

/**
 * Field encryption for sensitive numbers (bank accounts, licence and document numbers; Django:
 * common/crypto.py). AES-256-GCM with a random 12-byte nonce; stored as
 * "v1:" + base64(nonce + ciphertext + tag). The key is FIELD_ENCRYPTION_KEY (32 bytes, base64);
 * outside production it falls back to one derived from the JWT secret. Only the last 4 characters
 * are ever shown again.
 */
const PREFIX = "v1:";

function key() {
  if (env.fieldEncryptionKey) {
    const k = Buffer.from(env.fieldEncryptionKey, "base64");
    if (k.length !== 32) throw new Error("FIELD_ENCRYPTION_KEY must be 32 bytes, base64 encoded");
    return k;
  }
  return crypto.createHash("sha256").update(`field-encryption:${env.jwt.secret}`).digest();
}

export function encrypt(text) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), nonce);
  const sealed = Buffer.concat([cipher.update(text, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return PREFIX + Buffer.concat([nonce, sealed]).toString("base64");
}

export function decrypt(token) {
  if (!token.startsWith(PREFIX)) throw new Error("not an encrypted value");
  const raw = Buffer.from(token.slice(PREFIX.length), "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString("utf8");
}

export const last4 = (text) => text.slice(-4);
