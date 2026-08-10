/**
 * Infer whether a job's ServiceTrade-synced comments/notes already show the
 * customer confirmed — shared by the sync pipeline
 * (crm/servicetrade/provider.js's normalizeAll) and the standalone report
 * script (scripts/export-company-job-confirmations.js), so the LLM prompt/
 * schema logic has one source of truth instead of two copies that can drift.
 *
 * `scheduling_comments`/`job_notes`/`appointment_notes` are real, human-
 * entered text synced FROM ServiceTrade (a CSR/tech writing e.g. "called
 * customer, confirmed for Tuesday") — a different signal from
 * `appointments.customer_confirmed`, which today is set only by our own
 * voice/SMS/chat confirmation flows. `inferJobConfirmations` is what lets a
 * routine sync recognize the ServiceTrade-side signal and fold it into that
 * same operational flag, so an appointment already confirmed by a
 * ServiceTrade phone call doesn't get a redundant dispatch from us.
 */

const OpenAI = require("openai");
const db = require("../db");
const { syncJobConfirmationStatus } = require("./job-confirmation-status");
const logger = require("../utils/logger");

// gpt-4.1-mini: chosen for latency. Inference runs once per job with an
// unconfirmed upcoming appointment, and the loop below is sequential, so
// per-call time directly sets how much of a sync slice this phase consumes.
//
// This is a deliberate step back toward a mini model after an earlier move to
// gpt-4o (which was made because a mini model's verdicts looked off). The
// classification rules in buildPrompt below — action-vs-fact ("call for
// confirm" is NOT a confirmation), recency-wins, no-comments-means-no — were
// re-verified against this model before switching; keep that check in mind if
// the model changes again, since those distinctions are the whole point.
const OPENAI_MODEL = "gpt-4.1-mini";
// Only a high-confidence "yes" auto-confirms — a wrong inference here
// silently suppresses a real confirmation dispatch, so this stays
// conservative.
const AUTO_CONFIRM_MIN_CONFIDENCE = 0.8;

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

/**
 * Every comment source for a job, oldest first: ServiceTrade's real
 * /comment stream (job_comments — usually the substantive one), plus the
 * job's schedulingComments/notes and its appointments' notes.
 */
async function fetchJobComments(companyId, jobId, appointmentIds) {
  const [comments, notes, apptNotes, jobComments] = await Promise.all([
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
    // ServiceTrade's real per-job comment stream. `commented_at` is
    // ServiceTrade's own `created`, not our sync time — the ordering below
    // is only meaningful because of that.
    db.query(
      `SELECT content, author_name, commented_at FROM job_comments
        WHERE company_id = $1 AND job_id = $2 AND content IS NOT NULL AND content <> ''
        ORDER BY commented_at ASC`,
      [companyId, jobId]
    ),
  ]);

  return [
    ...comments.rows.map((r) => ({ source: "scheduling_comment", type: null, text: r.content, created_at: r.created_at })),
    ...notes.rows.map((r) => ({ source: "job_note", type: r.type ?? null, text: r.text, created_at: r.created_at })),
    ...apptNotes.rows.map((r) => ({ source: "appointment_note", type: r.type ?? null, text: r.text, created_at: r.created_at })),
    ...jobComments.rows.map((r) => ({ source: "comment", type: r.author_name ? `by ${r.author_name}` : null, text: r.content, created_at: r.commented_at })),
  ].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
}

function buildPrompt({ jobNumber, customerName, comments }) {
  const commentLines = comments
    .map((c) => `[${c.created_at}] (${c.source}${c.type ? `/${c.type}` : ""}) ${c.text}`)
    .join("\n");
  return `Job #${jobNumber} for customer "${customerName ?? "unknown"}".

Comments and notes on this job, OLDEST FIRST (each line is prefixed with its timestamp):
${commentLines || "(none)"}

Decide, based ONLY on the comments above, whether the customer has ALREADY CONFIRMED this job's appointment.

Answer "yes" ONLY if a comment states the confirmation ALREADY HAPPENED — someone spoke with the customer and the customer agreed to the scheduled time. Examples: "spoke with customer, confirmed", "customer confirmed for Tuesday", "confirmed via text", "Call Angelo to confirm monday is a go and he is planning for it! ", "

Answer "no" if any of these hold:
- There are NO comments at all. No comment means nobody has confirmed anything.
- The comments only describe an INTENT, PLAN, TASK or REMINDER to confirm — not a confirmation that happened. Phrases like "call for confirm", "call to confirm", "need to confirm", "please confirm", "follow up to confirm", "confirmation call scheduled" are all instructions/reminders. They mean the confirmation has NOT happened yet. This distinction is the single most important rule here — do not treat a plan to confirm as a confirmation.
- A comment states the customer declined, cancelled, or asked to reschedule.

RECENCY DECIDES. The comments are in chronological order; a later comment overrides an earlier one. If the customer confirmed on Monday but a later comment says they called to reschedule, the answer is "no". Judge by the LATEST relevant comment, not the first one you find.

Quote the exact comment text driving your answer in "evidence" (or null if unclear).`;
}

