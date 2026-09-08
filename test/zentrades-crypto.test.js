/**
 * src/utils/crypto.js — the only symmetric encryption in the codebase,
 * added specifically to store ZenTrades' per-tenant password at rest (see
 * migrations/107_zentrades_integration.sql's header for why a password has
 * to be stored at all, unlike ServiceTrade/InspectPoint).
 *
 * The module caches its key in a closure-level variable after first use, so
 * tests that need a FRESH read of CREDENTIAL_ENCRYPTION_KEY must clear
 * require.cache and re-require — done explicitly below rather than relying
 * on node:test's per-file process isolation to save us.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const MODULE_PATH = require.resolve("../src/utils/crypto");

function freshCrypto() {
  delete require.cache[MODULE_PATH];
  return require("../src/utils/crypto");
}

test("missing CREDENTIAL_ENCRYPTION_KEY throws at first use, not silently", () => {
  const original = process.env.CREDENTIAL_ENCRYPTION_KEY;
  delete process.env.CREDENTIAL_ENCRYPTION_KEY;
  const crypto = freshCrypto();
  assert.throws(() => crypto.encrypt("secret"), /CREDENTIAL_ENCRYPTION_KEY must be set/);
  if (original) process.env.CREDENTIAL_ENCRYPTION_KEY = original;
});

test("a malformed (non-64-hex-char) key throws instead of being silently truncated/padded", () => {
  const original = process.env.CREDENTIAL_ENCRYPTION_KEY;
  process.env.CREDENTIAL_ENCRYPTION_KEY = "not-hex-and-way-too-short";
  const crypto = freshCrypto();
  assert.throws(() => crypto.encrypt("secret"), /CREDENTIAL_ENCRYPTION_KEY must be set/);
  process.env.CREDENTIAL_ENCRYPTION_KEY = original;
});

test("encrypt/decrypt round-trips the exact plaintext", () => {
  process.env.CREDENTIAL_ENCRYPTION_KEY = "a".repeat(64);
  const crypto = freshCrypto();
  const plaintext = "correct horse battery staple !@#$ 日本語";
  const stored = crypto.encrypt(plaintext);
  assert.equal(crypto.decrypt(stored), plaintext);
});

test("stored format is versioned v1:<iv>:<authTag>:<ciphertext>, each part hex", () => {
  process.env.CREDENTIAL_ENCRYPTION_KEY = "a".repeat(64);
  const crypto = freshCrypto();
  const stored = crypto.encrypt("hello");
  const parts = stored.split(":");
  assert.equal(parts.length, 4);
  assert.equal(parts[0], "v1");
  for (const hex of parts.slice(1)) assert.match(hex, /^[0-9a-f]+$/);
});

test("two encryptions of the same plaintext produce different ciphertext (random IV)", () => {
  process.env.CREDENTIAL_ENCRYPTION_KEY = "a".repeat(64);
  const crypto = freshCrypto();
  const a = crypto.encrypt("same-password");
  const b = crypto.encrypt("same-password");
  assert.notEqual(a, b);
  assert.equal(crypto.decrypt(a), "same-password");
  assert.equal(crypto.decrypt(b), "same-password");
});

test("a tampered ciphertext byte is rejected (GCM authenticity), not silently decrypted to garbage", () => {
  process.env.CREDENTIAL_ENCRYPTION_KEY = "a".repeat(64);
  const crypto = freshCrypto();
  const stored = crypto.encrypt("hunter2");
  const [v, iv, authTag, ciphertext] = stored.split(":");
  const flippedLastByte = ciphertext.slice(0, -2) + (ciphertext.slice(-2) === "00" ? "ff" : "00");
  const tampered = [v, iv, authTag, flippedLastByte].join(":");
  assert.throws(() => crypto.decrypt(tampered));
});

test("a tampered auth tag is rejected", () => {
  process.env.CREDENTIAL_ENCRYPTION_KEY = "a".repeat(64);
  const crypto = freshCrypto();
  const stored = crypto.encrypt("hunter2");
  const [v, iv, authTag, ciphertext] = stored.split(":");
  const flipped = authTag.slice(0, -2) + (authTag.slice(-2) === "00" ? "ff" : "00");
  assert.throws(() => crypto.decrypt([v, iv, flipped, ciphertext].join(":")));
});

test("an unrecognized format is rejected outright", () => {
  process.env.CREDENTIAL_ENCRYPTION_KEY = "a".repeat(64);
  const crypto = freshCrypto();
  assert.throws(() => crypto.decrypt("not-the-right-format"));
  assert.throws(() => crypto.decrypt("v2:aa:bb:cc"), /unrecognized format/);
});

test("encrypt refuses an empty plaintext rather than storing a no-op secret", () => {
  process.env.CREDENTIAL_ENCRYPTION_KEY = "a".repeat(64);
  const crypto = freshCrypto();
  assert.throws(() => crypto.encrypt(""));
});
