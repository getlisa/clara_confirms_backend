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
const { toE164 } = require("../utils/phone");
const { localToUTC } = require("../utils/timezone");
const { resolveOutboundChannel } = require("./channel-resolver");
const { resolveConfirmationRecipients } = require("./confirmation-recipients");
const logger = require("../utils/logger");

const VALID_TRIGGER_TYPES = Object.keys(HYDRATORS);

/**
 * @param {object} args
 * @param {number} args.companyId
 * @param {string} args.triggerType                — one of the 4 functional kinds (matches call_trigger_configs.trigger_type)
 * @param {number} [args.appointmentId]
 * @param {string|number} [args.jobId]
 * @param {number} [args.quotationId]
 * @param {string} [args.phoneNumber]              — optional manual override; for channel "voice"/"sms" dials this
 *                                                     number instead of the target's on-file number; for channel
 *                                                     "web_chat" it's an alternate to args.email — when
 *                                                     chat_link_delivery_method is "sms"/"both" this texts the
 *                                                     chat-link confirmation to this number instead of the
 *                                                     customer's on-file number. Normalized to E.164.
 * @param {string} [args.email]                    — optional manual override; emails this address instead of the
 *                                                     customer's on-file email (channel: "web_chat" only) — same idea
 *                                                     as phoneNumber, for when the customer record has no email at
 *                                                     all (the common case for ServiceTrade-synced customers, whose
 *                                                     email lives on a separate ServiceTrade Contact, not synced here).
 * @param {boolean} [args.immediate=true]
 * @param {boolean} [args.force=false]
 * @param {string}  [args.scheduledAt]
 * @param {string}  [args.channel]                  — explicit 'voice'|'sms'|'web_chat' override (e.g.
 *                                                     the frontend's "Call Now" / "Text Now" / "Email Now"
 *                                                     buttons). Omit to fall back to the company's channel strategy.
 *                                                     For "web_chat", which contact info is required (email/phone/either)
 *                                                     depends on the company's chat_link_delivery_method setting.
 * @returns {Promise<{ok:boolean, status:number, scheduledCall?, dialed?, retellCallId?, chatLinkToken?, error?}>}
 */
