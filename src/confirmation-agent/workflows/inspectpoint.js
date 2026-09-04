/**
 * The InspectPoint confirmation-chat workflow.
 *
 * See workflows/servicetrade.js's header for why this prose lives here
 * rather than in graph/prompt.js. InspectPoint's checklist differs from
 * ServiceTrade's in exactly the ways its capabilities differ: no service
 * link step (InspectPoint has no customer-facing job-tracking link at all —
 * capabilities.serviceLink: false already makes prompt.js omit that whole
 * section and tools/registry.js withhold resolve_service_link_contact/
 * get_service_link), and a reschedule can offer concrete slots
 * (capabilities.slotSuggestion — Phase 6) rather than only accepting
 * free-text time from the customer.
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
   If they want to reschedule, propose real open slots rather than asking
   them to name a time blind — and never offer a slot past this inspection's
   compliance due date without saying so explicitly.

4. Once the change is made (or the reschedule/cancel is settled), move
   straight to wrapping up. There is nothing to offer or send afterwards.
`;
}

module.exports = {
  slug: "inspectpoint",
  // serviceLink: false — no InspectPoint equivalent exists to send at all,
  // not merely a different implementation. slotSuggestion/cancellationReason
  // are read by tools/registry.js (Phase 6) and the cancel-appointment
  // card-trigger check (routes/chat-links.js) respectively.
  capabilities: { serviceLink: false, slotSuggestion: true, cancellationReason: "optional" },
  checklist,
};
