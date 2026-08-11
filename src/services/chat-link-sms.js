/**
 * Sends the confirmation chat-link SMS — the Twilio-backed counterpart to
 * chat-link-email.js. Same link (`chat_links` token, same GET/POST/reopen
 * flow), delivered by text instead of email — a plain text with a URL, NOT
 * a live Retell agent<->customer conversation. Used both by the "web_chat"
 * channel's sms delivery method and by the plain "sms" channel (which used
 * to start a live Retell conversation via createSmsChat — that's disabled
 * for now in favor of this link-based send; see scheduler.js).
 *
 * Built on src/utils/sms.js — inherits the same no-op-if-unconfigured
 * behavior (sendSms logs and returns true when Twilio isn't set up).
 *
 * TWO THINGS HERE ARE NOT COSMETIC.
 *
 * 1. The link is masked. A carrier rejected this exact message with Twilio
 *    30007 ("Carrier violation") because of our domain; the identical text
 *    carrying a tinyurl.com link was delivered. See link-shortener.js.
 *
 * 2. The body is forced into GSM-7. SMS has no markup — no HTML, no CSS — and
 *    a single character outside GSM-7 (an em dash, a curly quote, an emoji)
 *    switches the whole message to UCS-2, which drops the per-segment limit
 *    from 160 characters to 70. Measured on this message: masked + plain text
 *    is 153 chars = ONE segment; the same text with one em dash is 92 chars
 *    but TWO. Company and job names come from the CRM as free text, so a
 *    single stray dash in a company name would silently double the cost of
 *    every message that company sends.
 */

const { sendSms } = require("../utils/sms");
const { buildChatLinkUrl } = require("./chat-link-email");
const chatLinksDb = require("../db/chat-links");
const { shorten, warnIfLikelyMonetisedHost } = require("./link-shortener");
const config = require("../config");
const logger = require("../utils/logger");

// Characters that routinely arrive in CRM text and have an obvious GSM-7
// equivalent. Anything still outside the alphabet after this is dropped rather
// than silently promoting the message to UCS-2.
const GSM7_REPLACEMENTS = [
  [/[‐-―]/g, "-"],   // hyphens, en/em dashes
  [/[‘’‚‛]/g, "'"],
  [/[“”„‟]/g, '"'],
  [/…/g, "..."],
  [/[   ]/g, " "], // non-breaking spaces
  [/[•·]/g, "-"],
];

const GSM7_CHARS =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡" +
  "ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM7_EXTENDED = "^{}\\[~]|€";

/**
 * Coerce free text to something GSM-7 can carry. Exported for tests — the
 * segment-count consequence is the reason this exists, so it gets asserted.
 */
function toGsm7(text) {
  if (!text) return "";
  let out = String(text);
  for (const [pattern, replacement] of GSM7_REPLACEMENTS) out = out.replace(pattern, replacement);
  return [...out]
    .filter((ch) => GSM7_CHARS.includes(ch) || GSM7_EXTENDED.includes(ch))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The URL to put in the SMS: a short link wrapping our own /c/<code> redirect.
 *
 * Falls back to the ordinary chat URL whenever anything is missing or fails —
 * masking is a deliverability optimisation, and a confirmation must never be
 * lost because a shortener was down.
 *
 * The shortener is only ever handed the /c/<code> URL, never the chat token:
 * whatever goes to a third party lands in their permanent public record, and
 * the token is the auth credential for the customer's conversation.
 */
async function buildSmsLinkUrl(token, link) {
  const plain = buildChatLinkUrl(token);
  const cfg = config.smsLinkMasking || {};

  if (!cfg.enabled) return plain;
  if (!cfg.publicApiUrl) {
    logger.warn("chat-link-sms: PUBLIC_API_URL unset — sending the unmasked link");
    return plain;
  }
  // Names the likely cause when masking keeps falling back — a raw platform
  // hostname gets the short link wrapped in an affiliate redirect, which
  // resolvesCleanlyTo() then rejects.
  warnIfLikelyMonetisedHost(cfg.publicApiUrl);

  if (!link?.id) return plain;

  // Already shortened on an earlier send/retry.
  if (link.short_url) return link.short_url;

  let code = link.short_code;
  if (!code) {
    const claimed = await chatLinksDb.claimShortCode(link.id, chatLinksDb.generateShortCode());
    // null = a concurrent send won the race; use the code that landed rather
    // than minting a second public entry point to the same conversation.
    code = claimed?.short_code || (await chatLinksDb.getByToken(token))?.short_code;
  }
  if (!code) return plain;

  // shorten() documents that it never throws, but this is the one call in the
  // path whose failure would cost a customer their confirmation, so the caller
  // does not rely on that promise being kept.
  const short = await shorten(`${cfg.publicApiUrl}/c/${code}`).catch((err) => {
    logger.warn("chat-link-sms: shortener threw, sending the unmasked link", { error: err.message });
    return null;
  });
  if (!short) return plain;

  await chatLinksDb.setShortUrl(link.id, short).catch((err) =>
    // Caching is an optimisation; failing to cache must not fail the send.
    logger.warn("chat-link-sms: could not cache short_url", { error: err.message })
  );
  return short;
}

/**
 * @param {object} params
 * @param {string} params.phone        — recipient, E.164
 * @param {string|null} params.customerName
 * @param {string} params.companyName
 * @param {string|null} params.jobName
 * @param {string} params.token        — chat_links token
 * @param {object|null} [params.link]  — the chat_links row, when the caller has
 *   it. Without it the link cannot be masked and the plain URL is sent.
 * @returns {Promise<boolean>} whether the send succeeded (mirrors sendSms's return)
 */
async function sendConfirmationLinkSms({ phone, customerName, companyName, jobName, token, link = null }) {
  const row = link || (await chatLinksDb.getByToken(token).catch(() => null));
  const url = await buildSmsLinkUrl(token, row);

  const name = toGsm7(customerName);
  const company = toGsm7(companyName);
  const job = toGsm7(jobName);

  const greeting = name ? `Hi ${name}, ` : "Hi, ";
  const jobPhrase = job ? ` for ${job}` : "";
  const body = `${greeting}please confirm your upcoming appointment${jobPhrase} with ${company}. Confirm here: ${url}`;

  const sent = await sendSms({ to: phone, body });

  logger.info("chat-link-sms: confirmation sms sent", {
    jobName, sent, masked: url !== buildChatLinkUrl(token), bodyLength: body.length,
  });
  return sent;
}

module.exports = { sendConfirmationLinkSms, toGsm7, buildSmsLinkUrl };
