/**
 * Mint/return the live ServiceTrade service-link URL for this job. Thin
 * LLM-tool wrapper over actions.js's mintServiceLinkCore. The URL is
 * displayed to the customer automatically as a preview card by the frontend,
 * never pasted as raw text by the agent.
 */
const { z } = require("zod");
const { mintServiceLinkCore } = require("../../actions");

const schema = z.object({});

async function run(_args, config) {
  const { companyId, jobId, jobRef, threadId, recipientContactId } = config?.configurable?.ctx || {};
  const result = await mintServiceLinkCore({ companyId, jobId, jobRef, threadId, recipientContactId });
  return JSON.stringify(result);
}

module.exports = {
  name: "get_service_link",
  description: "Get the live link for this job so the customer can track it. Only call this after the customer has agreed to receive one and (if needed) resolve_service_link_contact has succeeded.",
  schema,
  run,
};
