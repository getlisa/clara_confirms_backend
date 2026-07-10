/**
 * Backend onboarding orchestration.
 *
 * Moves the previously frontend-driven new-company setup server-side: one call
 * runs every step in order and ends with a single AWAITED Retell provision.
 * Uses the NEW model (campaigns; no call_type_configs/call_trigger_configs).
 *
 * runOnboarding is re-runnable (all upserts). Each step is best-effort and
 * collects errors rather than aborting, so partial progress is never lost and a
 * failing Retell provision (e.g. missing creds) still returns 200 with status.
 */

const db = require("../db");
const campaignsDb = require("../db/campaigns");
const agentSettingsDb = require("../db/agent-settings");
const callSettingsDb = require("../db/call-settings");
const retell = require("./retell");
const { syncFlowForCompany } = require("./retell-flow");
const { getPrimaryAreaCode } = require("../utils/area-code");
const { inviteUser } = require("./user-invite");
const logger = require("../utils/logger");

const CALL_SETTINGS_FIELDS = [
  "business_hours_start", "business_hours_end", "include_weekends", "voicemail_behavior",
  "max_attempts", "alert_days_before", "voicemail_message", "agent_can_make_changes",
  "auto_schedule_enabled", "auto_dispatch_enabled",
];

async function updateCompanyProfile(companyId, c) {
  const updates = [];
  const values = [];
  let i = 1;
  const set = (col, val) => { updates.push(`${col} = $${i++}`); values.push(val); };

  if (c.name !== undefined)             set("name", String(c.name).trim());
  if (c.default_timezone !== undefined) set("default_timezone", String(c.default_timezone).trim());
  if (c.address_line1 !== undefined)    set("address_line1", String(c.address_line1).trim() || null);
  if (c.city !== undefined)             set("city", String(c.city).trim() || null);
  if (c.state !== undefined)            set("state", String(c.state).trim() || null);
  if (c.zipcode !== undefined)          set("zipcode", String(c.zipcode).trim() || null);
  if (c.country !== undefined)          set("country", String(c.country).trim() || null);

  // office_area_code: explicit wins; else derive from state (mirrors PATCH /company).
  if (c.office_area_code !== undefined) {
    const code = parseInt(c.office_area_code, 10);
    if (isNaN(code) || code < 200 || code > 999) {
      throw Object.assign(new Error("office_area_code must be a valid 3-digit area code"), { status: 400 });
    }
    set("office_area_code", code);
  } else if (c.state) {
    const derived = getPrimaryAreaCode(String(c.state).trim());
    if (derived) set("office_area_code", derived);
  }

  if (updates.length === 0) return;
  values.push(companyId);
  await db.query(`UPDATE companies SET ${updates.join(", ")}, updated_at = NOW() WHERE id = $${i}`, values);
}

