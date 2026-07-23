/**
 * Shareable chat links — a third way to reach the same conversation flow,
 * alongside voice and SMS. A staff member generates an opaque-token link for a
 * specific job or appointment; opening it (no auth — the token itself is the
 * credential) resolves the chat agent + dynamic-variable context a frontend
 * needs to embed Retell's chat widget. See chat-link-widget-frontend.md.
 *
 * Reuses the same per-target hydrators call-hydration.js already built for the
 * manual-call API — same job/appointment → context resolution, no duplicate queries.
 */

const chatLinksDb = require("../db/chat-links");
const { HYDRATORS } = require("./call-hydration");
const db = require("../db");
const { formatSpokenDateTime, formatSpokenDateOnly } = require("../utils/timezone");

function buildDynamicVariables(params, { callType, isAppointment, tz }) {
  return {
    call_type: callType,
    ...(params.customerName && { customer_name: params.customerName }),
    ...(params.customerAddress && { customer_address: params.customerAddress }),
    ...(params.jobName && { job_name: params.jobName }),
    ...(params.jobDescription && { job_description: params.jobDescription }),
    ...(params.jobType && { job_type: params.jobType }),
    ...(params.jobDate && {
      job_date: isAppointment
        ? formatSpokenDateTime(new Date(params.jobDate).toISOString(), tz)
        : formatSpokenDateOnly(params.jobDate),
    }),
    ...(params.appointmentId && { appointment_id: String(params.appointmentId) }),
    job_id: String(params.jobId),
  };
}

async function createChatLinkForAppointment(companyId, appointmentId, callType = "customer_confirmation") {
  const hydrated = await HYDRATORS.scheduled_unconfirmed(companyId, appointmentId);
  if (!hydrated.ok) return hydrated;

  const existing = await chatLinksDb.findByAppointment(companyId, appointmentId);
  if (existing) return { ok: true, token: existing.token };

  const row = await chatLinksDb.create({
    companyId, jobId: Number(hydrated.jobId), appointmentId, callType,
  });
  return { ok: true, token: row.token };
}

async function createChatLinkForJob(companyId, jobId, callType = "customer_confirmation") {
  const hydrated = await HYDRATORS.open_job_due_soon(companyId, jobId);
  if (!hydrated.ok) return hydrated;

  const existing = await chatLinksDb.findByJob(companyId, jobId);
  if (existing) return { ok: true, token: existing.token };

  const row = await chatLinksDb.create({
    companyId, jobId: Number(jobId), appointmentId: null, callType,
  });
  return { ok: true, token: row.token };
}

async function resolveChatLink(token) {
  const link = await chatLinksDb.getByToken(token);
  if (!link) return { ok: false, status: 404, error: "Chat link not found or expired" };

  const { rows: coRows } = await db.query(
    `SELECT retell_chat_agent_id, name, default_timezone FROM companies WHERE id = $1`,
    [link.company_id]
  );
  const company = coRows[0];
  if (!company?.retell_chat_agent_id) {
    return { ok: false, status: 503, error: "Chat is not yet available for this company" };
  }

  const hydrated = link.appointment_id
    ? await HYDRATORS.scheduled_unconfirmed(link.company_id, link.appointment_id)
    : await HYDRATORS.open_job_due_soon(link.company_id, link.job_id);
  if (!hydrated.ok) return hydrated;

  await chatLinksDb.markOpened(link.id);

  const tz = company.default_timezone || "America/New_York";
  const dynamicVariables = buildDynamicVariables(hydrated.params, {
    callType: link.call_type,
    isAppointment: !!link.appointment_id,
    tz,
  });

  return {
    ok: true,
    chat_agent_id: company.retell_chat_agent_id,
    company_name: company.name,
    job_name: hydrated.params.jobName || null,
    customer_name: hydrated.params.customerName || null,
    dynamic_variables: dynamicVariables,
  };
}

module.exports = { createChatLinkForAppointment, createChatLinkForJob, resolveChatLink };
