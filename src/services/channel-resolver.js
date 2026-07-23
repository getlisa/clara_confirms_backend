/**
 * Single choke point for deciding whether an outbound customer contact goes
 * out over voice or SMS/chat. Every trigger/retry/callback path resolves the
 * channel through this one function instead of re-deriving the logic.
 *
 * See /Users/Shivam/.claude/plans/zippy-weaving-flame.md for the case-by-case
 * rationale (no-answer fallback, sms-only companies, per-customer override,
 * callback-to-chat).
 */

/**
 * @param {object} opts
 * @param {boolean} opts.smsLive               — companies.sms_status === 'live'
 * @param {string|null} [opts.preferredChannel] — customers.preferred_channel ('voice'|'sms'|null)
 * @param {string} opts.channelStrategy         — call_settings.channel_strategy
 * @param {number} [opts.attemptNumber=1]       — 1 for the first attempt, 2+ for retries
 * @param {boolean} [opts.isCallback=false]     — true when scheduling a customer-requested callback
 * @param {boolean} [opts.smsOnCallbackEnabled=false] — call_settings.sms_on_callback_enabled
 * @returns {"voice"|"sms"}
 */
function resolveOutboundChannel({
  smsLive,
  preferredChannel = null,
  channelStrategy = "voice_only",
  attemptNumber = 1,
  isCallback = false,
  smsOnCallbackEnabled = false,
}) {
  // Hard safety net — never depends on the UI having blocked an invalid state.
  // If SMS isn't actually live for this company, every path falls back to voice.
  if (!smsLive) return "voice";

  if (isCallback) {
    return smsOnCallbackEnabled ? "sms" : (preferredChannel || "voice");
  }

  if (preferredChannel) return preferredChannel;

  if (channelStrategy === "sms_only") return "sms";
  if (channelStrategy === "voice_then_sms_fallback") {
    return attemptNumber > 1 ? "sms" : "voice";
  }
  return "voice";
}

module.exports = { resolveOutboundChannel };
