/**
 * Fetch a call recording from Retell so it can be ATTACHED to the notification
 * email — the mail client then plays it with its own player, in the inbox.
 *
 * Why an attachment and not a link: an <audio> tag is stripped by Gmail and
 * Outlook (only Apple Mail renders one), and Retell's URL must never go into an
 * email at all — it is an unauthenticated link to a customer conversation and
 * an email is forwardable. An attached audio file is the only thing that both
 * plays in place and keeps the URL server-side.
 *
 * What the recipient actually sees is NOT uniform, and product copy should not
 * claim otherwise:
 *   Gmail web/mobile  — attachment chip with a play button, plays in place
 *   Apple Mail        — inline player in the message body
 *   Outlook web       — attachment preview with a player
 *   Outlook desktop   — no inline player; click opens the default audio app
 */

const config = require("../../config");
const logger = require("../../utils/logger");
const { PREFIX, maskUrl, since } = require("./log");

// SendGrid's 30 MB ceiling applies to the BASE64 payload, which is ~1.33x the
// raw bytes. 12 MB raw lands near 16 MB encoded, leaving room for the HTML and
// the transcript. Env-overridable because the right number depends on Retell's
// actual encoding — see the verification notes in the frontend doc.
const MAX_BYTES = Number(process.env.RECORDING_ATTACH_MAX_BYTES) || 12 * 1024 * 1024;
const FETCH_TIMEOUT_MS = Number(process.env.RECORDING_FETCH_TIMEOUT_MS) || 20000;

/**
 * A player only appears if the MIME type is a real audio type AND the filename
 * extension agrees with it. Sent as application/octet-stream, every client
 * renders a dead paperclip instead — so the type comes from the response header
 * and the extension is derived FROM that type, never hardcoded.
 */
const TYPE_TO_EXT = {
  "audio/wav":      "wav",
  "audio/x-wav":    "wav",
  "audio/wave":     "wav",
  "audio/vnd.wave": "wav",
  "audio/mpeg":     "mp3",
  "audio/mp3":      "mp3",
  "audio/mp4":      "m4a",
  "audio/x-m4a":    "m4a",
  "audio/aac":      "aac",
  "audio/ogg":      "ogg",
  "audio/webm":     "webm",
  "audio/flac":     "flac",
};

/** Strip any `; charset=...` and normalise case before lookup. */
function baseType(contentType) {
  return String(contentType || "").split(";")[0].trim().toLowerCase();
}

/** Last-resort type when the server sends none, or sends octet-stream. */
function typeFromUrl(url) {
  const path = String(url || "").split("?")[0].toLowerCase();
  for (const [type, ext] of Object.entries(TYPE_TO_EXT)) {
    if (path.endsWith(`.${ext}`)) return type;
  }
  return null;
}

/**
 * Resolve the pair the attachment needs. Returns null when nothing audio-shaped
 * can be established — better to send the email with no attachment than with a
 * file no client will offer to play.
 */
function resolveAudioType(contentType, url) {
  const fromHeader = baseType(contentType);
  if (TYPE_TO_EXT[fromHeader]) return { contentType: fromHeader, ext: TYPE_TO_EXT[fromHeader] };

  const guessed = typeFromUrl(url);
  if (guessed) {
    logger.info(`${PREFIX} recording   → content-type unusable, inferred from the URL instead`, {
      header: fromHeader || "(none)", inferred: guessed, url: maskUrl(url),
    });
    return { contentType: guessed, ext: TYPE_TO_EXT[guessed] };
  }

  logger.warn(`${PREFIX} recording   → not a recognised audio type; no player would render, so sending without audio`, {
    header: fromHeader || "(none)", url: maskUrl(url),
  });
  return null;
}

/**
 * @typedef {object} RecordingFetch
 * @property {"ok"|"too_large"|"unavailable"|"bad_type"} status
 * @property {Buffer|null} buffer
 * @property {string|null} contentType
 * @property {string|null} ext
 * @property {number|null} bytes
 * @property {string|null} reason   human-readable, for last_error / the email's note
 *
 * `status` is what the drain branches on:
 *   ok          — attach it
 *   unavailable — transient; worth another attempt (Retell's S3 object can lag
 *                 the call_analyzed webhook, which is why delivery is deferred)
 *   too_large /
 *   bad_type    — permanent for this call; send now, without audio, and say so
 */
