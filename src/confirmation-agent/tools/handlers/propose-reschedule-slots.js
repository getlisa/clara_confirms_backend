/**
 * Look up real open windows on the technician already assigned to an
 * appointment, instead of the agent asking the customer to name a time
 * blind (Phase 6). Capability-gated by workflows/*.js's slotSuggestion flag
 * — see tools/registry.js's CAPABILITY_TOOLS — so this is only ever bound
 * for a CRM whose workflow module opts in (InspectPoint today).
 *
 * Delegates the actual search + hold placement to
 * services/technician-availability.js's offerSlots, which both this handler
 * and routes/retell-tools.js's POST /propose_reschedule_slots call — the
 * only thing that differs between the two channels is this file's shape.
 */
const { z } = require("zod");
const jobsDb = require("../../../db/jobs");
const technicianAvailability = require("../../../services/technician-availability");
const { getCompanyTimezone, localToUTC, toOffsetISOString, formatSpokenDateTime } = require("../../../utils/timezone");
const logger = require("../../../utils/logger");

const SEARCH_HORIZON_DAYS = 14;

const schema = z.object({
  appointment_id: z.union([z.string(), z.number()]).describe("The appointment being rescheduled — its assigned technician's calendar is what gets searched."),
  preferred_date: z.string().nullish().describe("The date the customer mentioned wanting, format YYYY-MM-DD. Search starts from here; omit to search starting today."),
});

async function run({ appointment_id, preferred_date }, config) {
  const { companyId, threadId } = config?.configurable?.ctx || {};

  const appointment = await jobsDb.getAppointmentById(Number(appointment_id), companyId);
  if (!appointment) return JSON.stringify({ success: false, error: "Appointment not found" });
  if (!appointment.technician_id) {
    return JSON.stringify({
      success: false,
      error: "No technician is assigned to this appointment yet, so there is no calendar to search — ask the customer for a preferred time instead.",
    });
  }

  const tz = await getCompanyTimezone(companyId);
  const windowStart = preferred_date ? localToUTC(`${preferred_date}T00:00:00`, tz) : new Date().toISOString();
  const windowEnd = new Date(new Date(windowStart).getTime() + SEARCH_HORIZON_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const slots = await technicianAvailability.offerSlots({
    companyId, technicianId: appointment.technician_id, heldByToken: threadId,
    windowStart, windowEnd, excludeAppointmentId: appointment.id,
  });

  logger.info("ConfirmationAgent tool: propose_reschedule_slots", {
    companyId, appointment_id, technicianId: appointment.technician_id, offered: slots.length,
  });

  if (slots.length === 0) {
    return JSON.stringify({ success: true, slots: [], message: "No open times found in the next two weeks for this technician." });
  }

  return JSON.stringify({
    success: true,
    slots: slots.map((s) => ({
      // scheduled_start round-trips straight into reschedule_appointment's
      // own argument of the same name — same offset-ISO shape localToUTC
      // there already knows how to strip and reinterpret.
      scheduled_start: toOffsetISOString(s.starts_at, tz),
      scheduled_start_spoken: formatSpokenDateTime(s.starts_at, tz),
    })),
  });
}

module.exports = {
  name: "propose_reschedule_slots",
  description: "Look up real open time windows for the technician already assigned to an appointment, instead of asking the customer to name a time blind. Offered windows are held for a few minutes so another conversation can't be offered the same slot — call reschedule_appointment with one of the returned scheduled_start values while it's still fresh.",
  schema,
  run,
};
