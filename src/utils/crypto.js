/**
 * Symmetric encryption for durable secrets we must be able to read back —
 * today, exactly one use: ZenTrades' per-tenant password (see
 * migrations/107_zentrades_integration.sql's header for why a password has
 * to be stored at all). No other CRM needs this: ServiceTrade uses one
 * global service account and stores only a session cookie, InspectPoint's
 * API key is itself the long-lived credential with nothing to decrypt back
 * into.
 *
 * There is no other symmetric encryption anywhere in this codebase —
 * engines/core/token.js's HMAC is for signing short-lived SSE tokens, not
 * for encrypting-and-recovering a secret. This is genuinely new.
 *
 * AES-256-GCM: authenticated encryption, so a tampered ciphertext or a
 * bit-flipped auth tag throws rather than silently decrypting to garbage —
 * important here because the output feeds straight into a live login call.
 *
 * Stored format: "v1:<iv-hex>:<authTag-hex>:<ciphertext-hex>" — versioned so
 * a future key-rotation or algorithm change doesn't require a schema change,
 * just a new prefix this module knows how to read.
 */

const crypto = require("crypto");

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit nonce, the standard/recommended size for GCM
const KEY_LENGTH = 32; // AES-256

let _key = null;

/**
 * Load and cache the encryption key. Deliberately NOT a "dev-...-change-me"
 * fallback the way engines/core/token.js's HMAC secret has one — a
 * predictable key silently applied to stored tenant passwords is worse than
 * the feature not existing at all. Missing/malformed key throws immediately,
 * at first use (effectively at startup, since the credentials module calls
 * this on every encrypt/decrypt), not silently at decrypt time with garbage
 * output.
 */
function getKey() {
  if (_key) return _key;
  const raw = process.env.CREDENTIAL_ENCRYPTION_KEY || "";
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(
      "CREDENTIAL_ENCRYPTION_KEY must be set to 64 hex characters (32 bytes) — " +
      "generate one with `node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"`"
    );
  }
  _key = Buffer.from(raw, "hex");
  return _key;
}

/**
 * @param {string} plaintext
 * @returns {string} "v1:<iv-hex>:<authTag-hex>:<ciphertext-hex>"
 */
function encrypt(plaintext) {
  if (typeof plaintext !== "string" || plaintext === "") {
    throw new Error("crypto.encrypt: plaintext must be a non-empty string");
  }
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `v1:${iv.toString("hex")}:${authTag.toString("hex")}:${ciphertext.toString("hex")}`;
}

/**
 * @param {string} stored — output of encrypt()
 * @returns {string} plaintext
 * @throws if the format is unrecognized, or the ciphertext/authTag were tampered with
 */
function decrypt(stored) {
  if (typeof stored !== "string") throw new Error("crypto.decrypt: stored value must be a string");
  const parts = stored.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("crypto.decrypt: unrecognized format (expected v1:<iv>:<authTag>:<ciphertext>)");
  }
  const [, ivHex, authTagHex, ciphertextHex] = parts;
  const key = getKey();
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const ciphertext = Buffer.from(ciphertextHex, "hex");
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}

module.exports = { encrypt, decrypt, KEY_LENGTH };
