/**
 * Short-lived HMAC tokens for SSE auth.
 *
 * Browser EventSource cannot set Authorization headers. So POST /engines/:kind
 * (authenticated via JWT) returns a `streamToken` bound to (runId, companyId)
 * with a 30-minute TTL. The client passes it on the SSE URL:
 *   GET /engines/:runId/stream?token=...
 *
 * Token format: base64url(payloadJSON) + "." + hex(hmacSha256(payload, secret))
 * Payload: { runId, companyId, exp }
 */

const crypto = require("crypto");

const SECRET = process.env.ENGINE_STREAM_SECRET
  || process.env.JWT_SECRET
  || "dev-engine-stream-secret-change-me";
const TTL_SECONDS = 30 * 60; // 30 minutes

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function fromB64url(s) {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function sign({ runId, companyId, ttlSeconds = TTL_SECONDS }) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = JSON.stringify({ runId: String(runId), companyId: Number(companyId), exp });
  const sig = crypto.createHmac("sha256", SECRET).update(payload).digest("hex");
  return `${b64url(payload)}.${sig}`;
}

function verify(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [payloadB64, sig] = token.split(".");
  let payload;
  try { payload = JSON.parse(fromB64url(payloadB64)); } catch { return null; }
  const expected = crypto.createHmac("sha256", SECRET).update(JSON.stringify(payload)).digest("hex");
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return null;
  }
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload; // { runId, companyId, exp }
}

module.exports = { sign, verify, TTL_SECONDS };
