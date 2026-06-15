/**
 * Manual call orchestrator.
 *
 * Used by POST /calls/manual when a user clicks "Call now" on a customer/
 * appointment/quotation. The UI passes only the call_type + target_id; this
 * module loads the same data the scheduler would have loaded, runs the same
 * dedup, queues the row in `scheduled_calls`, and (by default) pokes the
 * dispatcher to fire it within the same HTTP request.
 *
 * Manual path contract differs from the cron path:
 *   - Missing phone → 422 to the caller (NOT a MISSING_PHONE todo). The user
 *     is actively trying to make the call; they need an actionable error.
 *   - Office hours are bypassed when immediate=true. User clicked the button;
 *     intent is now.
 *   - is_test is always false. This is a real call.
 */

const { HYDRATORS, TARGET_FIELD } = require("./call-hydration");
const scheduledCallsDb = require("../db/scheduled-calls");
const callSettingsDb = require("../db/call-settings");
const scheduler = require("./scheduler");
const db = require("../db");
const logger = require("../utils/logger");

const VALID_TRIGGER_TYPES = Object.keys(HYDRATORS);

/**
 * @param {object} args
 * @param {number} args.companyId
 * @param {string} args.triggerType                — one of the 4 functional kinds (matches call_trigger_configs.trigger_type)
 * @param {number} [args.appointmentId]
 * @param {string|number} [args.jobId]
 * @param {number} [args.quotationId]
 * @param {boolean} [args.immediate=true]
 * @param {boolean} [args.force=false]
 * @param {string}  [args.scheduledAt]
 * @returns {Promise<{ok:boolean, status:number, scheduledCall?, dialed?, retellCallId?, error?}>}
 */
