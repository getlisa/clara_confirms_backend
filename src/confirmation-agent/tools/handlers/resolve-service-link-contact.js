/**
 * Resolve who a ServiceTrade "service link" should be sent to. Thin LLM-tool
 * wrapper over actions.js's sendServiceLinkCore, with the email-confirmation
 * gate kept HERE (not in the core function) — the core function has no
 * `emailConfirmed` parameter at all, since the deterministic card-driven path
 * (POST /:token/messages, trigger: "send_service_link") only ever forces
 * `email_confirmed: true` via `ctx.cardTriggerArgs`, because the frontend's
 * own UI-level Yes/No step already happened before that call was ever made —
 * reaching this tool at all, on that path, IS the confirmation. The LLM path
 * still needs the gate, because free text is exactly the unreliable input
 * this whole feature exists to route around.
 *
 * `ctx.cardTriggerArgs` wins over the model's args on a card-driven turn —
 * the real values are already 100% known from the request body.
 */
const { z } = require("zod");
const { sendServiceLinkCore } = require("../../actions");
const logger = require("../../../utils/logger");

const schema = z.object({
  email: z.string().describe("The email address to send the service link to."),
  email_confirmed: z.boolean().describe(
    "Set true ONLY after the customer has explicitly confirmed this exact address in their reply — either agreeing to the one on file or giving you a new one. Never set true on an address you inferred, remembered, or read from context without asking."
  ),
  first_name: z.string().nullish().describe("Only if no existing contact matched this email."),
  last_name: z.string().nullish().describe("Only if no existing contact matched this email."),
  role: z.string().nullish().describe("e.g. management, billing, on-site, scheduling, owner — only if no existing contact matched."),
  phone: z.string().nullish(),
});

async function run(modelArgs, config) {
  const { companyId, jobId, threadId, jobRef, customerRef, cardTriggerArgs } = config?.configurable?.ctx || {};
  const { email, email_confirmed, first_name, last_name, role, phone } = { ...modelArgs, ...(cardTriggerArgs || {}) };

  // Hard gate, deliberately ahead of the CRM search. An unconfirmed address is
  // not just a bad send target — this tool CREATES a ServiceTrade contact when
  // nothing matches, so acting on a guess writes a junk contact into the
  // customer's CRM and mails a job link to whoever owns that address.
  if (email_confirmed !== true) {
    logger.info("resolve_service_link_contact: refused, email not confirmed by the customer", { companyId, jobId, threadId });
    return JSON.stringify({
      status: "needs_email_confirmation",
      email,
      message:
        `Do not send yet. Read ${email} back to the customer and ask if it is the right address ` +
        `(e.g. "I have ${email} — is that the best address for it?"). Call this tool again with ` +
        `email_confirmed=true once they say yes, or with the corrected address they give you.`,
    });
  }

  const result = await sendServiceLinkCore({
    companyId, jobId, threadId, jobRef, customerRef, email,
    firstName: first_name, lastName: last_name, role, phone,
  });
  // The core function's need_more_info shape has no `success` key parity issue
  // for the LLM path specifically — the ORIGINAL tool returned success:true
  // there (it isn't a failure, just an intermediate step), unlike the old
  // REST route which treated it as ok:false. Preserve the LLM-facing shape,
  // but pass `fields_needed` through too (harmless additive field for the
  // free-text path, and needed by the card-driven path so the frontend knows
  // which follow-up fields to collect without hardcoding them).
  if (result.status === "need_more_info") {
    return JSON.stringify({ success: true, status: "need_more_info", email, fields_needed: result.fields_needed });
  }
  return JSON.stringify(result);
}

module.exports = {
  name: "resolve_service_link_contact",
  description: "Find (or, only if needed, create) the ServiceTrade contact to send this job's service link to. Ask only for the email first — do not ask for name/role unless this tool responds with status 'need_more_info'.",
  schema,
  run,
};