async function runOnboarding(companyId, payload = {}, invitedBy = null) {
  const result = { steps: {}, campaigns: [], invited: [], retell: null, errors: [] };

  // 1. Company profile + area code
  if (payload.company) {
    try {
      await updateCompanyProfile(companyId, payload.company);
      result.steps.company_profile = true;
    } catch (err) {
      result.errors.push({ step: "company", error: err.message });
    }
  }

  // 2. Agent identity
  if (payload.agent) {
    try {
      const fields = {};
      if (payload.agent.representative_name !== undefined) {
        fields.representative_name = payload.agent.representative_name;
      }
      if (payload.agent.voice_id !== undefined && payload.agent.voice_id !== null) {
        const ok = await retell.isVoiceIdValid(payload.agent.voice_id);
        if (!ok) throw Object.assign(new Error(`Unknown voice_id '${payload.agent.voice_id}'`), { status: 400 });
        fields.voice_id = payload.agent.voice_id;
      }
      if (Object.keys(fields).length > 0) await agentSettingsDb.upsert(companyId, fields);
      result.steps.agent_identity = true;
    } catch (err) {
      result.errors.push({ step: "agent", error: err.message });
    }
  }

  // 3. Call settings
  if (payload.call_settings) {
    try {
      const fields = {};
      for (const k of CALL_SETTINGS_FIELDS) {
        if (payload.call_settings[k] !== undefined) fields[k] = payload.call_settings[k];
      }
      if (Object.keys(fields).length > 0) await callSettingsDb.upsert(companyId, fields);
      result.steps.call_settings = true;
    } catch (err) {
      result.errors.push({ step: "call_settings", error: err.message });
    }
  }

  // 4. Campaigns (enable + configure). FE field names → columns.
  if (Array.isArray(payload.campaigns)) {
    for (const c of payload.campaigns) {
      try {
        const patch = {};
        if (c.enabled !== undefined)     patch.enabled           = c.enabled;
        if (c.days_before !== undefined) patch.days_before       = c.days_before;
        if (c.name !== undefined)        patch.name              = c.name;
        if (c.greeting !== undefined)    patch.begin_message     = c.greeting;
        if (c.prompt !== undefined)      patch.general_prompt    = c.prompt;
        if (c.voicemail !== undefined)   patch.voicemail_message = c.voicemail;
        if (c.config !== undefined)      patch.trigger_config    = c.config;
        const updated = await campaignsDb.upsert(companyId, c.key, patch);
        result.campaigns.push({ key: updated.key, enabled: updated.enabled });
      } catch (err) {
        result.errors.push({ step: `campaign:${c.key}`, error: err.message });
      }
    }
  }

  // 5. Retell provision — AWAITED, non-fatal. Runs after profile+campaigns so
  //    office_area_code + enabled campaigns exist (phone purchase needs area code).
  try {
    const prov = await syncFlowForCompany(companyId);
    result.retell = prov
      ? { flow_id: prov.flowId, agent_id: prov.agentId, phone_number: prov.phoneNumber }
      : null; // null = no enabled campaigns yet
  } catch (err) {
    result.errors.push({ step: "retell_provision", error: err.message });
    logger.warn("onboarding: Retell provision failed (non-fatal)", { companyId, error: err.message });
  }

  // 6. Invites
  if (Array.isArray(payload.invites)) {
    for (const inv of payload.invites) {
      try {
        const u = await inviteUser(companyId, inv, invitedBy);
        result.invited.push({ id: u.id, email: u.email });
      } catch (err) {
        result.errors.push({ step: `invite:${inv?.email ?? "?"}`, error: err.message });
      }
    }
  }

  // 7. Completion — mark when operational (provisioned + phone) or explicitly requested.
  const pre = await getOnboardingStatus(companyId);
  if (payload.mark_complete === true || (pre.retell_provisioned && pre.phone_number_set)) {
    await db.query(
      `UPDATE companies SET onboarding_completed_at = COALESCE(onboarding_completed_at, NOW()), updated_at = NOW() WHERE id = $1`,
      [companyId]
    );
  }

  result.status = await getOnboardingStatus(companyId);
  return result;
}

async function getOnboardingStatus(companyId) {
  const { rows: [co] } = await db.query(
    `SELECT default_timezone, office_area_code, retell_agent_id, retell_conversation_flow_id,
            retell_phone_number, onboarding_completed_at
     FROM companies WHERE id = $1`,
    [companyId]
  );
  const { rows: [ag] } = await db.query(
    `SELECT representative_name, voice_id FROM agent_settings WHERE company_id = $1`,
    [companyId]
  );
  const { rows: [cc] } = await db.query(
    `SELECT count(*) FILTER (WHERE enabled) AS enabled FROM campaigns WHERE company_id = $1`,
    [companyId]
  );
  const enabledCount = Number(cc?.enabled ?? 0);

  return {
    company_profile:        !!(co && co.default_timezone && co.office_area_code),
    agent_identity:         !!(ag && (ag.representative_name || ag.voice_id)),
    campaigns_enabled:      enabledCount > 0,
    enabled_campaign_count: enabledCount,
    retell_provisioned:     !!(co && co.retell_agent_id && co.retell_conversation_flow_id),
    phone_number_set:       !!(co && co.retell_phone_number),
    completed:              !!(co && co.onboarding_completed_at),
  };
}

module.exports = { runOnboarding, getOnboardingStatus };
