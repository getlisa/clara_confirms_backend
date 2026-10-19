const express = require("express");
const callSettingsDb = require("../db/call-settings");
const { authenticate, getCompanyId } = require("../auth");
const logger = require("../utils/logger");
const db = require("../db");
const retell = require("../services/retell");
const { getCompanyTimezone, localizeFields, formatArrivalStatement } = require("../utils/timezone");
const { requirePermission, requireDynamicPermission, permissionForCallType, PERMISSIONS: PERM } = require("../auth/permissions");

const router = express.Router();
router.use(authenticate);

const CALL_SETTINGS_TZ_FIELDS = ["created_at", "updated_at"];

/**
 * Push voicemail_message to the company's Retell agent after call settings change.
 * Resolves {{representative_name}} and {{company_name}} placeholders with real values.
 * - voicemail_behavior = 'leave' → set the resolved message on the agent
 * - voicemail_behavior = 'skip'  → set empty string (Retell detects voicemail, hangs up silently)
 */
async function syncVoicemailToRetell(companyId, settings) {
  try {
    const { rows } = await db.query(
      `SELECT c.retell_agent_id, c.name AS company_name, a.representative_name
       FROM companies c
       LEFT JOIN agent_settings a ON a.company_id = c.id
       WHERE c.id = $1`,
      [companyId]
    );
    const row = rows[0];
    if (!row?.retell_agent_id) return;

    let message = "";
    if (settings.voicemail_behavior === "leave") {
      const template = settings.voicemail_message || callSettingsDb.DEFAULTS.voicemail_message;
      message = template
        .replace(/\{\{representative_name\}\}/g, row.representative_name || "Clara")
        .replace(/\{\{company_name\}\}/g, row.company_name || "our company");
    }
    // empty string = detect voicemail but hang up without speaking

    const client = retell.getClient();
    await client.agent.update(row.retell_agent_id, { voicemail_message: message });
    logger.info("Voicemail message synced to Retell", { companyId, behavior: settings.voicemail_behavior });
  } catch (err) {
    logger.warn("syncVoicemailToRetell: failed (non-fatal)", { companyId, error: err.message });
  }
}

/**
 * GET /call-settings/arrival-preview?style=&minutes_before=&minutes_after=
 * The exact sentence Clara would say for a sample 11:00 AM visit, built by the
 * same function the agents use — so the settings page can show a live preview
 * without re-implementing the wording. Any omitted param uses the saved value.
 */
router.get("/arrival-preview", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });
    const saved = await callSettingsDb.getByCompanyId(companyId);
    const style = req.query.style ?? saved.arrival_time_style ?? "window";
    if (!callSettingsDb.ARRIVAL_TIME_STYLES.includes(style)) {
      return res.status(400).json({ error: `style must be one of ${callSettingsDb.ARRIVAL_TIME_STYLES.join(", ")}` });
    }
    const minutes = (v, fallback) => (v === undefined ? fallback : Number(v));
    const minutesBefore = minutes(req.query.minutes_before, saved.arrival_minutes_before ?? 0);
    const minutesAfter = minutes(req.query.minutes_after, saved.arrival_minutes_after ?? 60);
    for (const v of [minutesBefore, minutesAfter]) {
      if (!Number.isInteger(v) || v < 0 || v > 240) return res.status(400).json({ error: "minutes must be whole numbers from 0 to 240" });
    }
    // A fixed 11:00 AM in the company's own zone, so the preview reads like a real visit.
    const tz = await getCompanyTimezone(companyId);
    const sample = sampleElevenAm(tz);
    const a = formatArrivalStatement(sample, tz, { style, minutesBefore, minutesAfter });
    return res.json({ style, minutes_before: minutesBefore, minutes_after: minutesAfter, sample_time: "11:00 AM", statement: a.statement, label: a.label });
  } catch (err) {
    logger.error("GET /call-settings/arrival-preview failed", { error: err.message });
    return res.status(500).json({ error: "Failed to build the preview" });
  }
});

/** Tomorrow 11:00 AM local time in `tz`, as an ISO instant. */
function sampleElevenAm(tz) {
  const day = new Date(Date.now() + 86400000);
  const ymd = day.toLocaleDateString("en-CA", { timeZone: tz });            // YYYY-MM-DD
  const offsetMin = (() => {
    const at = new Date(`${ymd}T11:00:00Z`);
    const local = new Date(at.toLocaleString("en-US", { timeZone: tz }));
    const utc = new Date(at.toLocaleString("en-US", { timeZone: "UTC" }));
    return Math.round((utc - local) / 60000);
  })();
  return new Date(new Date(`${ymd}T11:00:00Z`).getTime() + offsetMin * 60000).toISOString();
}