async function triggerManualCall({
  companyId, triggerType,
  appointmentId, jobId: rawJobId, quotationId,
  immediate = true, force = false, scheduledAt = null,
}) {
  // ── 1. Validate trigger_type and resolve the company's configured call_type ─
  if (!triggerType || !VALID_TRIGGER_TYPES.includes(triggerType)) {
    return { ok: false, status: 400, error: `Invalid trigger_type. Must be one of: ${VALID_TRIGGER_TYPES.join(", ")}` };
  }

  const { rows: trigRows } = await db.query(
    `SELECT call_type FROM call_trigger_configs WHERE company_id = $1 AND trigger_type = $2 LIMIT 1`,
    [companyId, triggerType]
  );
  if (trigRows.length === 0) {
    return { ok: false, status: 400, error: `trigger_type '${triggerType}' is not configured for this company` };
  }
  const callType = trigRows[0].call_type;

  // Pick the right target_id for the trigger_type.
  const targetField = TARGET_FIELD[triggerType];
  const targetId =
    targetField === "appointment_id" ? appointmentId :
    targetField === "job_id"         ? rawJobId :
    targetField === "quotation_id"   ? quotationId : null;

  if (targetId == null) {
    return { ok: false, status: 400, error: `trigger_type '${triggerType}' requires ${targetField}` };
  }

  // ── 2. Hydrate from DB ─────────────────────────────────────────────────────
  const hydrated = await HYDRATORS[triggerType](companyId, targetId);
  if (!hydrated.ok) return hydrated;
  // Override the hydrator's placeholder call_type with the company's configured one.
  hydrated.params.callType = callType;

  // ── 3. Dedup (unless forced) ───────────────────────────────────────────────
  if (force) {
    // User explicitly chose to override — cancel any in-flight row for the same
    // (company, job, call_type) so the DB partial-unique index lets us insert.
    const cancelled = await db.query(
      `UPDATE scheduled_calls
          SET status = 'cancelled', updated_at = NOW()
        WHERE company_id = $1 AND job_id = $2 AND call_type = $3
          AND status IN ('pending','in_progress')
        RETURNING id`,
      [companyId, hydrated.jobId, callType]
    );
    if (cancelled.rowCount > 0) {
      logger.info("Manual call: force=true cancelled prior queued call(s)", {
        companyId, jobId: hydrated.jobId, callType, ids: cancelled.rows.map(r => r.id),
      });
    }
  } else {
    const dup = await isDuplicate(companyId, callType, hydrated);
    if (dup) {
      return { ok: false, status: 409, error: "A scheduled call already exists for this target. Pass force:true to override." };
    }
  }

  // ── 4. Determine when ──────────────────────────────────────────────────────
  const callSettings = await callSettingsDb.getByCompanyId(companyId);
  let fireAt;
  if (immediate) {
    fireAt = new Date(); // bypass office hours — user clicked Call Now.
  } else {
    const { rows: co } = await db.query(`SELECT default_timezone FROM companies WHERE id = $1`, [companyId]);
    const tz = co[0]?.default_timezone || "America/New_York";
    const requested = scheduledAt ? new Date(scheduledAt) : new Date();
    fireAt = scheduler.isWithinActiveHours(callSettings, tz, requested)
      ? requested
      : scheduler.getNextWindowStart(callSettings, tz, requested);
  }

  // ── 5. Insert ──────────────────────────────────────────────────────────────
  // Manual = user clicked Call Now. Priority is HIGH regardless of due date so
  // it claims a slot ahead of cron-scheduled NORMAL/LOW work for the same tenant.
  // immediate=true also bypasses business hours — the Service Manager explicitly
  // chose to dial now; the cron's office-hours gate doesn't apply to them.
  // immediate=false rows queue for the next office window like cron-scheduled rows.
  let row;
  try {
    row = await scheduledCallsDb.create({
      companyId,
      ...hydrated.params,
      scheduledAt:       fireAt,
      isTest:            false,
      maxAttempts:       callSettings.max_attempts ?? 3,
      callPriority:      "high",
      bypassOfficeHours: immediate === true,
    });
  } catch (err) {
    if (err.code === "DUPLICATE_SCHEDULED_CALL" || err.code === "23505") {
      return { ok: false, status: 409, error: "A scheduled call already exists for this target. Pass force:true to override." };
    }
    throw err;
  }

  logger.info("Manual call: queued", {
    companyId, triggerType, callType, scheduledCallId: row.id, jobId: hydrated.jobId,
    immediate, fireAt: fireAt.toISOString(),
  });

  // ── 6. Immediate dispatch (best-effort) ───────────────────────────────────
  if (!immediate) {
    return { ok: true, status: 201, scheduledCall: row, dialed: false };
  }

  try {
    await scheduler.runDispatcher(1, { companyId, respectAutoFlag: false });
  } catch (err) {
    logger.warn("Manual call: dispatcher poke failed; row remains pending for next cron", {
      scheduledCallId: row.id, error: err.message,
    });
  }

  // Re-read the row so the response reflects what happened (status + retell_call_id).
  const { rows: after } = await db.query(
    `SELECT * FROM scheduled_calls WHERE id = $1 AND company_id = $2`,
    [row.id, companyId]
  );
  const finalRow = after[0] || row;
  const dialed = !!finalRow.retell_call_id;
  return {
    ok: true,
    status: 201,
    scheduledCall: finalRow,
    dialed,
    retellCallId: finalRow.retell_call_id || null,
  };
}

async function isDuplicate(companyId, callType, hydrated) {
  if (hydrated.params.jobId && String(hydrated.params.jobId).startsWith("quotation:")) {
    // quotation flow: dedupe against quotation_id and any linked real job_id
    const quotationId = Number(String(hydrated.params.jobId).replace(/^quotation:/, ""));
    return await scheduledCallsDb.existsForQuotation(
      companyId, quotationId, hydrated.realJobId || null, callType, false
    );
  }
  // Customer-facing call_types collide across the family; technician calls dedupe per-job.
  const dedupeFn = scheduledCallsDb.CUSTOMER_CALL_TYPES?.includes?.(callType)
    ? scheduledCallsDb.existsForCustomerJob
    : scheduledCallsDb.existsForJob;
  return await dedupeFn(companyId, hydrated.jobId, callType, false);
}

module.exports = { triggerManualCall, VALID_TRIGGER_TYPES };