async function triggerManualCall({
  companyId, triggerType,
  appointmentId, jobId: rawJobId, quotationId, phoneNumber = null, email = null,
  immediate = true, force = false, scheduledAt = null, channel = null,
  // Who clicked. Every row this service creates is by definition a manual
  // trigger, so origin is stamped here rather than passed in.
  triggeredByUserId = null,
}) {
  // ── 1. Validate trigger_type and resolve the company's configured call_type ─
  if (!triggerType || !VALID_TRIGGER_TYPES.includes(triggerType)) {
    return { ok: false, status: 400, error: `Invalid trigger_type. Must be one of: ${VALID_TRIGGER_TYPES.join(", ")}` };
  }

  // Optional manual phone override — normalize up front so we fail fast on a bad number.
  let manualPhone = null;
  if (phoneNumber != null && String(phoneNumber).trim() !== "") {
    manualPhone = toE164(String(phoneNumber).trim());
    if (!manualPhone) {
      return { ok: false, status: 400, error: "Invalid phone_number — could not normalize to a valid E.164 number." };
    }
  }

  // Optional manual email override — same idea as manualPhone above.
  let manualEmail = null;
  if (email != null && String(email).trim() !== "") {
    const trimmed = String(email).trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      return { ok: false, status: 400, error: "Invalid email — could not validate as an email address." };
    }
    manualEmail = trimmed;
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

  // Fetched here (rather than in step 4, where it originally lived) because
  // step 2b's web_chat gate below needs chat_link_delivery_method, and channel
  // resolution (also moved up, see below) needs smsLive + channel_strategy.
  const callSettings = await callSettingsDb.getByCompanyId(companyId);
  const { rows: co } = await db.query(`SELECT default_timezone, sms_status FROM companies WHERE id = $1`, [companyId]);
  const smsLive = co[0]?.sms_status === "live";

  // An explicit channel request still has to respect SMS readiness — unlike
  // the automatic scheduler/retry paths (where resolveOutboundChannel's own
  // smsLive check silently falls back to voice), a human explicitly asking
  // for "Text Now" should get a clear error instead of a send attempt Retell
  // would likely reject (or worse, a confusing silent no-op) against a
  // not-yet-approved number.
  if (channel === "sms" && !smsLive) {
    return { ok: false, status: 422, error: "SMS is not yet enabled for this company — it must reach 'live' status before texts can be sent." };
  }

  // Resolved BEFORE the 2b contact gate below, which needs to know whether
  // this send is a web_chat (link) send or a voice dial to pick the right
  // required-contact-info check. Explicit channel (e.g. "Text Now"/"Email
  // Now" button) wins outright — legacy 'sms' maps onto the web_chat+sms link
  // path; 'web_chat' keeps using the company's chat_link_delivery_method
  // (there's no per-customer flag concept in an explicit single-target
  // override). No explicit channel -> resolve from the customer's own
  // is_voice/is_sms/is_email flags, same as the automatic scheduler.
  let resolvedChannel, linkDelivery = null;
  if (channel === "sms") {
    resolvedChannel = "web_chat"; linkDelivery = "sms";
  } else if (channel === "web_chat") {
    resolvedChannel = "web_chat"; linkDelivery = callSettings.chat_link_delivery_method;
  } else if (channel === "voice") {
    resolvedChannel = "voice";
  } else {
    const { rows: custRows } = await db.query(
      `SELECT c.is_voice, c.is_sms, c.is_email
         FROM jobs j JOIN customers c ON c.id = j.customer_id
        WHERE j.id = $1 AND j.company_id = $2`,
      [hydrated.jobId, companyId]
    );
    const flags = custRows[0] ? { is_voice: custRows[0].is_voice, is_sms: custRows[0].is_sms, is_email: custRows[0].is_email } : null;
    const resolved = resolveOutboundChannel({ smsLive, flags, channelStrategy: callSettings.channel_strategy });
    resolvedChannel = resolved.channel;
    linkDelivery = resolved.linkDelivery;
  }

  // ── 2b. Resolve who/what to contact ────────────────────────────────────────
  // A web_chat send (explicit "Email Now"/"Text Now", or flags resolving that
  // way) needs at least one of email/phone, depending on linkDelivery —
  // checked here instead of the phone-required gate voice uses.
  let overrideEmail = null;
  let overridePhone = null;
  if (resolvedChannel === "web_chat") {
    const { rows: contactRows } = await db.query(
      `SELECT c.email, c.phone FROM jobs j JOIN customers c ON c.id = j.customer_id WHERE j.id = $1 AND j.company_id = $2`,
      [hydrated.jobId, companyId]
    );
    const onFileEmail = contactRows[0]?.email || null;
    const onFilePhone = contactRows[0]?.phone || null;
    // Mirrors the phoneNumber override below: ServiceTrade-synced customers
    // almost never have an email on the *customer* record (that lives on a
    // separate ServiceTrade Contact) — a manually-supplied email/phone rescues
    // that, same as phone_number does for the voice channel below.
    const deliveryMethod = linkDelivery;
    const email = manualEmail || onFileEmail;
    const phone = manualPhone || onFilePhone;
    const subject = hydrated.phoneSubject || "customer";

    if (deliveryMethod === "email" && !email) {
      return {
        ok: false, status: 422, code: "missing_email", subject,
        error: `No ${subject} email on file. Pass email to send a chat-link confirmation to a specific address.`,
      };
    }
    if (deliveryMethod === "sms" && !phone) {
      return {
        ok: false, status: 422, code: "missing_phone", subject,
        error: `No ${subject} phone number on file. Pass phone_number to text a chat confirmation to a specific number.`,
      };
    }
    if ((deliveryMethod === "both" || !deliveryMethod) && !email && !phone) {
      return {
        ok: false, status: 422, code: "missing_contact_info", subject,
        error: `No ${subject} email or phone on file. Pass email and/or phone_number to send a chat confirmation.`,
      };
    }

    if (manualEmail) overrideEmail = manualEmail;
    if (manualPhone) overridePhone = manualPhone;
    // scheduled_calls still stores a phone_number column (used for queue dedup);
    // pass through whatever's on file without requiring it for this channel.
    hydrated.params.phoneNumber = manualPhone || hydrated.params.phoneNumber || null;
  } else {
    // A manually-supplied phone_number overrides the target's on-file number and
    // rescues targets that have no number on file. If neither is present, 422.
    const dialPhone = manualPhone || hydrated.params.phoneNumber;
    if (!dialPhone) {
      const subject = hydrated.phoneSubject || "customer";
      return {
        ok: false, status: 422, code: "missing_phone", subject,
        error: `No ${subject} phone number on file. Pass phone_number to dial a specific number.`,
      };
    }
    hydrated.params.phoneNumber = dialPhone;
    if (manualPhone) {
      logger.info("Manual call: using manual phone override", { companyId, triggerType, targetId });
    }
  }

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
  let fireAt;
  if (immediate) {
    fireAt = new Date(); // bypass office hours — user clicked Call Now.
  } else {
    const tz = co[0]?.default_timezone || "America/New_York";
    // scheduledAt, if provided, is a naive wall-clock string meant in the company's timezone.
    const requested = scheduledAt ? new Date(localToUTC(scheduledAt, tz)) : new Date();
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
      origin: "manual", triggeredByUserId,
      companyId,
      ...hydrated.params,
      scheduledAt:       fireAt,
      isTest:            false,
      maxAttempts:       callSettings.max_attempts ?? 3,
      callPriority:      "high",
      bypassOfficeHours: immediate === true,
      channel:           resolvedChannel,
      linkDelivery,
      // Carries the manual email override through to the dispatcher (which
      // runs as a separate step below and re-reads the row from the DB —
      // it has no other way to see a value that was never persisted).
      ...((overrideEmail || overridePhone) && {
        callContext: {
          ...(overrideEmail && { override_email: overrideEmail }),
          ...(overridePhone && { override_phone: overridePhone }),
        },
      }),
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

  // ── 5b. Fan out to additional confirmation recipients (link-send only) ────
  // Manual "Call Now" (voice) stays single-target — dials only this one
  // number, exactly like today; confirmation_contact_ids has no effect on
  // this button (decided: firing several simultaneous LIVE calls from one
  // click is a bigger surprise than the same fan-out happening invisibly
  // overnight). A manual link-send ("Text Now"/"Email Now"), though, is
  // already N-independent-sends under the hood — no override was given and
  // no override was needed, so also queue one row per OTHER opted-in
  // contact, same as the automatic sweep does. Only applies to real
  // customer-facing call types with a real numeric job — technician/
  // quotation targets have no `confirmation_contact_ids` concept.
  const additionalRecipients = [];
  if (
    resolvedChannel === "web_chat" && !manualPhone && !manualEmail &&
    scheduledCallsDb.CUSTOMER_CALL_TYPES.includes(callType) &&
    /^\d+$/.test(String(hydrated.jobId || ""))
  ) {
    const { rows: custRows } = await db.query(
      `SELECT c.id, c.full_name, c.phone, c.email,
              c.confirmation_include_customer, c.confirmation_contact_ids
         FROM jobs j JOIN customers c ON c.id = j.customer_id
        WHERE j.id = $1 AND j.company_id = $2`,
      [hydrated.jobId, companyId]
    );
    if (custRows[0]) {
      // callSettings is already loaded above; passing the contact-type default
      // keeps this manual path in step with the sweep (migration 087).
      const recipients = await resolveConfirmationRecipients(companyId, custRows[0], {
        contactTypes: callSettings.confirmation_contact_types || [],
      });
      // The customer themselves (recipientContactId: null) is already the
      // row just inserted above — only fan out to the EXTRA contacts.
      const extras = recipients.filter((r) => r.recipientContactId != null);
      for (const recipient of extras) {
        if (!recipient.phone && !recipient.email) continue; // nothing to send to
        try {
          const extraRow = await scheduledCallsDb.create({
            origin: "manual", triggeredByUserId,
            companyId,
            ...hydrated.params,
            phoneNumber: recipient.phone,
            scheduledAt: fireAt,
            isTest: false,
            maxAttempts: callSettings.max_attempts ?? 3,
            callPriority: "high",
            bypassOfficeHours: immediate === true,
            channel: "web_chat",
            linkDelivery,
            recipientContactId: recipient.recipientContactId,
            recipientName: recipient.name,
            recipientEmail: recipient.email,
          });
          additionalRecipients.push({ recipientContactId: recipient.recipientContactId, scheduledCallId: extraRow.id });
        } catch (err) {
          if (err.code === "DUPLICATE_SCHEDULED_CALL" || err.code === "23505") {
            additionalRecipients.push({ recipientContactId: recipient.recipientContactId, skipped: "already_queued" });
          } else {
            logger.warn("Manual call: extra recipient enqueue failed", { companyId, jobId: hydrated.jobId, recipientContactId: recipient.recipientContactId, error: err.message });
          }
        }
      }
    }
  }

  // ── 6. Immediate dispatch (best-effort) ───────────────────────────────────
  if (!immediate) {
    return { ok: true, status: 201, scheduledCall: row, dialed: false };
  }

  try {
    // batchSize covers this row plus any additional recipients queued in 5b,
    // so a manual link-send with extra recipients dispatches all of them
    // within this same request instead of leaving the extras for the next
    // cron tick.
    await scheduler.runDispatcher(1 + additionalRecipients.length, { companyId, respectAutoFlag: false });
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
  // web_chat (which now covers the legacy "sms" explicit channel too — see
  // channel resolution above) texts/emails a chat_links link — it has no
  // retell_call_id until the customer opens it. Its success signal is the row
  // completing with a chat_link_token instead. Note: this reflects the row
  // completing, not which medium(s) actually succeeded (same coarse signal —
  // the underlying dispatch sends email and/or SMS independently and
  // best-effort; see scheduler.js).
  const linkDispatched = resolvedChannel === "web_chat" && finalRow.status === "completed";
  return {
    ok: true,
    status: 201,
    scheduledCall: finalRow,
    dialed,
    retellCallId: finalRow.retell_call_id || null,
    ...(resolvedChannel === "web_chat" && {
      emailSent: linkDispatched && (linkDelivery === "email" || linkDelivery === "both"),
      smsSent: linkDispatched && (linkDelivery === "sms" || linkDelivery === "both"),
      chatLinkToken: finalRow.chat_link_token || null,
    }),
    // Other confirmation-contact recipients queued alongside this one — see
    // step 5b. Empty/omitted for the common case (no extra recipients, or
    // channel voice, or an explicit override was given).
    ...(additionalRecipients.length > 0 && { additionalRecipients }),
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
