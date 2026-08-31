/**
 * Combine a company's onsite_instructions rows (db/onsite-instructions.js —
 * every row, unfiltered) for one appointment: every general row
 * (service_line IS NULL) plus every row scoped to this appointment's own
 * service_line — an EXACT match, not the soft LLM judgment
 * service_line_descriptions (migration 084) uses, since service_line is a
 * real structured field on every appointment (job-confirmation-context.js).
 *
 * Used both for the free-text prompt (graph/prompt.js's ONSITE_EXPECTATIONS)
 * and for the card payload (appointment-card.js) — the same resolved list
 * either way, so a card-driven confirmation and a typed one never diverge.
 */
function resolveOnsiteInstructions(all, serviceLine) {
  return (all || []).filter((row) => row.service_line == null || row.service_line === serviceLine);
}

module.exports = { resolveOnsiteInstructions };