async function fetchRecording(recordingUrl) {
  const startedAt = Date.now();

  if (!recordingUrl) {
    logger.info(`${PREFIX} recording   → no URL stored for this call yet`);
    return { status: "unavailable", buffer: null, contentType: null, ext: null, bytes: null,
             reason: "No recording URL on the call yet" };
  }

  logger.info(`${PREFIX} recording   → downloading`, {
    url: maskUrl(recordingUrl), timeoutMs: FETCH_TIMEOUT_MS,
  });

  let res;
  try {
    res = await fetch(recordingUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    logger.warn(`${PREFIX} recording   → download failed (will be retried)`, {
      url: maskUrl(recordingUrl), error: err.message, ms: since(startedAt),
    });
    return { status: "unavailable", buffer: null, contentType: null, ext: null, bytes: null,
             reason: `Recording fetch failed: ${err.message}` };
  }

  if (!res.ok) {
    // A 403/404 here is usually Retell not having attached the object yet —
    // expected on the first pass, which is why this is warn and not error.
    logger.warn(`${PREFIX} recording   → upstream returned HTTP ${res.status} (will be retried)`, {
      url: maskUrl(recordingUrl), status: res.status, ms: since(startedAt),
    });
    return { status: "unavailable", buffer: null, contentType: null, ext: null, bytes: null,
             reason: `Recording fetch returned HTTP ${res.status}` };
  }

  // Refuse on the advertised length before reading the body, so an oversized
  // file is never pulled into memory at all.
  const advertised = Number(res.headers.get("content-length"));
  if (Number.isFinite(advertised) && advertised > MAX_BYTES) {
    logger.warn(`${PREFIX} recording   → too large to attach; refused before reading the body`, {
      url: maskUrl(recordingUrl), bytes: advertised, maxBytes: MAX_BYTES, ms: since(startedAt),
    });
    return { status: "too_large", buffer: null, contentType: null, ext: null, bytes: advertised,
             reason: `Recording is ${(advertised / 1048576).toFixed(1)} MB, over the ${(MAX_BYTES / 1048576).toFixed(0)} MB email limit` };
  }

  const audio = resolveAudioType(res.headers.get("content-type"), recordingUrl);
  if (!audio) {
    return { status: "bad_type", buffer: null, contentType: null, ext: null, bytes: null,
             reason: "Recording was not a recognised audio format" };
  }

  let buffer;
  try {
    buffer = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    logger.warn(`${PREFIX} recording   → body read failed (will be retried)`, {
      url: maskUrl(recordingUrl), error: err.message, ms: since(startedAt),
    });
    return { status: "unavailable", buffer: null, contentType: null, ext: null, bytes: null,
             reason: `Recording body read failed: ${err.message}` };
  }

  // Checked again: a chunked response carries no content-length to pre-screen.
  if (buffer.length > MAX_BYTES) {
    logger.warn(`${PREFIX} recording   → too large to attach (no content-length, caught after read)`, {
      url: maskUrl(recordingUrl), bytes: buffer.length, maxBytes: MAX_BYTES, ms: since(startedAt),
    });
    return { status: "too_large", buffer: null, contentType: null, ext: null, bytes: buffer.length,
             reason: `Recording is ${(buffer.length / 1048576).toFixed(1)} MB, over the ${(MAX_BYTES / 1048576).toFixed(0)} MB email limit` };
  }

  logger.info(`${PREFIX} recording   → downloaded OK`, {
    bytes: buffer.length, kb: Math.round(buffer.length / 1024),
    contentType: audio.contentType, ext: audio.ext, ms: since(startedAt),
  });
  return { status: "ok", buffer, contentType: audio.contentType, ext: audio.ext,
           bytes: buffer.length, reason: null };
}

/**
 * Ask Retell directly for the recording URL. The webhook payload types
 * recording_url as optional, so a call analysed before its recording was
 * attached has nothing stored — this is the second look, on a later drain pass.
 * Returns null on any failure; the caller just retries again later.
 */
async function lookupRecordingUrl(retellCallId) {
  if (!config.retell.apiKey) {
    logger.warn(`${PREFIX} recording   → cannot ask Retell for the URL: RETELL_API_KEY is not set`, { retellCallId });
    return null;
  }
  const startedAt = Date.now();
  logger.info(`${PREFIX} recording   → no stored URL, asking Retell directly`, { retellCallId });
  try {
    const { getClient } = require("../retell");
    const call = await getClient().call.retrieve(retellCallId);
    const url = call?.recording_url || null;
    logger.info(
      url ? `${PREFIX} recording   → Retell returned a URL` : `${PREFIX} recording   → Retell has no recording for this call yet`,
      { retellCallId, url: maskUrl(url), ms: since(startedAt) }
    );
    return url;
  } catch (err) {
    logger.warn(`${PREFIX} recording   → Retell lookup failed (will be retried)`, {
      retellCallId, error: err.message, ms: since(startedAt),
    });
    return null;
  }
}

module.exports = { fetchRecording, lookupRecordingUrl, resolveAudioType, MAX_BYTES, TYPE_TO_EXT };
