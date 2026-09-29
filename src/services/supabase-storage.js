/**
 * Minimal Supabase Storage client — upload / download / remove / stat.
 *
 * Deliberately plain `fetch` against the Storage REST API rather than
 * @supabase/supabase-js: this is four endpoints, the project already has no
 * Supabase SDK dependency, and every other outbound HTTP call in this codebase
 * (servicetrade.js, inspectpoint.js, link-shortener.js) is written the same way.
 *
 * Authenticated with the SERVICE ROLE key, so it bypasses RLS entirely. That is
 * correct here and also why nothing in this module may ever be reachable from a
 * browser: buckets are private, and the only public path to their contents is
 * GET /calls/:id/recording, which authorises the caller first.
 */

const config = require("../config");
const logger = require("../utils/logger");
const { fetchStreaming } = require("../utils/streaming-fetch");

const TIMEOUT_MS = Number(process.env.SUPABASE_STORAGE_TIMEOUT_MS) || 30000;

function storageBase() {
  if (!config.supabase.url) return null;
  return `${String(config.supabase.url).replace(/\/+$/, "")}/storage/v1`;
}

/**
 * Whether storage is usable at all. Callers check this and degrade gracefully —
 * a missing key must never turn into a crash in a webhook or a cron sweep.
 */
function isConfigured() {
  return !!(config.supabase.url && config.supabase.serviceRoleKey);
}

function authHeaders() {
  return {
    Authorization: `Bearer ${config.supabase.serviceRoleKey}`,
    apikey: config.supabase.serviceRoleKey,
  };
}

/** Object keys are built from ids, but never trust them into a path traversal. */
function assertSafePath(objectPath) {
  const p = String(objectPath || "");
  if (!p || p.startsWith("/") || p.includes("..")) {
    throw new Error(`Unsafe storage object path: ${p}`);
  }
  return p;
}

function encodePath(objectPath) {
  return assertSafePath(objectPath).split("/").map(encodeURIComponent).join("/");
}

/**
 * Store bytes at `objectPath`, overwriting any existing object.
 *
 * `x-upsert: true` makes a re-archive idempotent: a sweep that uploaded the
 * object but crashed before stamping the row will simply overwrite the same
 * bytes next pass, rather than erroring on a duplicate.
 *
 * @returns {Promise<{ok: boolean, status: number, error: string|null}>}
 */
async function upload(bucket, objectPath, body, contentType) {
  if (!isConfigured()) {
    return { ok: false, status: 0, error: "Supabase storage is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)" };
  }
  const url = `${storageBase()}/object/${encodeURIComponent(bucket)}/${encodePath(objectPath)}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        ...authHeaders(),
        "Content-Type": contentType || "application/octet-stream",
        "x-upsert": "true",
      },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return { ok: false, status: res.status, error: `Storage upload failed: HTTP ${res.status} ${detail.slice(0, 300)}` };
    }
    return { ok: true, status: res.status, error: null };
  } catch (err) {
    return { ok: false, status: 0, error: `Storage upload failed: ${err.message}` };
  }
}

/**
 * Fetch an object. Returns the raw Response so a caller can either buffer it
 * (the email attachment) or stream it through (the portal player), and can
 * forward Range for seeking.
 *
 * The timeout covers the RESPONSE only, not the body: a total timeout would
 * abort a large-but-healthy download mid-transfer, which crashed the process
 * when those bytes were being piped to a client. See utils/streaming-fetch.js.
 *
 * @returns {Promise<Response|null>} null when storage is unconfigured or the request threw
 */
async function download(bucket, objectPath, { range = null } = {}) {
  if (!isConfigured()) return null;
  const url = `${storageBase()}/object/${encodeURIComponent(bucket)}/${encodePath(objectPath)}`;
  try {
    const { response } = await fetchStreaming(url, {
      headers: { ...authHeaders(), ...(range ? { Range: range } : {}) },
      responseTimeoutMs: TIMEOUT_MS,
    });
    return response;
  } catch (err) {
    logger.warn("supabase-storage: download threw", { bucket, error: err.message });
    return null;
  }
}

/** Delete one object. A 404 counts as success — the goal is "it is gone". */
async function remove(bucket, objectPath) {
  if (!isConfigured()) {
    return { ok: false, status: 0, error: "Supabase storage is not configured" };
  }
  const url = `${storageBase()}/object/${encodeURIComponent(bucket)}/${encodePath(objectPath)}`;
  try {
    const res = await fetch(url, {
      method: "DELETE",
      headers: authHeaders(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok && res.status !== 404) {
      const detail = await res.text().catch(() => "");
      return { ok: false, status: res.status, error: `Storage delete failed: HTTP ${res.status} ${detail.slice(0, 300)}` };
    }
    return { ok: true, status: res.status, error: null };
  } catch (err) {
    return { ok: false, status: 0, error: `Storage delete failed: ${err.message}` };
  }
}

/** Does the object exist? Used to verify an archive without pulling the bytes. */
async function exists(bucket, objectPath) {
  if (!isConfigured()) return false;
  const url = `${storageBase()}/object/${encodeURIComponent(bucket)}/${encodePath(objectPath)}`;
  try {
    const res = await fetch(url, {
      method: "HEAD",
      headers: authHeaders(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

module.exports = { isConfigured, upload, download, remove, exists, assertSafePath };
