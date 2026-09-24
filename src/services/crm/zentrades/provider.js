/**
 * ZenTradesProvider — concrete CrmProvider implementation.
 *
 * Two-step pipeline like ServiceTrade/InspectPoint (RAW SYNC then
 * NORMALIZE), PLUS write-back (see api_doc/ztticket_update.md and
 * api_doc/zentrades.md §4 for the contracts this is built against).
 *
 * Unlike InspectPointProvider's request(), which must thread an explicit
 * `credentials` object through every call (its client has no state of its
 * own), ZenTrades' client (services/zentrades.js) manages login/token
 * refresh internally keyed on companyId — so this provider's request() is a
 * thin pass-through, not a credentials-resolve-then-call.
 *
 * Normalize ordering, and why: customers first (no dependencies) -> contacts
 * (deduped by email — see normalize.js's dedupeContactsByEmail — needs to
 * happen before locations, since a location's primary_contact_id needs the
 * PLATFORM contact id, not a raw ref) -> technicians (no dependencies) ->
 * locations (needs customers + the deduped contacts) -> jobs (needs
 * customers + locations + technicians, and locations' own primary_contact_id
 * to mirror onto the job) -> appointments (needs jobs + technicians).
 * ZenTrades needs no junction tables at all (no offices/tags concept, and
 * assignment:appointment is 1:1 so there's exactly one technician per
 * appointment — nothing for appointment_technicians to represent), which is
 * genuinely simpler than both other providers here.
 *
 * ── Write-back — the one fact that shapes all seven mirrors ────────────────
 *
 * `jobStatusId` on `PUT /api/ticket/update` is NOT writable — ZenTrades
 * derives it (and scheduledStartTime/EndTime) from the ticket's own visits'
 * assignmentStatusId. A client-sent jobStatusId is logged
 * ("TICKET_EDIT: Ignoring client jobStatusId…") and discarded. So every
 * mirror here is a VISIT (assignment) operation, never a ticket-status
 * patch — mirroring exactly how normalize.js's mapJobStatus already derives
 * OUR status from "status + live assignment" rather than the status word
 * alone. The only ticket-level field ever written is nothing at all today
 * (see mirrorCancelJob's note on cancelReason).
 */

const { CrmProvider } = require("../base");
const zt = require("../../zentrades");
const ztSync = require("../../zentrades-sync");
const ztCredsDb = require("../../../db/zentrades-credentials");
const db = require("../../../db");
const normalize = require("./normalize");
const todosDb = require("../../../db/todos");
const { getCompanyTimezone, toOffsetISOString, localToUTC } = require("../../../utils/timezone");
const logger = require("../../../utils/logger");

const SOURCE = "zentrades";
// fetchExternalRefMap defaults to source="servicetrade" — wrapping it here
// makes that default unreachable from this file rather than merely unused,
// per db/index.js's own warning: forgetting the source argument would
// silently cross-link ZenTrades rows to ServiceTrade's.
const refMap = (companyId, table) => db.fetchExternalRefMap(companyId, table, SOURCE);

function isNumericRef(v) {
  return v != null && v !== "" && /^\d+$/.test(String(v));
}

async function raiseCrmSyncTodo(companyId, { action, entity, entityId, error }) {
  await todosDb
    .create({
      companyId, callId: null,
      type: todosDb.TODO_TYPES.CRM_SYNC,
      isTest: false,
      metadata: { action, entity, entity_id: entityId != null ? String(entityId) : null, error: error ? String(error).slice(0, 2000) : null },
    })
    .catch((err) => logger.warn("zentrades crm-sync: failed to raise CRM_SYNC todo", { error: err.message, companyId, action }));
}

/**
 * A UTC instant -> ZenTrades' `YYYY-MM-DD HH:mm:ss` wire format.
 *
 * NOT a conversion to the tenant's local time — verified live (2026-09-09,
 * ticket 1808561/assignment 2604149): `GET /api/ticket` returns
 * `startTime: "2026-09-11T19:00:00.000Z"`, i.e. storage/comparison is plain
 * UTC with the `T`/`Z` stripped for the wire, not a company-local wall clock.
 * Sending an actually-tenant-local-converted string here (as this used to)
 * makes `existingData` disagree with what ZenTrades has by exactly the
 * tenant's UTC offset, which the overwrite guard reads as "someone else
 * changed it" (E104) — see api_doc/ztticket_update.md §8. The
 * `timezone-offset`/`timezonename` headers are real but scoped to
 * `editRecurringEvent` math only (§2), not general startTime/endTime parsing.
 */
