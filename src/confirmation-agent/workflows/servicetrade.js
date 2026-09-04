/**
 * The ServiceTrade confirmation-chat workflow.
 *
 * This is the CRM-specific half of the chat agent: which capabilities the
 * CRM actually has, and the must-hit spine of its confirmation
 * conversation. Everything generic (appointment data, onsite expectations,
 * arrival window, ending) stays in graph/prompt.js and applies to every CRM.
 *
 * WHY THE PROSE LIVES HERE, not in prompt.js: that file's header says
 * sections live in prompt.js, and for every CRM-agnostic section they do.
 * This checklist is the one thing that is genuinely per-CRM — a CRM without
 * a customer-facing job link, or with a different confirmation sequence,
 * needs its own. Keeping it beside its own capability flags is the seam.
 * prompt.js renders it through a wrapper that adds the standard section
 * header, so framing stays identical across workflows.
 */

/**
 * The must-hit spine. CASE A then details each branch; this exists so the
 * sequence itself can't be skipped or reordered, which is exactly what went
 * wrong live (the agent interrogated for contact details it already had,
 * then announced the service link instead of offering it).
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

4. After a confirmation succeeds, ASK whether they'd like the service link
   emailed to them (see SERVICE LINK below). It is an offer, not an
   announcement — send it only if they say yes.
`;
}

module.exports = {
  slug: "servicetrade",
  // Read by BOTH graph/prompt.js's build() (which sections appear) and
  // tools/registry.js's getToolsForPhase (which tools are bound). A CRM
  // with no customer-facing job-tracking link sets serviceLink:false and
  // the SERVICE LINK section plus resolve_service_link_contact/
  // get_service_link vanish together — the same "constrain what's
  // structurally possible rather than instructing against it" principle
  // PHASE_TOOLS already applies to phases.
  // slotSuggestion is explicitly OFF here (Phase 6): the underlying
  // technician-availability service is CRM-agnostic and would work fine
  // against ServiceTrade-synced data, but ServiceTrade has years of existing
  // live customers on the current "ask for a time, just write it" flow —
  // turning on a brand-new soft-hold/race-handling code path for all of them
  // by default is a rollout decision for later, not an automatic side effect
  // of building it for InspectPoint's launch. See workflows/inspectpoint.js.
  capabilities: { serviceLink: true, slotSuggestion: false },
  checklist,
};
