/**
 * Wraps a URL in a third-party short link, for SMS bodies only.
 *
 * Why this exists: a carrier rejected our confirmation SMS with Twilio 30007
 * ("Carrier violation") purely because of the domain in the body. Controlled
 * tests showed the identical message delivered when the link was a
 * tinyurl.com one — and, importantly, that a da.gd link pointing at the SAME
 * blocked destination was still rejected. The carrier does not follow the
 * redirect; it judges the domain it can see. So this is not "shorten the URL",
 * it is "borrow a domain the carrier already trusts".
 *
 * Contract: `shorten()` NEVER throws and never blocks for long. A shortener
 * outage must degrade to sending the ordinary link, not lose a customer's
 * confirmation.
 */

const config = require("../config");
const logger = require("../utils/logger");

// This sits inline in the dispatch path, so it must fail fast. There are no
// timeouts anywhere else in this codebase's outbound fetches; a hung
// shortener would otherwise stall a whole sweep.
const TIMEOUT_MS = 4000;
const MAX_ATTEMPTS = 2;
const RETRY_BASE_MS = 300;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROVIDERS = {
  // No API key, no account. Returns the short URL as a bare text body, and on
  // rejection returns HTTP 200 with an error STRING — hence the shape check in
  // looksLikeUrl below rather than trusting the status code.
  tinyurl: (url) => `https://tinyurl.com/api-create.php?url=${encodeURIComponent(url)}`,
  clckru:  (url) => `https://clck.ru/--?url=${encodeURIComponent(url)}`,
};

function looksLikeUrl(text) {
  if (!text) return false;
  const t = String(text).trim();
  // Guards against the 200-with-an-error-string case ("Error", "Invalid URL",
  // a rate-limit notice) being pasted into an SMS as though it were a link.
  if (!/^https?:\/\/\S+$/i.test(t)) return false;
  if (t.length > 200) return false;
  return true;
}

/**
 * @param {string} url — the URL to wrap. Should be one WE control (the
 *   /c/<code> redirect), never a raw chat token: whatever is passed here ends
 *   up in a third party's permanent, public record.
 * @returns {Promise<string|null>} the short URL, or null to mean "send the
 *   original". Callers must handle null.
 */
async function shorten(url) {
  const provider = config.smsLinkMasking?.provider || "tinyurl";
  const build = PROVIDERS[provider];
  if (!build) {
    logger.warn("link-shortener: unknown provider, sending the plain URL", { provider });
    return null;
  }

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(build(url), {
        method: "GET",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const text = (await res.text()).trim();

      if (res.ok && looksLikeUrl(text)) {
        logger.info("link-shortener: shortened", { provider, short: text });
        return text;
      }
      // A 200 carrying an error string is not retryable — the URL itself was
      // rejected — but a 5xx or 429 is.
      if (res.ok) {
        logger.warn("link-shortener: provider rejected the URL, sending the plain URL", {
          provider, status: res.status, body: text.slice(0, 120),
        });
        return null;
      }
      logger.warn("link-shortener: provider error", { provider, status: res.status, attempt });
    } catch (err) {
      // AbortError (timeout) and network failures both land here.
      logger.warn("link-shortener: request failed", { provider, error: err.message, attempt });
    }
    if (attempt < MAX_ATTEMPTS - 1) await sleep(RETRY_BASE_MS * 2 ** attempt);
  }

  // Logged distinctly: a silent fallback would hide the shortener being down
  // while messages quietly went back to carrying the filterable domain.
  logger.warn("link-shortener: giving up, SMS will carry the unmasked URL", { provider, url });
  return null;
}

module.exports = { shorten, looksLikeUrl, PROVIDERS };
