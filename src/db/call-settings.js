const db = require("./index");

const DEFAULT_VOICEMAIL_MESSAGE =
  "Hi, this is {{representative_name}} calling from {{company_name}}. " +
  "We were reaching out to confirm your upcoming appointment. " +
  "Please call us back at your earliest convenience. Thank you!";

const DEFAULTS = {
  business_hours_start:    "09:00",
  business_hours_end:      "17:00",
  max_attempts:            3,
  voicemail_behavior:      "leave",
  include_weekends:        false,
  alert_days_before:       2,
  voicemail_message:       DEFAULT_VOICEMAIL_MESSAGE,
  agent_can_make_changes:  true,
  auto_schedule_enabled:   true,
  auto_dispatch_enabled:   true,
  crm_comment_writeback_enabled: false,
  service_link_enabled:    false,
  channel_strategy:        "voice_only",
  sms_on_callback_enabled: false,
  chat_link_delivery_method: "email",
  job_confirmation_inference_enabled: false,
  // Contact types whose contacts become the default confirmation recipients.
  // Empty = off (today's behaviour). See migration 087.
  confirmation_contact_types: [],
};

function rowToSettings(row) {
  return {
    ...row,
    voicemail_message:      row.voicemail_message ?? DEFAULT_VOICEMAIL_MESSAGE,
    agent_can_make_changes: row.agent_can_make_changes ?? true,
    auto_schedule_enabled:  row.auto_schedule_enabled ?? true,
    auto_dispatch_enabled:  row.auto_dispatch_enabled ?? true,
    crm_comment_writeback_enabled: row.crm_comment_writeback_enabled ?? false,
    service_link_enabled:   row.service_link_enabled ?? false,
    channel_strategy:       row.channel_strategy ?? "voice_only",
    sms_on_callback_enabled: row.sms_on_callback_enabled ?? false,
    chat_link_delivery_method: row.chat_link_delivery_method ?? "email",
    job_confirmation_inference_enabled: row.job_confirmation_inference_enabled ?? false,
    confirmation_contact_types: row.confirmation_contact_types ?? [],
  };
}

const SELECT_COLS = `
  business_hours_start, business_hours_end, max_attempts,
  voicemail_behavior, include_weekends, alert_days_before,
  voicemail_message, agent_can_make_changes,
  auto_schedule_enabled, auto_dispatch_enabled,
  crm_comment_writeback_enabled, service_link_enabled,
  channel_strategy, sms_on_callback_enabled, chat_link_delivery_method,
  job_confirmation_inference_enabled,
  confirmation_contact_types
`;

async function getByCompanyId(companyId) {
  const result = await db.query(
    `SELECT ${SELECT_COLS} FROM call_settings WHERE company_id = $1`,
    [companyId]
  );
  return result.rows[0] ? rowToSettings(result.rows[0]) : { ...DEFAULTS };
}

/**
 * Values that must be stored canonically, applied HERE rather than in the
 * route: the copilot's update-call-settings tool calls upsert() directly, so
 * anything normalised only at the route would be stored raw when set by the
 * agent — and `confirmation_contact_types` is matched with an exact
 * comparison, so a stray capital or trailing space silently matches nobody.
 */
function normalizeValue(key, value) {
  if (key === "confirmation_contact_types" && Array.isArray(value)) {
    return [...new Set(
      value.filter((t) => typeof t === "string").map((t) => t.trim().toLowerCase()).filter(Boolean)
    )];
  }
  return value;
}

async function upsert(companyId, fields) {
  const allowed = [
    "business_hours_start", "business_hours_end", "max_attempts",
    "voicemail_behavior", "include_weekends", "alert_days_before",
    "voicemail_message", "agent_can_make_changes",
    "auto_schedule_enabled", "auto_dispatch_enabled",
    "crm_comment_writeback_enabled", "service_link_enabled",
    "channel_strategy", "sms_on_callback_enabled", "chat_link_delivery_method",
    "job_confirmation_inference_enabled",
    // TEXT[] — node-postgres serialises the JS array directly, so it needs no
    // special case in the generic parameter builder below (a jsonb column
    // would have; see migration 087).
    "confirmation_contact_types",
  ];
  const keys = Object.keys(fields).filter((k) => allowed.includes(k));
  if (keys.length === 0) return getByCompanyId(companyId);
  const setClauses = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
  const values = [companyId, ...keys.map((k) => normalizeValue(k, fields[k]))];
  const result = await db.query(
    `INSERT INTO call_settings (company_id, ${keys.join(", ")})
     VALUES ($1, ${keys.map((_, i) => `$${i + 2}`).join(", ")})
     ON CONFLICT (company_id) DO UPDATE SET ${setClauses}, updated_at = NOW()
     RETURNING ${SELECT_COLS}`,
    values
  );
  return rowToSettings(result.rows[0]);
}

module.exports = { getByCompanyId, upsert, DEFAULTS };
