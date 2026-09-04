const test = require("node:test");
const assert = require("node:assert/strict");
const { stub, silentLogger } = require("./helpers/stub-modules");
stub("utils/logger", silentLogger());
stub("db", { query: async () => ({ rows: [{ name: "Acme", default_timezone: "America/New_York", phone_number: null, representative_name: "Clara" }] }) });
stub("db/chat-links", {
  getByToken: async () => ({ id: 1, token: "t", company_id: 7, job_id: 900, call_type: "customer_confirmation", state: "confirming", status: "open" }),
  markOpened: async () => {},
});
stub("services/call-hydration", { HYDRATORS: new Proxy({}, { get: () => async () => ({ ok: true, params: { jobName: "J", customerName: "C", jobDate: null } }) }) });
stub("confirmation-agent", { ensureOpened: async () => ({ messages: [], recipientName: null, recipientEmail: null, recipientPhone: null }) });
stub("services/chat-link-email", {});
stub("services/chat-link-sms", {});
stub("services/job-confirmation-context", { buildJobConfirmationContext: async () => ({ ok: true, counts: {} }) });
stub("confirmation-agent/appointment-card", { buildAppointmentCards: () => [] });
stub("db/onsite-instructions", { listByCompany: async () => [] });
stub("db/service-link-messages", { getByRetellCallId: async () => null });

let slug = "servicetrade";
stub("services/crm", { resolveSlugForCompany: async () => slug });
stub("confirmation-agent/workflows", {
  getWorkflow: (s) => s === "inspectpoint"
    ? { slug: "inspectpoint", capabilities: { serviceLink: false, slotSuggestion: true, cancellationReason: "optional" } }
    : { slug: "servicetrade", capabilities: { serviceLink: true, slotSuggestion: false } },
});

const svc = require("../src/services/chat-links");

test("bootstrap exposes ServiceTrade capabilities: reason required, service link on", async () => {
  slug = "servicetrade";
  const r = await svc.resolveChatLink("t");
  assert.equal(r.crm, "servicetrade");
  assert.deepEqual(r.capabilities, { service_link: true, slot_suggestion: false, cancellation_reason: "required" });
});

test("bootstrap exposes InspectPoint capabilities — the flag the widget needs to allow an empty cancel reason", async () => {
  slug = "inspectpoint";
  const r = await svc.resolveChatLink("t");
  assert.equal(r.crm, "inspectpoint");
  assert.deepEqual(r.capabilities, { service_link: false, slot_suggestion: true, cancellation_reason: "optional" });
});
