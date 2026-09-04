/**
 * Channel-agnostic technician availability + slot offering (Phase 6). Chat's
 * propose_reschedule_slots tool and voice's POST /propose_reschedule_slots
 * route both call this — the only thing that differs between them is the
 * request/response shape and how the conversation reacts, not the
 * availability logic itself.
 *
 * A technician is free for a candidate window when: no overlapping
 * `appointments` row (other than the one being rescheduled, if any), no live
 * `slot_holds` row from another conversation, and the window sits inside the
 * company's own dispatch hours (office-hours.js — the same business-hours
 * model call scheduling already uses, not a second concept).
 *
 * Honest blind spot, not fixed here (see the plan): InspectPoint Work Order
 * visits are never synced, so a technician on repair work still looks free.
 */
const db = require("../db");
const callSettingsDb = require("../db/call-settings");
const slotHoldsDb = require("../db/slot-holds");
const { getCompanyTimezone } = require("../utils/timezone");
const { isWithinActiveHours } = require("./office-hours");

const DEFAULT_DURATION_MINUTES = 120; // matches actions.js/retell-tools.js's own reschedule/create default
const DEFAULT_TTL_MINUTES = 10;
const STEP_MINUTES = 30;
const DEFAULT_MAX_RESULTS = 3;

async function getCompanySchedulingContext(companyId) {
  const [tz, settings] = await Promise.all([
    getCompanyTimezone(companyId),
    callSettingsDb.getByCompanyId(companyId),
  ]);
  return {
    tz,
    hours: {
      business_hours_start: settings.business_hours_start || "09:00",
      business_hours_end: settings.business_hours_end || "17:00",
      include_weekends: settings.include_weekends === true,
    },
  };
}

async function fetchBusyWindows(companyId, technicianId, windowStart, windowEnd, excludeAppointmentId) {
  const { rows } = await db.query(
    `SELECT scheduled_start, scheduled_end FROM appointments
     WHERE company_id = $1 AND technician_id = $2 AND status <> 'cancelled'
       AND scheduled_start IS NOT NULL
       AND scheduled_start < $4
       AND COALESCE(scheduled_end, scheduled_start + interval '2 hours') > $3
       ${excludeAppointmentId ? "AND id <> $5" : ""}`,
    excludeAppointmentId
      ? [companyId, technicianId, windowStart, windowEnd, excludeAppointmentId]
      : [companyId, technicianId, windowStart, windowEnd]
  );
  return rows.map((r) => ({
    start: new Date(r.scheduled_start),
    end: r.scheduled_end ? new Date(r.scheduled_end) : new Date(new Date(r.scheduled_start).getTime() + 2 * 60 * 60 * 1000),
  }));
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Earliest N open windows for one technician, in dispatch-hours order. Does
 * NOT place holds — see offerSlots below for that.
 *
 * @returns {Promise<{starts_at: string, ends_at: string}[]>}
 */
async function findAvailableSlots({
  companyId, technicianId,
  durationMinutes = DEFAULT_DURATION_MINUTES,
  windowStart, windowEnd,
  maxResults = DEFAULT_MAX_RESULTS,
  excludeAppointmentId = null,
}) {
  if (!companyId || !technicianId || !windowStart || !windowEnd) return [];

  const { tz, hours } = await getCompanySchedulingContext(companyId);
  const [busy, holds] = await Promise.all([
    fetchBusyWindows(companyId, technicianId, windowStart, windowEnd, excludeAppointmentId),
    slotHoldsDb.listActive({ companyId, technicianId, from: windowStart, to: windowEnd }),
  ]);
  const blocks = [...busy, ...holds.map((h) => ({ start: new Date(h.starts_at), end: new Date(h.ends_at) }))];

  const durationMs = durationMinutes * 60 * 1000;
  const stepMs = STEP_MINUTES * 60 * 1000;
  const rangeEnd = new Date(windowEnd).getTime();

  const results = [];
  let cursor = Math.ceil(new Date(windowStart).getTime() / stepMs) * stepMs;
  while (cursor + durationMs <= rangeEnd && results.length < maxResults) {
    const candidateStart = new Date(cursor);
    const candidateEnd = new Date(cursor + durationMs);
    const withinHours =
      isWithinActiveHours(hours, tz, candidateStart) &&
      isWithinActiveHours(hours, tz, new Date(candidateEnd.getTime() - 60_000));
    const blocked = blocks.some((b) => overlaps(candidateStart, candidateEnd, b.start, b.end));
    if (withinHours && !blocked) {
      results.push({ starts_at: candidateStart.toISOString(), ends_at: candidateEnd.toISOString() });
    }
    cursor += stepMs;
  }
  return results;
}

/**
 * Find open windows AND place a hold on each one returned, tagged with
 * `heldByToken` (the chat thread token or Retell call id). Holding at OFFER
 * time, not confirm time, is the whole point — a competing conversation
 * reading the same technician's calendar a moment later will see these
 * windows as busy and never read them out to a second customer.
 *
 * A slot that loses the hold race (another conversation grabbed it between
 * the availability read and the hold insert) is silently dropped rather than
 * surfaced as an error — the caller just gets fewer candidates back.
 */
async function offerSlots({
  companyId, technicianId, heldByToken,
  durationMinutes = DEFAULT_DURATION_MINUTES,
  windowStart, windowEnd,
  maxResults = DEFAULT_MAX_RESULTS,
  excludeAppointmentId = null,
  ttlMinutes = DEFAULT_TTL_MINUTES,
}) {
  const candidates = await findAvailableSlots({
    companyId, technicianId, durationMinutes, windowStart, windowEnd, maxResults, excludeAppointmentId,
  });
  const offered = [];
  for (const slot of candidates) {
    const result = await slotHoldsDb.hold({
      companyId, technicianId, startsAt: slot.starts_at, endsAt: slot.ends_at, heldByToken, ttlMinutes,
    });
    if (result.ok) offered.push(slot);
  }
  return offered;
}

module.exports = {
  DEFAULT_DURATION_MINUTES,
  DEFAULT_TTL_MINUTES,
  findAvailableSlots,
  offerSlots,
};
