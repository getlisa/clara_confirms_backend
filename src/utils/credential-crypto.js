/**
 * Symmetric encryption for third-party credentials we must be able to use
 * again unattended (today: the ServiceTrade password, so the backend can log
 * back in when ServiceTrade ends a session).
 *
 * AES-256-GCM with a random 96-bit IV per value; the auth tag makes any
 * tampering fail loudly on decrypt. Key: CREDENTIAL_ENCRYPTION_KEY, 32 bytes
 * as 64 hex chars. Stored format: "v1:<iv b64>:<tag b64>:<ciphertext b64>" —
 * the version prefix leaves room to rotate the scheme later.
 *
 * Never log the inputs or outputs of these functions.
 */

const crypto = require("crypto");

const VERSION = "v1";

function getKey() {
  const hex = process.env.CREDENTIAL_ENCRYPTION_KEY || "";
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    const err = new Error("CREDENTIAL_ENCRYPTION_KEY is missing or not 64 hex characters");
    err.code = "ENCRYPTION_KEY_MISSING";
    throw err;
  }
  return Buffer.from(hex, "hex");
}

function isConfigured() {
  try {
    getKey();
    return true;
  } catch {
    return false;
  }
}

function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(":");
}

function decrypt(payload) {
  const [version, ivB64, tagB64, dataB64] = String(payload || "").split(":");
  if (version !== VERSION || !ivB64 || !tagB64 || dataB64 === undefined) {
    throw new Error("Unrecognised encrypted credential format");
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", getKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
}

module.exports = { encrypt, decrypt, isConfigured };
