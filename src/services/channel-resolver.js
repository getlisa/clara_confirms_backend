/**
 * Single choke point for deciding whether an outbound customer contact goes
 * out over voice or a chat link (email/sms/both). Every trigger/retry/callback
 * path resolves the channel through this one function instead of re-deriving
 * the logic.
 *
 * Per-customer flags (customers.is_voice/is_sms/is_email — migration 080)
 * replaced the single-valued preferred_channel because a customer can want
 * more than one channel at once. The combination rule (agreed with the
 * product owner):
 *   - is_voice=true  -> voice only, until every voice attempt is exhausted;
 *                       is_sms/is_email are pure fallback, never simultaneous
 *                       with a live voice attempt.
 *   - is_voice=false -> is_sms and is_email fire together (both are just
 *                       delivery methods for the same chat-link
 *                       confirmation — there is nothing to conflict).
 *
 * See /Users/Shivam/.claude/plans/zippy-weaving-flame.md for the case-by-case
 * rationale (no-answer fallback, sms-only companies, callback-to-chat).
 */

/**
 * @param {object} opts
 * @param {boolean} opts.smsLive                 — companies.sms_status === 'live'.
 *   Hard kill switch: an unapproved A2P account can never text, regardless of
 *   what the customer/company selected. Never blocks email.
 * @param {object} [opts.flags]                  — { is_voice, is_sms, is_email }
 *   from the customer row. Falls back to channelStrategy when the customer
 *   is unknown (e.g. no customers row yet) — flags are the source of truth
 *   once a customer exists.
 * @param {string} [opts.channelStrategy='voice_only'] — call_settings.channel_strategy.
 *   Only consulted when `flags` is omitted; kept for that fallback and to seed
 *   new-customer defaults. Not used to override a customer's own flags.
 * @param {boolean} [opts.voiceExhausted=false]  — true once voice retries are
 *   used up (scheduleRetry returned null because retry_count hit the cap) —
 *   this is what actually triggers the sms/email fallback for an is_voice
 *   customer.
 * @param {boolean} [opts.isCallback=false]      — true when scheduling a
 *   customer-requested callback (always voice — a callback is only ever
 *   requested during a live voice conversation).
 * @param {number} [opts.attemptNumber=1]        — kept for callers that still
 *   pass it; unused now that fallback is driven by voiceExhausted instead of
 *   attempt count, but harmless to receive.
 * @returns {{channel: "voice"|"web_chat", linkDelivery: "email"|"sms"|"both"|null}}
 */
function resolveOutboundChannel({
  smsLive,
  flags = null,
  channelStrategy = "voice_only",
  voiceExhausted = false,
  isCallback = false,
  attemptNumber = 1,
} = {}) {
  if (isCallback) return { channel: "voice", linkDelivery: null };

  // No customer flags on file (e.g. quotation/service-opportunity rows with
  // no customers join) — fall back to the old company-level strategy so
  // those paths keep working unchanged.
  if (!flags) {
    if (channelStrategy === "web_chat_only") return { channel: "web_chat", linkDelivery: "email" };
    if (!smsLive) return { channel: "voice", linkDelivery: null };
    if (channelStrategy === "sms_only") return { channel: "web_chat", linkDelivery: "sms" };
    if (channelStrategy === "voice_then_sms_fallback") {
      return attemptNumber > 1 ? { channel: "web_chat", linkDelivery: "sms" } : { channel: "voice", linkDelivery: null };
    }
    return { channel: "voice", linkDelivery: null };
  }

  const wantSms = !!flags.is_sms && smsLive; // smsLive is the A2P kill switch — never bypassed by a customer flag
  const wantEmail = !!flags.is_email;
  const linkDelivery = wantSms && wantEmail ? "both" : wantSms ? "sms" : wantEmail ? "email" : null;

  if (flags.is_voice && !voiceExhausted) {
    return { channel: "voice", linkDelivery }; // linkDelivery carried for the fallback, not used this attempt
  }

  if (linkDelivery) return { channel: "web_chat", linkDelivery };

  // Degenerate case: is_voice with voice exhausted and no sms/email on file,
  // or an sms-only customer at a company whose SMS isn't live — nothing left
  // to try but voice.
  return { channel: "voice", linkDelivery: null };
}

module.exports = { resolveOutboundChannel };