function toZtWallClock(utcInstant) {
  if (!utcInstant) return null;
  const d = utcInstant instanceof Date ? utcInstant : new Date(utcInstant);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Minute-precision comparison key for a ZenTrades timestamp, tolerant of
 * either shape the API actually uses: our own wire format
 * ("2026-09-15 14:00:00") when we built the string ourselves, and full ISO
 * ("2026-09-15T14:00:00.000Z") which is what `PUT /api/ticket/update`
 * actually echoes back on success — verified live (2026-09-09, ticket
 * 1675140/assignment 2395356): the write landed correctly but a naive
 * string-slice comparison of these two shapes reported a false
 * echo-verification failure because of the "T"/space delimiter alone.
 */
function ztInstantMinuteKey(v) {
  if (!v) return null;
  return String(v).replace("T", " ").slice(0, 16);
}

class ZenTradesProvider extends CrmProvider {
  get slug() { return "zentrades"; }
  get supportedEntities() {
    return ["customers", "locations", "contacts", "technicians", "jobs", "appointments"];
  }

  async getCredentials(companyId) {
    return await ztCredsDb.getByCompanyId(companyId);
  }

  async request(companyId, method, path, opts = {}) {
    return await zt.request(companyId, method, path, opts);
  }

  // ── Write-back plumbing ────────────────────────────────────────────────

  /**
   * The tenant's own timezone (captured at connect time), falling back to
   * the platform default. Only needed for mirrorRescheduleJob's calendar-day
   * shift (preserving each visit's LOCAL time-of-day across a date change)
   * — every wire-format timestamp itself is plain UTC (see toZtWallClock)
   * and needs no tenant timezone at all.
   */
  async _resolveTenantTimezone(companyId) {
    const creds = await ztCredsDb.getByCompanyId(companyId).catch(() => null);
    return creds?.metadata?.timezoneRegionName || (await getCompanyTimezone(companyId));
  }

  /**
   * The ticket's external_ref for a PLATFORM job id, only when it's really a
   * ZenTrades job — self-guards every mirror that starts from a job_id
   * rather than already holding the job row.
   */
  async _resolveTicketId(companyId, platformJobId) {
    if (!platformJobId) return null;
    const { rows } = await db.query(`SELECT external_ref, source FROM jobs WHERE id = $1 AND company_id = $2`, [platformJobId, companyId]);
    if (rows[0]?.source !== SOURCE || !isNumericRef(rows[0]?.external_ref)) return null;
    return Number(rows[0].external_ref);
  }

  /**
   * `existingData` for one assignment — see api_doc/ztticket_update.md §8: it
   * is BOTH the optimistic-concurrency guard AND what decides which customer
   * SMS ZenTrades sends (changed assignmentStatusId -> "update" template;
   * changed startTime -> "reschedule"; omitted entirely -> "create", i.e. the
   * WRONG message for an edit). Sourced from our own last-synced
   * zentrades_appointments snapshot, NEVER the platform `appointments` table
   * — every mirror call site updates the platform row to the NEW value
   * before firing the mirror, so reading existingData from there would
   * silently make it match the update and defeat the guard.
   */
  async _buildExistingData(companyId, assignmentId) {
    const { rows } = await db.query(
      `SELECT scheduled_start, scheduled_end, zentrades_technician_id, assignment_status_id
         FROM zentrades_appointments WHERE company_id = $1 AND zentrades_id = $2`,
      [companyId, assignmentId]
    );
    const row = rows[0];
    if (!row) {
      logger.warn("zentrades write-back: no raw snapshot for this assignment — sending the update WITHOUT existingData. ZenTrades will treat it as a brand-new visit and send the customer the CREATE sms template, not reschedule/update.", { companyId, assignmentId });
      return null;
    }
    return {
      startTime: toZtWallClock(row.scheduled_start),
      endTime: toZtWallClock(row.scheduled_end),
      technicianId: row.zentrades_technician_id != null ? Number(row.zentrades_technician_id) : undefined,
      assignmentStatusId: row.assignment_status_id != null ? Number(row.assignment_status_id) : undefined,
    };
  }

  /**
   * The one write seam every mutating mirror goes through — owns the
   * contract rules that are easy to get wrong per call site (see
   * api_doc/ztticket_update.md):
   *  - never send `options` (a full-blob overwrite, not a merge)
   *  - branch on `exception.error.code`, never on HTTP status — most
   *    failures here are HTTP 500 with a meaningful code in the body
   *  - E501 ("database failure") is the ONLY code the doc calls transient;
   *    E104 (overwrite conflict) must never be retried — retrying just loses
   *    the same race again
   *  - verify the echo (Gotcha 02): no request-schema validation on this
   *    route means a dropped/typo'd key returns 200 OK with the OLD value
   *    still in place, so a caller-supplied `verify(result)` decides success,
   *    not the HTTP status
   *
   * `suppressErrorTodo: true` on the underlying request — this function
   * raises its own richer CRM_SYNC todo naming the action/entity, so the
   * client's generic one would just be a duplicate.
   */
  async _putTicketUpdate(companyId, body, { action, entity = "ticket", entityId, verify } = {}) {
    let res = await this.request(companyId, "PUT", "/api/ticket/update", { body, retryable: false, suppressErrorTodo: true });

    if (!res.ok && res.data?.exception?.error?.code === "E501") {
      res = await this.request(companyId, "PUT", "/api/ticket/update", { body, retryable: false, suppressErrorTodo: true });
    }

    if (!res.ok) {
      const errInfo = res.data?.exception?.error;
      const message = errInfo?.description || errInfo?.message || (res.messages?.error || []).join("; ") || `HTTP ${res.status}`;
      await raiseCrmSyncTodo(companyId, { action, entity, entityId, error: `[${errInfo?.code || res.status}] ${message}` });
      return { ok: false, status: res.status, code: errInfo?.code || null, error: message };
    }

    if (verify && !verify(res.data)) {
      logger.error("zentrades write-back: update returned 200 but the echoed ticket does not reflect what was sent (Gotcha 02 — an unrecognized/dropped key)", { companyId, action, entityId });
      await raiseCrmSyncTodo(companyId, { action, entity, entityId, error: "update accepted (200) but the echoed result does not match what was sent — see Gotcha 02 in api_doc/ztticket_update.md" });
      return { ok: false, status: res.status, error: "echo_verification_failed" };
    }

    return { ok: true, result: res.data };
  }

  // ── CRM write-back mirrors ───────────────────────────────────────────────
  //
  // All five mutating mirrors self-guard on source==='zentrades' + a numeric
  // external_ref, same shape as the other two providers' guards.

  /** Reschedule one visit — the assignment IS the appointment, 1:1. */
  async mirrorRescheduleAppointment(companyId, appointment, { scheduledStart, scheduledEnd = null } = {}) {
    if (!appointment || appointment.source !== SOURCE || !isNumericRef(appointment.external_ref)) {
      return { skipped: "not_zentrades" };
    }
    const ticketId = await this._resolveTicketId(companyId, appointment.job_id);
    if (!ticketId) return { skipped: "not_zentrades" };

    const assignmentId = Number(appointment.external_ref);
    const existingData = await this._buildExistingData(companyId, assignmentId);
    const startTime = toZtWallClock(scheduledStart);
    const endTime = scheduledEnd ? toZtWallClock(scheduledEnd) : undefined;

    const body = {
      id: ticketId,
      assignments: { update: [{ id: assignmentId, ticketId, startTime, endTime, ...(existingData ? { existingData } : {}) }] },
    };

    return this._putTicketUpdate(companyId, body, {
      action: "reschedule_appointment", entity: "assignment", entityId: assignmentId,
      verify: (result) => {
        const updated = (result?.assignments || []).find((a) => Number(a.id) === assignmentId);
        // Minute-precision, format-tolerant comparison (see ztInstantMinuteKey)
        // — the echo comes back as full ISO ("...T14:00:00.000Z"), not the
        // wall-clock shape we sent, so a raw string/slice compare here always
        // reported a false failure even on a genuinely successful write.
        return !!updated && ztInstantMinuteKey(updated.startTime) === ztInstantMinuteKey(startTime);
      },
    });
  }

  /** Cancel one visit — soft delete via assignments.delete. */
  async mirrorCancelAppointment(companyId, appointment) {
    if (!appointment || appointment.source !== SOURCE || !isNumericRef(appointment.external_ref)) {
      return { skipped: "not_zentrades" };
    }
    const ticketId = await this._resolveTicketId(companyId, appointment.job_id);
    if (!ticketId) return { skipped: "not_zentrades" };

    const assignmentId = Number(appointment.external_ref);
    // Deletes take OBJECTS carrying an id — [{id}], never a bare [id]. A bare
    // array reads as `undefined` server-side and the delete silently no-ops.
    const body = { id: ticketId, assignments: { delete: [{ id: assignmentId }] } };

    return this._putTicketUpdate(companyId, body, {
      action: "cancel_appointment", entity: "assignment", entityId: assignmentId,
      verify: (result) => (result?.deletedAssignments || [])
        .some((d) => Number(typeof d === "object" && d ? d.id : d) === assignmentId),
    });
  }

  /**
   * Cancel the whole job — deletes every ZenTrades-sourced visit we hold
   * locally for it. `cancelReason` is deliberately not sent: neither call
   * site (confirmation-agent/actions.js, routes/retell-tools.js) threads a
   * reason into this mirror's opts today, and the field is optional per the
   * contract — sending nothing is honest, sending a guessed value is not.
   */
  async mirrorCancelJob(companyId, job) {
    if (!job || job.source !== SOURCE || !isNumericRef(job.external_ref)) return { skipped: "not_zentrades" };
    const ticketId = Number(job.external_ref);

    const { rows: jobIdRows } = await db.query(
      `SELECT id FROM jobs WHERE company_id = $1 AND source = $2 AND external_ref = $3`,
      [companyId, SOURCE, job.external_ref]
    );
    const platformJobId = jobIdRows[0]?.id;
    if (!platformJobId) return { skipped: "job_not_found_locally" };

    const { rows: apptRows } = await db.query(
      `SELECT external_ref FROM appointments WHERE job_id = $1 AND company_id = $2 AND source = $3 AND external_ref IS NOT NULL`,
      [platformJobId, companyId, SOURCE]
    );
    const deleteList = apptRows.map((r) => ({ id: Number(r.external_ref) })).filter((d) => Number.isFinite(d.id));
    if (deleteList.length === 0) return { ok: true, note: "no_local_assignments_to_delete" };

    const body = { id: ticketId, assignments: { delete: deleteList } };
    return this._putTicketUpdate(companyId, body, {
      action: "cancel_job", entity: "ticket", entityId: ticketId,
      verify: (result) => {
        const deletedIds = new Set((result?.deletedAssignments || []).map((d) => Number(typeof d === "object" && d ? d.id : d)));
        return deleteList.every((d) => deletedIds.has(d.id));
      },
    });
  }

  /**
   * Create a new visit on an existing ticket, then stamp its id back onto
   * the platform appointment row — same create+stamp pattern as
   * InspectPoint's mirrorCreateAppointment. Dispatched by the JOB's source
   * (a freshly created platform appointment has no CRM source of its own
   * yet).
   */
  async mirrorCreateAppointment(companyId, appointment, platformJobId, { scheduledStart, scheduledEnd = null } = {}) {
    const { rows } = await db.query(`SELECT external_ref, source FROM jobs WHERE id = $1 AND company_id = $2`, [platformJobId, companyId]);
    const job = rows[0];
    if (!job || job.source !== SOURCE || !isNumericRef(job.external_ref)) return { skipped: "not_zentrades" };
    const ticketId = Number(job.external_ref);

    let ztTechnicianId = null;
    if (appointment.technician_id != null) {
      const { rows: techRows } = await db.query(
        `SELECT external_ref FROM technicians WHERE id = $1 AND company_id = $2 AND source = $3`,
        [appointment.technician_id, companyId, SOURCE]
      );
      ztTechnicianId = techRows[0]?.external_ref != null ? Number(techRows[0].external_ref) : null;
    }
    if (ztTechnicianId == null) {
      // The doc's own sample `add` body always carries a technicianId —
      // don't guess one; raise a todo and let a human assign it in ZenTrades.
      await raiseCrmSyncTodo(companyId, { action: "create_appointment", entity: "ticket", entityId: ticketId, error: "no resolvable ZenTrades technician for this appointment" });
      return { ok: false, error: "no_technician" };
    }

    const body = {
      id: ticketId,
      assignments: {
        add: [{
          startTime: toZtWallClock(scheduledStart),
          endTime: scheduledEnd ? toZtWallClock(scheduledEnd) : undefined,
          technicianId: ztTechnicianId,
          assignmentStatusId: 1, // "Open" — the only assignmentStatusId confirmed by the docs
          description: "",
        }],
      },
    };

    const res = await this._putTicketUpdate(companyId, body, {
      action: "create_appointment", entity: "ticket", entityId: ticketId,
      verify: (result) => Array.isArray(result?.assignments) && result.assignments.length > 0,
    });
    if (!res.ok) return res;

    // The new visit is the one assignment id we don't already have a
    // platform row for — every OTHER visit on this ticket is already synced
    // with its own external_ref.
    const { rows: knownRows } = await db.query(
      `SELECT external_ref FROM appointments WHERE job_id = $1 AND company_id = $2 AND source = $3`,
      [platformJobId, companyId, SOURCE]
    );
    const known = new Set(knownRows.map((r) => String(r.external_ref)));
    const newAssignment = (res.result?.assignments || []).find((a) => !known.has(String(a.id)));
    if (!newAssignment) {
      await raiseCrmSyncTodo(companyId, { action: "create_appointment", entity: "ticket", entityId: ticketId, error: "visit created but its new id could not be identified in the echoed response" });
      return { ok: false, error: "new_visit_id_not_found" };
    }

    await db.query(
      `UPDATE appointments SET external_ref = $1, source = $2, updated_at = NOW() WHERE id = $3 AND company_id = $4`,
      [String(newAssignment.id), SOURCE, appointment.id, companyId]
    );
    return { ok: true, zentradesAssignmentId: String(newAssignment.id) };
  }

  /**
   * Reschedule the whole job (voice's reschedule_job tool — chat has no
   * equivalent). Ticket-level times are DERIVED, so this shifts every live
   * visit to the new calendar day, preserving each visit's own time-of-day
   * and duration — never a wholesale "set everyone to midnight".
   */
  async mirrorRescheduleJob(companyId, job, { scheduledDate } = {}) {
    if (!job || job.source !== SOURCE || !isNumericRef(job.external_ref)) return { skipped: "not_zentrades" };
    const ticketId = Number(job.external_ref);

    const { rows: apptRows } = await db.query(
      `SELECT external_ref, scheduled_start, scheduled_end FROM appointments
        WHERE job_id = $1 AND company_id = $2 AND source = $3 AND external_ref IS NOT NULL AND status <> 'cancelled'`,
      [job.id, companyId, SOURCE]
    );
    if (apptRows.length === 0) return { skipped: "no_live_assignments" };

    // Tenant timezone is needed ONLY here, for the calendar-day shift math
    // below (preserving each visit's own LOCAL time-of-day across the date
    // change) — it plays no part in the wire format itself (toZtWallClock is
    // plain UTC, see its own comment).
    const tz = await this._resolveTenantTimezone(companyId);
    const updates = [];
    for (const appt of apptRows) {
      if (!appt.scheduled_start) continue; // nothing to preserve a time-of-day from
      const assignmentId = Number(appt.external_ref);
      const existingData = await this._buildExistingData(companyId, assignmentId);

      // The OLD visit's LOCAL time-of-day (not the wire format) — this is
      // what "same time, new date" means to the customer.
      const oldLocalIso = toOffsetISOString(appt.scheduled_start, tz);
      const timeOfDay = oldLocalIso ? oldLocalIso.slice(11, 19) : null; // "HH:mm:ss"
      if (!timeOfDay) continue;
      const newStartUTC = localToUTC(`${scheduledDate}T${timeOfDay}`, tz);
      const durationMs = appt.scheduled_end ? new Date(appt.scheduled_end).getTime() - new Date(appt.scheduled_start).getTime() : null;
      const newEndUTC = durationMs != null ? new Date(new Date(newStartUTC).getTime() + durationMs).toISOString() : null;

      const startTime = toZtWallClock(newStartUTC);
      updates.push({
        id: assignmentId, ticketId, startTime,
        endTime: newEndUTC ? toZtWallClock(newEndUTC) : undefined,
        ...(existingData ? { existingData } : {}),
      });
    }
    if (updates.length === 0) return { skipped: "no_shiftable_assignments" };

    const body = { id: ticketId, assignments: { update: updates } };
    return this._putTicketUpdate(companyId, body, {
      action: "reschedule_job", entity: "ticket", entityId: ticketId,
      verify: (result) => {
        const returned = new Map((result?.assignments || []).map((a) => [Number(a.id), a]));
        return updates.every((u) => {
          const got = returned.get(u.id);
          return got && ztInstantMinuteKey(got.startTime) === ztInstantMinuteKey(u.startTime);
        });
      },
    });
  }

  // ── CRM comment write-back ───────────────────────────────────────────────
  //
  // Additive only — no overwrite semantics, no verify-the-echo concern (the
  // note endpoint has its own dedicated response shape, not the ticket
  // update contract's Gotcha 02). Public per product decision (isPrivate:
  // false), unlike InspectPoint's internal_notes append.

  async _resolveTicketRef(companyId, jobId) {
    if (!jobId) return null;
    const { rows } = await db.query(`SELECT external_ref, source FROM jobs WHERE id = $1 AND company_id = $2`, [jobId, companyId]);
    return rows[0]?.source === SOURCE && isNumericRef(rows[0]?.external_ref) ? rows[0].external_ref : null;
  }

  async _postNote(companyId, ticketExternalRef, text) {
    const res = await this.request(companyId, "POST", "/api/note/ticket/create/v2", {
      body: { ticketId: Number(ticketExternalRef), text, isPrivate: false, addAttachments: [], deleteAttachments: [] },
      retryable: false, suppressErrorTodo: true,
    });
    if (!res.ok || !res.data?.id) {
      await raiseCrmSyncTodo(companyId, {
        action: "post_comment", entity: "ticket", entityId: ticketExternalRef,
        error: res.data?.exception?.error?.description || (res.messages?.error || []).join("; ") || `HTTP ${res.status}`,
      });
      return { ok: false, status: res.status };
    }
    return { ok: true };
  }

  /** Chat outcome — companyId, {jobId, summaryLines, recipientName, expired}. */
  async mirrorPostChatComment(companyId, { jobId, summaryLines, recipientName = null, expired = false } = {}) {
    if (!summaryLines || summaryLines.length === 0) return { skipped: "nothing_reportable" };
    const ref = await this._resolveTicketRef(companyId, jobId);
    if (!ref) return { skipped: "not_zentrades" };
    const timestamp = new Date().toISOString().slice(0, 16).replace("T", " ");
    const lapsedNote = expired ? " The chat then lapsed without a formal close." : "";
    const note = `[Clara ${timestamp}] Chat outcome: ${summaryLines.join(" ")}${lapsedNote} Who confirmed: ${recipientName || "unknown"}.`;
    return this._postNote(companyId, ref, note);
  }

  /** Call outcome — companyId, {scheduledCall, callSummary}. */
  async mirrorPostCallComment(companyId, { scheduledCall, callSummary = null } = {}) {
    const ref = await this._resolveTicketRef(companyId, scheduledCall?.job_id);
    if (!ref) return { skipped: "not_zentrades" };
    const timestamp = new Date().toISOString().slice(0, 16).replace("T", " ");
    const note = `[Clara ${timestamp}] Call outcome: ${callSummary || "see call recording"}.`;
    return this._postNote(companyId, ref, note);
  }

  /**
   * @param {string|number} companyId
   * @param {{full?: boolean, engine?: object|null, scheduleDateFrom?: number|null, scheduleDateTo?: number|null}} [opts]
   *   Same shape engines/crm-sync/index.js passes to every provider. `range`
   *   is accepted but unused (matches InspectPointProvider's signature —
   *   nothing here has a "week/month/3month" concept the way ServiceTrade's
   *   calendar-month default does).
   */
  async syncAll(companyId, { full = false, engine = null, scheduleDateFrom = null, scheduleDateTo = null } = {}) {
    try {
      const rawResult = await ztSync.runSync(companyId, { full, engine, scheduleDateFrom, scheduleDateTo });
      if (!rawResult.success) {
        return { ok: false, counts: rawResult.counts || {}, error: rawResult.error };
      }

      if (engine) await engine.transition("normalizing", {});
      logger.info("ZenTradesProvider: normalizing raw data into platform tables", { companyId, rawCounts: rawResult.counts });
      const normResult = await this.normalizeAll(companyId, engine);

      const counts = { ...rawResult.counts, normalized: normResult };
      const incomplete = rawResult.incomplete || [];
      if (incomplete.length) {
        logger.warn("ZenTradesProvider.syncAll: partial run, will retry these entities next tick", { companyId, incomplete, counts });
      } else {
        logger.info("ZenTradesProvider.syncAll done", { companyId, counts });
      }
      return { ok: true, counts, incomplete };
    } catch (err) {
      logger.error("ZenTradesProvider.syncAll failed", { companyId, error: err.message });
      return { ok: false, error: err.message };
    }
  }

  async normalizeAll(companyId, engine = null) {
    const counts = { customers: 0, contacts: 0, technicians: 0, locations: 0, jobs: 0, appointments: 0 };
    const emit = (entity, count) => engine && engine.emit("entity_done", { entity, count });

    counts.customers = await this._normalizeCustomers(companyId);
    emit("customers", counts.customers);

    const rawContacts = await db.fetchAllByCompanyChunked(companyId, "zentrades_contacts");
    const { canonicalRows, alias } = normalize.dedupeContactsByEmail(rawContacts);

    // Each location's own on-site contact is deterministically `addr:<id>` —
    // no multi-candidate heuristic needed the way InspectPoint's
    // scheduling/owner role pick is, since ZenTrades never gives more than
    // one service-address contact per location.
    const rawLocations = await db.fetchAllByCompanyChunked(companyId, "zentrades_locations");
    const primaryRawRefByLocation = new Map();
    for (const loc of rawLocations) {
      const rawRef = `addr:${loc.zentrades_id}`;
      primaryRawRefByLocation.set(String(loc.zentrades_id), alias.get(rawRef) || rawRef);
    }
    const primaryCanonicalRefs = new Set(primaryRawRefByLocation.values());

    counts.contacts = await this._normalizeContacts(companyId, canonicalRows, primaryCanonicalRefs);
    emit("contacts", counts.contacts);

    counts.technicians = await this._normalizeTechnicians(companyId);
    emit("technicians", counts.technicians);

    counts.locations = await this._normalizeLocations(companyId, rawLocations, primaryRawRefByLocation);
    emit("locations", counts.locations);

    const rawTickets = await db.fetchAllByCompanyChunked(companyId, "zentrades_tickets");
    counts.jobs = await this._normalizeJobs(companyId, rawTickets);
    emit("jobs", counts.jobs);

    counts.appointments = await this._normalizeAppointments(companyId);
    emit("appointments", counts.appointments);

    return counts;
  }

  async _normalizeCustomers(companyId) {
    const raw = await db.fetchAllByCompanyChunked(companyId, "zentrades_customers");
    const argsList = raw.map((row) => normalize.normalizeCustomer(row, { companyId })).filter(Boolean);
    await db.bulkUpsertByExternalRef("customers", CUSTOMER_FIELDS, argsList);
    return argsList.length;
  }

  async _normalizeContacts(companyId, canonicalRows, primaryCanonicalRefs) {
    const argsList = canonicalRows
      .map((row) => normalize.normalizeContact(row, { companyId, isPrimary: primaryCanonicalRefs.has(String(row.zentrades_id)) }))
      .filter(Boolean);
    await db.bulkUpsertByExternalRef("contacts", CONTACT_FIELDS, argsList);
    return argsList.length;
  }

  async _normalizeTechnicians(companyId) {
    const raw = await db.fetchAllByCompanyChunked(companyId, "zentrades_technicians");
    const argsList = raw.map((row) => normalize.normalizeTechnician(row, { companyId })).filter(Boolean);
    await db.bulkUpsertByExternalRef("technicians", TECHNICIAN_FIELDS, argsList);
    return argsList.length;
  }

  async _normalizeLocations(companyId, rawLocations, primaryRawRefByLocation) {
    const [customersMap, contactsMap] = await Promise.all([
      refMap(companyId, "customers"),
      refMap(companyId, "contacts"),
    ]);
    const argsList = rawLocations
      .map((row) => {
        const customerId = row.zentrades_customer_id != null ? customersMap.get(String(row.zentrades_customer_id)) ?? null : null;
        const primaryRef = primaryRawRefByLocation.get(String(row.zentrades_id));
        const primaryContactId = primaryRef != null ? contactsMap.get(primaryRef) ?? null : null;
        return normalize.normalizeLocation(row, { companyId, customerId, primaryContactId });
      })
      .filter(Boolean);
    await db.bulkUpsertByExternalRef("locations", LOCATION_FIELDS, argsList);
    return argsList.length;
  }

  async _normalizeJobs(companyId, rawTickets) {
    const [customersMap, locationsMap, techniciansMap] = await Promise.all([
      refMap(companyId, "customers"),
      refMap(companyId, "locations"),
      refMap(companyId, "technicians"),
    ]);
    // primary_contact_id on the job mirrors its location's own primary
    // contact — read straight off the already-normalized locations row
    // rather than re-deriving it, so the two never disagree (same pattern
    // as InspectPointProvider._normalizeJobs).
    const { rows: locationRows } = await db.query(
      `SELECT id, primary_contact_id FROM locations WHERE company_id = $1 AND source = $2`,
      [companyId, SOURCE]
    );
    const primaryContactByLocationId = new Map(locationRows.map((r) => [r.id, r.primary_contact_id]));

    const argsList = rawTickets
      .map((row) => {
        const p = row.payload || {};
        const customerId = row.zentrades_customer_id != null ? customersMap.get(String(row.zentrades_customer_id)) ?? null : null;
        const locationId = row.zentrades_location_id != null ? locationsMap.get(String(row.zentrades_location_id)) ?? null : null;
        const primaryContactId = locationId != null ? primaryContactByLocationId.get(locationId) ?? null : null;
        // Best-effort only — see normalizeJob's doc comment on why "the"
        // technician for a ticket is ambiguous. Earliest live assignment,
        // for list/filter convenience; appointments carry the real one.
        const liveAssignments = (Array.isArray(p.assignments) ? p.assignments : [])
          .filter((a) => a && a.isActive !== false && a.isDeleted !== true && a.startTime)
          .sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
        const technicianId = liveAssignments[0]?.technicianId != null
          ? techniciansMap.get(String(liveAssignments[0].technicianId)) ?? null
          : null;
        return normalize.normalizeJob(row, { companyId, customerId, locationId, technicianId, primaryContactId });
      })
      .filter(Boolean);
    await db.bulkUpsertByExternalRef("jobs", JOB_FIELDS, argsList);
    return argsList.length;
  }

  async _normalizeAppointments(companyId) {
    const raw = await db.fetchAllByCompanyChunked(companyId, "zentrades_appointments");
    const [jobsMap, techniciansMap] = await Promise.all([
      refMap(companyId, "jobs"),
      refMap(companyId, "technicians"),
    ]);
    const argsList = raw
      .map((row) => {
        const jobId = row.zentrades_ticket_id != null ? jobsMap.get(String(row.zentrades_ticket_id)) ?? null : null;
        const technicianId = row.zentrades_technician_id != null ? techniciansMap.get(String(row.zentrades_technician_id)) ?? null : null;
        return normalize.normalizeAppointment(row, { companyId, jobId, technicianId });
      })
      .filter(Boolean);
    await db.bulkUpsertByExternalRef("appointments", APPOINTMENT_FIELDS, argsList);
    return argsList.length;
  }
}

// ── Field descriptors for db.bulkUpsertByExternalRef ────────────────────────

const CUSTOMER_FIELDS = [
  { column: "full_name", key: "fullName" },
  { column: "email", key: "email" },
  { column: "phone", key: "phone" },
  { column: "address_line1", key: "addressLine1" },
  { column: "city", key: "city" },
  { column: "state", key: "state" },
  { column: "zipcode", key: "zipcode" },
  { column: "country", key: "country", transform: (v) => v || "US" },
  { column: "is_active", key: "isActive", transform: (v) => v !== false },
];

const LOCATION_FIELDS = [
  { column: "customer_id", key: "customerId" },
  { column: "primary_contact_id", key: "primaryContactId" },
  { column: "name", key: "name" },
  { column: "lat", key: "lat" },
  { column: "lon", key: "lon" },
  { column: "phone", key: "phone" },
  { column: "email", key: "email" },
  { column: "general_manager_name", key: "generalManagerName" },
  { column: "address_line1", key: "addressLine1" },
  { column: "city", key: "city" },
  { column: "state", key: "state" },
  { column: "zipcode", key: "zipcode" },
  { column: "country", key: "country", transform: (v) => v || "US" },
  { column: "taxable", key: "taxable" },
  { column: "company", key: "company", jsonb: true },
  { column: "brand", key: "brand", jsonb: true },
  { column: "is_active", key: "isActive", transform: (v) => v !== false },
];

const CONTACT_FIELDS = [
  { column: "first_name", key: "firstName" },
  { column: "last_name", key: "lastName" },
  { column: "phone", key: "phone" },
  { column: "mobile", key: "mobile" },
  { column: "alternate_phone", key: "alternatePhone" },
  { column: "email", key: "email" },
  { column: "type", key: "type" },
  { column: "types", key: "types", jsonb: true },
  { column: "contact_role", key: "contactRole", transform: (v) => v || "general" },
];

const TECHNICIAN_FIELDS = [
  { column: "first_name", key: "firstName" },
  { column: "last_name", key: "lastName" },
  { column: "email", key: "email" },
  { column: "phone", key: "phone" },
  { column: "is_active", key: "isActive", transform: (v) => v !== false },
];

const JOB_FIELDS = [
  { column: "customer_id", key: "customerId" },
  { column: "location_id", key: "locationId" },
  { column: "technician_id", key: "technicianId" },
  { column: "primary_contact_id", key: "primaryContactId" },
  { column: "title", key: "title" },
  { column: "description", key: "description" },
  { column: "job_type", key: "jobType" },
  { column: "status", key: "status", transform: (v) => v || "open" },
  { column: "scheduled_date", key: "scheduledDate" },
  { column: "scheduled_window_start", key: "scheduledWindowStart" },
  { column: "scheduled_window_end", key: "scheduledWindowEnd" },
  { column: "job_number", key: "jobNumber" },
  { column: "external_ids", key: "externalIds", jsonb: true },
];

const APPOINTMENT_FIELDS = [
  { column: "job_id", key: "jobId" },
  { column: "technician_id", key: "technicianId" },
  { column: "scheduled_start", key: "scheduledStart" },
  { column: "scheduled_end", key: "scheduledEnd" },
  {
    column: "status",
    key: "status",
    transform: (v) => v || "scheduled",
    // ZenTrades has no 'confirmed' state of its own either (same situation
    // as InspectPoint) — a plain overwrite here would reset every
    // appointment our agent confirmed back to 'scheduled' on the very next
    // sync, silently undoing real confirmations.
    updateExpr: `status = CASE WHEN appointments.status IN ('confirmed','rescheduled','cancelled') THEN appointments.status ELSE EXCLUDED.status END`,
  },
  { column: "duration", key: "duration" },
];

module.exports = new ZenTradesProvider();
