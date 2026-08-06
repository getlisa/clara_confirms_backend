/**
 * Mint/return the live ServiceTrade service-link URL for this job. Mirrors
 * retell-tools.js's POST /get_service_link — the URL is displayed to the
 * customer automatically as a preview card by the frontend (see
 * chat-links.js's filterVisibleMessages), never pasted as raw text by the
 * agent.
 */
const { z } = require("zod");
const db = require("../../../db");
const serviceLink = require("../../../services/servicetrade-service-link");
const chatLinksDb = require("../../../db/chat-links");
const logger = require("../../../utils/logger");

const schema = z.object({});

async function run(_args, config) {
  const { companyId, jobId, jobRef, threadId } = config?.configurable?.ctx || {};
  if (!jobRef) return JSON.stringify({ success: false, error: "No ServiceTrade job found for this conversation" });

  const minted = await serviceLink.mintServiceLinkUrl(companyId, jobRef);
  if (!minted.ok) {
    logger.error("ConfirmationAgent get_service_link: mint failed", { companyId, error: minted.error, status: minted.status });
    return JSON.stringify({ success: false, error: minted.error });
  }

  const { rows: jobRows } = await db.query(`SELECT title FROM jobs WHERE id = $1 AND company_id = $2`, [jobId, companyId]);
  const jobName = jobRows[0]?.title ?? null;

  if (threadId) await chatLinksDb.setStateByToken(threadId, "service_link_sent").catch(() => {});
  logger.info("ConfirmationAgent tool: get_service_link", { companyId, jobId });
  return JSON.stringify({ success: true, url: minted.url, job_name: jobName });
}

module.exports = {
  name: "get_service_link",
  description: "Get the live link for this job so the customer can track it. Only call this after the customer has agreed to receive one and (if needed) resolve_service_link_contact has succeeded.",
  schema,
  run,
};
