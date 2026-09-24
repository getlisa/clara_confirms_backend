/**
 * The ZenTrades confirmation-chat workflow.
 *
 * Same structural role as workflows/servicetrade.js/inspectpoint.js — see
 * that file's header for why this prose lives here rather than in
 * graph/prompt.js. ZenTrades has no customer-facing job-tracking link
 * (serviceLink: false, same as InspectPoint) and no slot-suggestion
 * capability yet (slotSuggestion: false, same as ServiceTrade) — write-back
 * doesn't exist for this CRM at all yet (see
 * src/services/crm/zentrades/provider.js's header), so there is nothing to
 * propose a slot INTO. Revisit slotSuggestion once write-back lands.
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

4. Once the change is made (or the reschedule/cancel is settled), move
   straight to wrapping up. There is nothing to offer or send afterwards.
`;
}

module.exports = {
  slug: "zentrades",
  capabilities: { serviceLink: false, slotSuggestion: false },
  checklist,
};
