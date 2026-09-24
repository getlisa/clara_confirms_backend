/**
 * The CSV confirmation-chat workflow — for a company with no CRM, whose jobs
 * arrive by spreadsheet upload.
 *
 * See workflows/servicetrade.js's header for why this prose lives here rather
 * than in graph/prompt.js. This one is the leanest of the three, and the
 * capabilities say why:
 *
 *  - `serviceLink: false` — there is no customer-facing job-tracking link to
 *    send, so prompt.js omits that section and tools/registry.js withholds
 *    resolve_service_link_contact / get_service_link entirely.
 *  - `slotSuggestion: false` — slot suggestion needs technician availability,
 *    which needs a technician roster and their existing bookings. A CSV gives
 *    us one visit per row and, usually, no technician at all, so we would be
 *    offering slots against data we don't have. Accept a free-text time from
 *    the customer instead.
 *  - `cancellationReason: "optional"` — read by routes/chat-links.js's
 *    cancel-appointment card-trigger check. Set explicitly rather than
 *    inherited: falling back to the ServiceTrade workflow would make a reason
 *    mandatory, which only makes sense when a reason field round-trips into a
 *    CRM. Here it goes nowhere but our own record, so don't block a
 *    cancellation on it.
 *
 * The other thing worth knowing about this workflow: because there is no CRM,
 * every write-back mirror is a no-op (services/crm/csv/provider.js inherits
 * the base class's defaults). Whatever the agent agrees with the customer
 * lives in our tables and nowhere else, and the office sees it in Clara rather
 * than in a system of their own.
 */

function checklist(d) {
  return `These steps are REQUIRED and must happen in this order. Everything
else in this prompt describes HOW to do them well — this is the sequence
itself, and no step here is optional.

1. The customer opens the chat with three choices: confirm, request a
   reschedule, or cancel. Follow whichever they pick (see HANDLING THE
   CONFIRMATION below).

2. BEFORE you write anything — confirm, reschedule, or cancel — check who
   you're speaking with. Read back the details we already hold and get them
   confirmed or corrected (see WHO YOU'RE TALKING TO above). Never
   interrogate someone for details already on file.

3. Only once that's settled, make the actual change (${d.phase === "no_appointment" ? "create_appointment" : "confirm_appointment / reschedule_appointment / cancel_appointment"}).
   If they want to reschedule, ask what day and time suits them and record
   exactly that — do NOT offer specific slots or claim a time is available,
   because you cannot see the technician's calendar.

4. Once the change is made (or the reschedule/cancel is settled), move
   straight to wrapping up. There is nothing to offer or send afterwards.
`;
}

module.exports = {
  slug: "csv",
  capabilities: { serviceLink: false, slotSuggestion: false, cancellationReason: "optional" },
  checklist,
};