router.get("/", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });
    const settings = await callSettingsDb.getByCompanyId(companyId);
    const tz = await getCompanyTimezone(companyId);
    return res.json({ call_settings: localizeFields(settings, tz, CALL_SETTINGS_TZ_FIELDS) });
  } catch (err) {
    logger.error("GET /call-settings failed", { error: err.message });
    return res.status(500).json({ error: "Failed to load call settings" });
  }
});

router.patch("/", requirePermission(PERM.SETTINGS_EDIT), async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });
    const { business_hours_start, business_hours_end, max_attempts, voicemail_behavior, voicemail_message, include_weekends, alert_days_before, agent_can_make_changes, auto_schedule_enabled, auto_dispatch_enabled, crm_comment_writeback_enabled, service_link_enabled, channel_strategy, sms_on_callback_enabled, chat_link_delivery_method, confirmation_contact_types, job_confirmation_inference_enabled, arrival_time_style, arrival_minutes_before, arrival_minutes_after } = req.body;
    const fields = {};
    if (business_hours_start !== undefined) fields.business_hours_start = business_hours_start;
    if (business_hours_end   !== undefined) fields.business_hours_end   = business_hours_end;
    if (include_weekends     !== undefined) fields.include_weekends     = Boolean(include_weekends);
    if (voicemail_behavior !== undefined) {
      if (!["leave", "skip"].includes(voicemail_behavior))
        return res.status(400).json({ error: "voicemail_behavior must be 'leave' or 'skip'" });
      fields.voicemail_behavior = voicemail_behavior;
    }
    if (max_attempts !== undefined) {
      const val = Number(max_attempts);
      if (!Number.isInteger(val) || val < 1 || val > 10)
        return res.status(400).json({ error: "max_attempts must be an integer between 1 and 10" });
      fields.max_attempts = val;
    }
    if (alert_days_before !== undefined) {
      const val = Number(alert_days_before);
      if (!Number.isInteger(val) || val < 1)
        return res.status(400).json({ error: "alert_days_before must be an integer >= 1" });
      fields.alert_days_before = val;
    }
    if (voicemail_message !== undefined) {
      if (typeof voicemail_message !== "string")
        return res.status(400).json({ error: "voicemail_message must be a string" });
      fields.voicemail_message = voicemail_message;
    }
    if (agent_can_make_changes !== undefined) {
      if (typeof agent_can_make_changes !== "boolean")
        return res.status(400).json({ error: "agent_can_make_changes must be a boolean" });
      fields.agent_can_make_changes = agent_can_make_changes;
    }
    if (auto_schedule_enabled !== undefined) {
      if (typeof auto_schedule_enabled !== "boolean")
        return res.status(400).json({ error: "auto_schedule_enabled must be a boolean" });
      fields.auto_schedule_enabled = auto_schedule_enabled;
    }
    if (auto_dispatch_enabled !== undefined) {
      if (typeof auto_dispatch_enabled !== "boolean")
        return res.status(400).json({ error: "auto_dispatch_enabled must be a boolean" });
      fields.auto_dispatch_enabled = auto_dispatch_enabled;
    }
    if (crm_comment_writeback_enabled !== undefined) {
      if (typeof crm_comment_writeback_enabled !== "boolean")
        return res.status(400).json({ error: "crm_comment_writeback_enabled must be a boolean" });
      fields.crm_comment_writeback_enabled = crm_comment_writeback_enabled;
    }
    // How Clara states the visit time (migration 116).
    if (arrival_time_style !== undefined) {
      if (!callSettingsDb.ARRIVAL_TIME_STYLES.includes(arrival_time_style))
        return res.status(400).json({ error: `arrival_time_style must be one of ${callSettingsDb.ARRIVAL_TIME_STYLES.join(", ")}` });
      fields.arrival_time_style = arrival_time_style;
    }
    const validMinutes = (v) => Number.isInteger(v) && v >= 0 && v <= 240;
    if (arrival_minutes_before !== undefined) {
      if (!validMinutes(arrival_minutes_before))
        return res.status(400).json({ error: "arrival_minutes_before must be a whole number of minutes from 0 to 240" });
      fields.arrival_minutes_before = arrival_minutes_before;
    }
    if (arrival_minutes_after !== undefined) {
      if (!validMinutes(arrival_minutes_after))
        return res.status(400).json({ error: "arrival_minutes_after must be a whole number of minutes from 0 to 240" });
      fields.arrival_minutes_after = arrival_minutes_after;
    }
    if (job_confirmation_inference_enabled !== undefined) {
      if (typeof job_confirmation_inference_enabled !== "boolean")
        return res.status(400).json({ error: "job_confirmation_inference_enabled must be a boolean" });
      fields.job_confirmation_inference_enabled = job_confirmation_inference_enabled;
    }
    if (service_link_enabled !== undefined) {
      if (typeof service_link_enabled !== "boolean")
        return res.status(400).json({ error: "service_link_enabled must be a boolean" });
      fields.service_link_enabled = service_link_enabled;
    }
    if (channel_strategy !== undefined) {
      if (!["voice_only", "sms_only", "voice_then_sms_fallback", "web_chat_only"].includes(channel_strategy))
        return res.status(400).json({ error: "channel_strategy must be 'voice_only', 'sms_only', 'voice_then_sms_fallback', or 'web_chat_only'" });
      fields.channel_strategy = channel_strategy;
    }
    if (sms_on_callback_enabled !== undefined) {
      if (typeof sms_on_callback_enabled !== "boolean")
        return res.status(400).json({ error: "sms_on_callback_enabled must be a boolean" });
      fields.sms_on_callback_enabled = sms_on_callback_enabled;
    }
    if (chat_link_delivery_method !== undefined) {
      if (!["email", "sms", "both"].includes(chat_link_delivery_method))
        return res.status(400).json({ error: "chat_link_delivery_method must be 'email', 'sms', or 'both'" });
      fields.chat_link_delivery_method = chat_link_delivery_method;
    }
    if (confirmation_contact_types !== undefined) {
      if (!Array.isArray(confirmation_contact_types) ||
          !confirmation_contact_types.every((t) => typeof t === "string" && t.trim() !== ""))
        return res.status(400).json({ error: "confirmation_contact_types must be an array of strings" });
      // Normalised on write (lower + trim + dedupe) so matching against
      // lower(btrim(type)) is an exact comparison rather than a per-row
      // transform of both sides. The source values are free text — company 9
      // alone has 140 distinct spellings, including trailing spaces and case
      // variants of the same label.
      fields.confirmation_contact_types = [
        ...new Set(confirmation_contact_types.map((t) => t.trim().toLowerCase())),
      ];
    }
    if (Object.keys(fields).length === 0)
      return res.status(400).json({ error: "No fields to update" });
    const settings = await callSettingsDb.upsert(companyId, fields);

    // Sync voicemail message to Retell whenever voicemail-related fields change
    const voicemailFields = ["voicemail_behavior", "voicemail_message"];
    if (voicemailFields.some(f => fields[f] !== undefined)) {
      syncVoicemailToRetell(companyId, settings).catch(() => {});
    }

    // Update the live Retell agent when a tool-affecting setting changes
    // (agent_can_make_changes, service_link_enabled, …): adds/removes the
    // matching tools and, for service_link_enabled, the SERVICE LINK block of
    // the confirmation prompt. Awaited, not fire-and-forget — on serverless
    // the function can be frozen once the response is sent, and the UI needs
    // to know whether the agent really changed. See TOOL_AFFECTING_SETTINGS.
    const { maybeResyncToolsAfterSettingsChange } = require("../services/retell-tools");
    const retellSync = await maybeResyncToolsAfterSettingsChange(companyId, Object.keys(fields));

    // No side effect needed for crm_comment_writeback_enabled — it's read live
    // per-company at call-analyzed time by the write-back service.

    const tz = await getCompanyTimezone(companyId);
    return res.json({ call_settings: localizeFields(settings, tz, CALL_SETTINGS_TZ_FIELDS), retell_sync: retellSync });
  } catch (err) {
    logger.error("PATCH /call-settings failed", { error: err.message });
    return res.status(500).json({ error: "Failed to update call settings" });
  }
});

/**
 * GET /call-settings/contact-types
 *
 * Options for the confirmation_contact_types picker: every distinct contact
 * type this company actually has, with how many contacts carry it.
 *
 * Not a fixed enum — these are free-text labels from the CRM and differ per
 * company (company 9 alone has 140 distinct values). The counts matter because
 * the values are inconsistent: "maintenance" and "Maintenace" both exist, as do
 * "on-site" and "onsite", so a user needs to see and select each variant they
 * care about. Normalised the same way the setting is stored, so what's returned
 * here can be sent straight back in the PATCH.
 */
router.get("/contact-types", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const { rows } = await db.query(
      `SELECT lower(btrim(t)) AS type, count(DISTINCT c.id)::int AS contact_count
         FROM contacts c, jsonb_array_elements_text(c.types) t
        WHERE c.company_id = $1 AND btrim(t) <> ''
          AND c.status IS DISTINCT FROM 'inactive'
        GROUP BY 1
        ORDER BY contact_count DESC, type`,
      [companyId]
    );
    return res.json({ contact_types: rows });
  } catch (err) {
    logger.error("GET /call-settings/contact-types failed", { error: err.message });
    return res.status(500).json({ error: "Failed to load contact types" });
  }
});

module.exports = router;
