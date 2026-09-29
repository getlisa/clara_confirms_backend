/**
 * Shared logging helpers for the notification pipeline.
 *
 * Every line in this pipeline is prefixed `[call-notification]` and carries
 * `retellCallId`, so one conversation's whole journey — webhook → queue → cron
 * → SendGrid — can be pulled out of the logs with a single grep:
 *
 *   grep 'call-notification' | grep call_abc123
 *
 * Two things are deliberately redacted before they reach log storage:
 *
 *   - Recipient addresses. Same convention as utils/email.js and auth.routes.js,
 *     which already log `foo***` rather than the whole address.
 *
 *   - The recording URL's query string. It is a SIGNED, unauthenticated link to
 *     a customer conversation — the same reason it never goes in an email is the
 *     reason it should not sit in a log file. Only the host and path are kept,
 *     which is all that is useful for debugging anyway.
 */

const PREFIX = "[call-notification]";

/** `erica@ultimatefire.test` → `erica@***` — enough to tell recipients apart. */
function maskEmail(email) {
  if (!email) return null;
  const str = String(email);
  const at = str.indexOf("@");
  if (at <= 0) return `${str.slice(0, 3)}***`;
  return `${str.slice(0, at)}@***`;
}

/** Host + path only — the signature and any credentials in the query are dropped. */
function maskUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(String(url));
    return `${u.host}${u.pathname}`;
  } catch {
    return String(url).split("?")[0].slice(0, 80);
  }
}

/** Elapsed ms since a Date.now() mark, for the timing fields. */
function since(startedAt) {
  return Date.now() - startedAt;
}

module.exports = { PREFIX, maskEmail, maskUrl, since };
