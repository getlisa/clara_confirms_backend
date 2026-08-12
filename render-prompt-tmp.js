// Render the chat agent's system prompt.
//
//   node render-prompt-tmp.js <companyId> [jobId]
//   node render-prompt-tmp.js <companyId> --template
//
// The chat agent has no Retell-style {{variables}}: the graph injects live job
// data straight into the system prompt on every turn (see graph/build.js). The
// --template mode feeds placeholder tokens through the SAME builder so the
// structure is visible without one job's values baked in.
const prompt = require("./src/confirmation-agent/graph/prompt");
const { buildJobConfirmationContext } = require("./src/services/job-confirmation-context");
const { phaseFromContext } = require("./src/confirmation-agent/graph/build");
const serviceLineDescriptionsDb = require("./src/db/service-line-descriptions");
const db = require("./src/db");
const fs = require("fs");

const COMPANY = Number(process.argv[2] || 9);
const ARG = process.argv[3];

async function pickJob(companyId) {
  const { rows } = await db.query(
    `SELECT j.id, j.title, count(a.id)::int AS appts
       FROM jobs j
       JOIN appointments a ON a.job_id = j.id
      WHERE j.company_id = $1
        AND a.status IN ('scheduled','rescheduled')
        AND a.customer_confirmed IS DISTINCT FROM true
        AND a.scheduled_start > NOW()
      GROUP BY j.id, j.title
      ORDER BY count(a.id) DESC
      LIMIT 1`, [companyId]);
  return rows[0] || null;
}

/**
 * Take a REAL context and swap its leaf values for placeholder tokens.
 *
 * Building a fake context by hand kept breaking on fields the formatters
 * expect; starting from a real one guarantees the shape is right, so only the
 * values change.
 */
function templatize(ctx) {
  const c = JSON.parse(JSON.stringify(ctx));
  c.job.title = "{{job_name}}";
  c.job.job_number = "{{job_number}}";
  if (c.job.description) c.job.description = "{{job_description}}";
  if (c.job.comments?.length) c.job.comments = ["{{job_comments}}"];
  if (c.job.customer) c.job.customer.name = "{{customer_name}}";

  const stamp = (a, i) => {
    const p = i === 0 ? "next_" : "other_";
    a.appointment_id = `{{${p}appointment_id}}`;
    a.scheduled_start_spoken = `{{${p}appointment_date}}`;
    if (a.arrival_window_spoken !== null) a.arrival_window_spoken = `{{${p}arrival_window}}`;
    if (a.service_details?.length) {
      a.service_details = [{ service_line: `{{${p}service_line}}`, description: `{{${p}appointment_services}}` }];
    }
    if (a.service_lines?.length) a.service_lines = [`{{${p}service_line}}`];
    if (a.service_line) a.service_line = `{{${p}service_line}}`;
    if (a.service_summary) a.service_summary = `{{${p}service_line}}`;
    if (a.technician_names?.length) a.technician_names = [`{{${p}technicians}}`];
    if (a.technician) a.technician = `{{${p}technicians}}`;
    if (a.technician_summary) a.technician_summary = `{{${p}technicians}}`;
    if (a.technicians?.length) a.technicians = [{ name: `{{${p}technicians}}`, phone: "{{technician_phone}}", email: "{{technician_email}}" }];
    return a;
  };
  (c.appointments?.upcoming || []).forEach(stamp);
  (c.appointments?.past || []).forEach((a) => stamp(a, 1));
  return c;
}

(async () => {
  const template = ARG === "--template";
  const job = template || !ARG ? await pickJob(COMPANY) : { id: Number(ARG) };
  if (!job) { console.error("no unconfirmed upcoming job found for company " + COMPANY); process.exit(1); }
  let ctx = await buildJobConfirmationContext(COMPANY, job.id);
  const phase = phaseFromContext(ctx);
  if (template) ctx = templatize(ctx);
  const label = template
    ? `company ${COMPANY} — TEMPLATE (real shape from job ${job.id}, values replaced)`
    : `company ${COMPANY} — job ${job.id}`;

  const descriptions = await serviceLineDescriptionsDb.listByCompany(COMPANY).catch(() => []);
  const out = prompt.build({ ...ctx, phase }, {
    companyName: "{{company_name}}",
    isOpeningTurn: false,
    confirmedByOtherLabel: null,
    serviceLineDescriptions: descriptions,
    recipientName: "{{customer_name}}",
    recipientEmail: "{{customer_email}}",
    recipientPhone: "{{customer_phone}}",
  });

  const file = ARG === "--template" ? "chat-agent-prompt.template.txt" : "chat-agent-prompt.txt";
  fs.writeFileSync(file, out);
  console.log(`${label} | phase: ${phase} | ${out.length} chars | ${out.split("\n").length} lines | -> ${file}\n`);
  console.log(out);
  process.exit(0);
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
