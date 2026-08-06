/**
 * Export full job context for one company (customer, location, owner,
 * appointments, contacts, comments/notes), then ask gpt-4o-mini to read each
 * job's comments and decide whether the job is confirmed.
 *
 * Usage:
 *   node scripts/export-company-job-confirmations.js --company=9
 *   node scripts/export-company-job-confirmations.js            (defaults to company 9)
 *
 * Writes out/company-<id>-job-confirmations.json
 *
 * Requires OPENAI_API_KEY in the environment.
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");

const db = require("../src/db");
const jobsDb = require("../src/db/jobs");
const locationsDb = require("../src/db/locations");

const OPENAI_MODEL = "gpt-4o-mini";
const LLM_CONCURRENCY = 5;
const OUTPUT_DIR = path.join(__dirname, "..", "out");

function arg(name) {
  const flag = process.argv.find((a) => a.startsWith(`--${name}=`));
  return flag ? flag.split("=").slice(1).join("=") : null;
}

async function fetchJobIds(companyId) {
  const { rows } = await db.query(
    "SELECT id FROM jobs WHERE company_id = $1 ORDER BY id",
    [companyId]
  );
  return rows.map((r) => r.id);
}

/** scheduling_comments + job_notes + this job's appointment_notes, oldest first. */
async function fetchJobComments(companyId, jobId, appointmentIds) {
  const [comments, notes, apptNotes] = await Promise.all([
    db.query(
      `SELECT content, created_at FROM scheduling_comments
        WHERE company_id = $1 AND job_id = $2 AND content IS NOT NULL AND content <> ''
        ORDER BY created_at ASC`,
      [companyId, jobId]
    ),
    db.query(
      `SELECT type, text, created_at FROM job_notes
        WHERE company_id = $1 AND job_id = $2 AND text IS NOT NULL AND text <> ''
        ORDER BY created_at ASC`,
      [companyId, jobId]
    ),
    appointmentIds.length
      ? db.query(
          `SELECT type, text, created_at FROM appointment_notes
            WHERE company_id = $1 AND appointment_id = ANY($2::int[]) AND text IS NOT NULL AND text <> ''
            ORDER BY created_at ASC`,
          [companyId, appointmentIds]
        )
      : { rows: [] },
  ]);

  return [
    ...comments.rows.map((r) => ({ source: "scheduling_comment", type: null, text: r.content, created_at: r.created_at })),
    ...notes.rows.map((r) => ({ source: "job_note", type: r.type ?? null, text: r.text, created_at: r.created_at })),
    ...apptNotes.rows.map((r) => ({ source: "appointment_note", type: r.type ?? null, text: r.text, created_at: r.created_at })),
  ].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
}

/** Full context for one job: customer/technician/appointments/contacts/quotations (via getJobById), plus location and comments. */
async function buildJobContext(companyId, jobId) {
  const job = await jobsDb.getJobById(jobId, companyId);
  if (!job) return null;

  const [{ rows: locRows }, comments] = await Promise.all([
    db.query("SELECT location_id FROM jobs WHERE id = $1 AND company_id = $2", [jobId, companyId]),
    fetchJobComments(companyId, jobId, job.appointments.map((a) => a.id)),
  ]);
  const locationId = locRows[0]?.location_id ?? null;
  const location = locationId ? await locationsDb.getById(locationId, companyId) : null;
  const owner = job.contacts.find((c) => c.role === "job_owner") ?? null;

  return { ...job, location, owner, comments };
}

const CONFIRMATION_SCHEMA = {
  name: "job_confirmation_assessment",
  strict: true,
  schema: {
    type: "object",
    properties: {
      confirmed: { type: "string", enum: ["yes", "no", "unclear"] },
      confidence: { type: "number" },
      reasoning: { type: "string" },
      evidence: { type: ["string", "null"] },
    },
    required: ["confirmed", "confidence", "reasoning", "evidence"],
    additionalProperties: false,
  },
};

function buildPrompt(job) {
  const commentLines = job.comments
    .map((c) => `[${c.created_at}] (${c.source}${c.type ? `/${c.type}` : ""}) ${c.text}`)
    .join("\n");
  return `Job #${job.job_number ?? job.id} for customer "${job.customer?.full_name ?? "unknown"}".

Comments and notes on this job, oldest first:
${commentLines || "(none)"}

Based ONLY on the comments and notes above, decide whether the customer has confirmed this job/appointment.
- "yes" if a comment clearly states the customer confirmed (e.g. spoke to customer, confirmed via call/text/email).
- "no" if a comment clearly states the customer declined, cancelled, or asked to reschedule.
- "unclear" if there are no comments, or nothing in them addresses confirmation status.
Quote the specific comment text that supports your answer in "evidence" (or null if unclear).`;
}

async function analyzeJob(openai, job) {
  if (job.comments.length === 0) {
    return { confirmed: "unclear", confidence: 1, reasoning: "No comments or notes on this job.", evidence: null };
  }
  const completion = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [
      { role: "system", content: "You audit field-service job comments to determine customer confirmation status. Be conservative — only say yes/no when the comments say so explicitly." },
      { role: "user", content: buildPrompt(job) },
    ],
    response_format: { type: "json_schema", json_schema: CONFIRMATION_SCHEMA },
  });
  return JSON.parse(completion.choices[0].message.content);
}

/** Runs `items` through `fn` with at most `limit` in flight at once. */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function run() {
  const companyId = Number(arg("company") || 9);
  if (!process.env.OPENAI_API_KEY) {
    console.error("Error: OPENAI_API_KEY is not set.");
    process.exit(1);
  }
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const jobIds = await fetchJobIds(companyId);
  console.log(`Company ${companyId}: found ${jobIds.length} jobs. Building context...`);

  const jobs = (await mapWithConcurrency(jobIds, LLM_CONCURRENCY, (id) => buildJobContext(companyId, id))).filter(Boolean);
  console.log(`Built context for ${jobs.length} jobs. Analyzing confirmation status with ${OPENAI_MODEL}...`);

  let done = 0;
  await mapWithConcurrency(jobs, LLM_CONCURRENCY, async (job) => {
    try {
      job.confirmation_analysis = await analyzeJob(openai, job);
    } catch (err) {
      job.confirmation_analysis = { confirmed: "unclear", confidence: 0, reasoning: `LLM error: ${err.message}`, evidence: null };
    }
    done++;
    if (done % 20 === 0 || done === jobs.length) console.log(`  analyzed ${done}/${jobs.length}`);
  });

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outPath = path.join(OUTPUT_DIR, `company-${companyId}-job-confirmations.json`);
  fs.writeFileSync(outPath, JSON.stringify({ company_id: companyId, job_count: jobs.length, jobs }, null, 2));

  const counts = jobs.reduce((acc, j) => {
    const k = j.confirmation_analysis.confirmed;
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
  console.log(`Wrote ${outPath}`);
  console.log("Confirmation breakdown:", counts);

  await db.close();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