async function analyzeJob(openai, { jobNumber, customerName, comments }) {
  const completion = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0, // deterministic classification — same input should give the same verdict every run
    messages: [
      { role: "system", content: "You audit field-service job comments to determine customer confirmation status. Be conservative — only say yes/no when the comments say so explicitly." },
      { role: "user", content: buildPrompt({ jobNumber, customerName, comments }) },
    ],
    response_format: { type: "json_schema", json_schema: CONFIRMATION_SCHEMA },
  });
  return JSON.parse(completion.choices[0].message.content);
}

/**
 * Assess every job in this company that still has an unconfirmed upcoming
 * appointment — the same "needs confirming" universe the dispatch scheduler
 * already targets. Skips the LLM call entirely when a job has no comments,
 * or when its comment count hasn't grown since the last assessment (nothing
 * new to re-read). Returns the number of jobs actually (re-)assessed.
 */
async function inferJobConfirmations(companyId) {
  if (!process.env.OPENAI_API_KEY) {
    logger.warn("inferJobConfirmations: OPENAI_API_KEY not set; skipping", { companyId });
    return 0;
  }
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const { rows: jobRows } = await db.query(
    `SELECT DISTINCT a.job_id
       FROM appointments a
      WHERE a.company_id = $1
        AND a.status IN ('scheduled', 'confirmed', 'rescheduled')
        AND a.scheduled_start > NOW()
        AND COALESCE(a.customer_confirmed, false) = false`,
    [companyId]
  );

  let assessed = 0;
  for (const { job_id: jobId } of jobRows) {
    try {
      const { rows: apptRows } = await db.query(
        `SELECT id FROM appointments WHERE company_id = $1 AND job_id = $2`,
        [companyId, jobId]
      );
      const appointmentIds = apptRows.map((r) => r.id);

      const comments = await fetchJobComments(companyId, jobId, appointmentIds);

      const { rows: existingRows } = await db.query(
        `SELECT comment_count FROM job_confirmation_assessments WHERE company_id = $1 AND job_id = $2`,
        [companyId, jobId]
      );
      if (existingRows.length && existingRows[0].comment_count === comments.length) continue;

      // No comments at all ⇒ not confirmed, recorded as a real assessment
      // rather than skipped. No LLM call needed — the answer is definitional,
      // and this is the most common case, so it also keeps cost near zero.
      if (comments.length === 0) {
        await db.query(
          `INSERT INTO job_confirmation_assessments
             (company_id, job_id, confirmed, confidence, reasoning, evidence, comment_count, checked_at)
           VALUES ($1, $2, 'no', 1, 'No comments or notes on this job — nothing indicates the customer confirmed.', NULL, 0, NOW())
           ON CONFLICT (company_id, job_id) DO UPDATE SET
             confirmed = 'no', confidence = 1,
             reasoning = 'No comments or notes on this job — nothing indicates the customer confirmed.',
             evidence = NULL, comment_count = 0, checked_at = NOW()`,
          [companyId, jobId]
        );
        assessed++;
        continue;
      }

      const { rows: jobInfoRows } = await db.query(
        `SELECT j.job_number, c.full_name AS customer_name
           FROM jobs j JOIN customers c ON c.id = j.customer_id
          WHERE j.id = $1 AND j.company_id = $2`,
        [jobId, companyId]
      );
      const jobInfo = jobInfoRows[0];
      if (!jobInfo) continue;

      const assessment = await analyzeJob(openai, {
        jobNumber: jobInfo.job_number ?? jobId,
        customerName: jobInfo.customer_name,
        comments,
      });

      await db.query(
        `INSERT INTO job_confirmation_assessments
           (company_id, job_id, confirmed, confidence, reasoning, evidence, comment_count, checked_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         ON CONFLICT (company_id, job_id) DO UPDATE SET
           confirmed = $3, confidence = $4, reasoning = $5, evidence = $6,
           comment_count = $7, checked_at = NOW()`,
        [companyId, jobId, assessment.confirmed, assessment.confidence, assessment.reasoning, assessment.evidence, comments.length]
      );

      if (assessment.confirmed === "yes" && assessment.confidence >= AUTO_CONFIRM_MIN_CONFIDENCE) {
        await db.query(
          `UPDATE appointments
              SET customer_confirmed = true, customer_confirmed_at = NOW(),
                  additional_information = COALESCE(additional_information, '{}'::jsonb)
                    || jsonb_build_object('confirmed_by_thread_id', 'servicetrade-sync', 'confirmed_by_label', 'ServiceTrade sync (per job notes)'),
                  updated_at = NOW()
            WHERE company_id = $1 AND job_id = $2
              AND status IN ('scheduled', 'confirmed', 'rescheduled') AND scheduled_start > NOW()
              AND COALESCE(customer_confirmed, false) = false`,
          [companyId, jobId]
        );
        await syncJobConfirmationStatus(companyId, jobId);
        logger.info("inferJobConfirmations: auto-confirmed job from ServiceTrade notes", { companyId, jobId, confidence: assessment.confidence });
      }

      assessed++;
    } catch (err) {
      logger.error("inferJobConfirmations: job assessment failed", { companyId, jobId, error: err.message });
    }
  }
  return assessed;
}

module.exports = {
  CONFIRMATION_SCHEMA,
  buildPrompt,
  fetchJobComments,
  analyzeJob,
  inferJobConfirmations,
  AUTO_CONFIRM_MIN_CONFIDENCE,
  OPENAI_MODEL,
};
