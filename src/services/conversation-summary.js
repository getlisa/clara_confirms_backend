/**
 * One-line LLM summary of a completed confirmation conversation, for the
 * comment written back to the CRM.
 *
 * What this replaces: the call comment carried Retell's own generic summary
 * ("The agent called X to confirm two upcoming appointments…") and the chat
 * comment carried bare ids ("Customer confirmed appointment #110726."). Neither
 * told the office WHO agreed or WHICH service — the two things a dispatcher
 * reading the job actually needs.
 *
 * ── Why the outcome is NOT generated ───────────────────────────────────────
 * This text lands in the customer's CRM. A model that wrote "Shivam confirmed
 * the sprinkler inspection" when no confirm tool actually succeeded would put a
 * false confirmation in front of a dispatcher. So the outcome and the person are
 * COMPUTED by the caller from real tool calls / analysis fields, and the model
 * only writes the descriptive sentence — grounded in a verified-facts block it
 * is forbidden to contradict. If it fails, times out, or returns something that
 * breaks the rules, the caller falls back to the previous deterministic text:
 * the comment gets worse, never wrong.
 *
 * ── Recurrence ─────────────────────────────────────────────────────────────
 * Service descriptions are passed in and the MODEL decides whether the work is
 * recurring. A regex was tried first and got 36% of 1,524 real descriptions,
 * but mis-read equipment age as a cadence ("panel is 5 years old" → 5-year).
 * The model got all six probe cases right, including that one and the harder
 * "over 10-years old and due for 10-year testing", where age and cadence share
 * a sentence. The description is fenced to that single purpose so its long
 * equipment text cannot leak into a short comment.
 */

const db = require("../db");
const { ChatOpenAI } = require("@langchain/openai");
const { SystemMessage, HumanMessage } = require("@langchain/core/messages");
const config = require("../config");
const logger = require("../utils/logger");

const MODEL = process.env.CONVERSATION_SUMMARY_MODEL || "gpt-4.1-mini";
// This sits in the post-call/post-chat path. It must never hold up the comment.
const TIMEOUT_MS = Number(process.env.CONVERSATION_SUMMARY_TIMEOUT_MS) || 12000;
const MAX_WORDS = 45;

const SYSTEM = `You write ONE short note for a field-service CRM (ServiceTrade) job record, read by dispatchers and technicians who did not hear the conversation.

## WHAT MATTERS, in order:
1. WHO agreed — the person's name.
2. WHICH SERVICE — the service line name only, e.g. "Crawlspace Waterproofing".
3. WHEN — the date of each visit, e.g. "Wed 12 Aug".

## POSSIBLE SCENARIOS:
1. Customer can confirmed appointments.
2. Customer can ask for rescheduling or cancellation of appointments.

## RECURRENCE: each service may carry a description. Use it for ONE purpose only — to judge whether that service is a RECURRING/periodic visit (annual, semi-annual, quarterly, monthly, 5-year, and so on). If it clearly is, put the cadence in front of that service's name: "annual Crawlspace Waterproofing". Be careful:
- The cadence must describe how often THIS SERVICE happens, not the age or install date of equipment. "panel is 5 years old" is NOT a 5-year service. "due for 5-year internal inspection" IS.
- Attach a cadence to ONLY the service whose own description states it. When services share a date and only one recurs, name that one separately so the cadence cannot be read as covering the others — e.g. "the annual Crawlspace Waterproofing, plus Basement Dewatering Pump, on Wed 12 Aug".
- If it is not clearly recurring, say nothing about frequency.
Apart from judging recurrence, NEVER quote, paraphrase or otherwise use the description.

HARD LIMITS:
- 1-2 sentences. Never more than 35 words.
- Never write an appointment id, job id or job number.
- Never write the service description, an email address, a link, or filler like "for tracking the job".
- State only outcomes listed under VERIFIED OUTCOMES. Never claim a confirmation, reschedule or cancellation that is not there.
- Add a short second clause ONLY if the customer raised something the office must act on. Otherwise stop after the first sentence.

STYLE: plain prose, past tense, no markdown, no bullets.`;

/** Record-identifying numbers must never reach the CRM comment. */
const ID_LEAK = /#\s*\d{3,}|\b(?:appointment|job)\s*(?:id|number|#)?\s*\d{3,}\b/i;

function extractText(message) {
  const c = message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p) => p?.text || "").join("");
  return "";
}

/**
 * @param {object} args
 * @param {"phone call"|"web chat"} args.channel
 * @param {string|null} args.personName   who we contacted (computed, not guessed)
 * @param {string[]} args.outcomeFacts    verified outcome lines, incl. per-service descriptions
 * @param {string} args.transcript        the full conversation
 * @returns {Promise<string|null>} the sentence, or null to use the caller's fallback
 */
async function summarizeConversation({ channel, personName, outcomeFacts, transcript }) {
  if (!config.copilot.openaiApiKey) return null;
  if (!transcript || !transcript.trim()) return null;
  if (!outcomeFacts?.length) return null;

  const facts = [
    `CHANNEL: ${channel}`,
    `PERSON WE CONTACTED: ${personName || "unknown"}`,
    `VERIFIED OUTCOMES (these actually happened; nothing else may be claimed):`,
    ...outcomeFacts,
  ].join("\n");

  try {
    const model = new ChatOpenAI({
      model: MODEL,
      apiKey: config.copilot.openaiApiKey,
      temperature: 0.2,
      timeout: TIMEOUT_MS,
      maxRetries: 1,
    });
    const res = await model.invoke([
      new SystemMessage(SYSTEM),
      new HumanMessage(`${facts}\n\nCONVERSATION:\n${transcript}`),
    ]);
    const text = extractText(res).trim().replace(/\s+/g, " ");
    if (!text) return null;

    // Cheap guards. A summary that breaks these is worse than the old text, so
    // it is discarded rather than posted.
    if (ID_LEAK.test(text)) {
      logger.warn("conversation summary: discarded, contains a record id", { channel, text });
      return null;
    }
    if (text.split(" ").length > MAX_WORDS) {
      logger.warn("conversation summary: discarded, too long", { channel, words: text.split(" ").length });
      return null;
    }
    return text;
  } catch (err) {
    logger.warn("conversation summary: failed, falling back", { channel, error: err.message });
    return null;
  }
}

/**
 * Verified-outcome lines for the model: one per confirmed visit, listing each
 * service on it with its own description so the model can judge recurrence
 * per service rather than per visit.
 *
 * Only appointments we actually acted on are included — the model may not
 * mention any other visit on the job.
 */
async function buildOutcomeFacts(companyId, appointmentIds, timezone = "UTC") {
  const ids = [...new Set((appointmentIds || []).map(Number).filter(Number.isInteger))];
  if (!ids.length) return [];

  const { rows } = await db.query(
    `SELECT a.id, a.scheduled_start, sl.name AS service_line, s.description
       FROM appointments a
       LEFT JOIN appointment_services s ON s.appointment_id = a.id
       LEFT JOIN service_lines sl ON sl.id = s.service_line_id
      WHERE a.company_id = $1 AND a.id = ANY($2::bigint[])
      ORDER BY a.scheduled_start, sl.name`,
    [companyId, ids]
  );

  const byAppt = new Map();
  for (const r of rows) {
    if (!byAppt.has(r.id)) byAppt.set(r.id, { start: r.scheduled_start, services: [] });
    if (r.service_line) byAppt.get(r.id).services.push({ line: r.service_line, description: r.description });
  }

  const lines = [];
  const visits = [];
  for (const [, appt] of byAppt) {
    const when = appt.start
      ? new Intl.DateTimeFormat("en-US", {
          timeZone: timezone, weekday: "short", day: "numeric", month: "short", year: "numeric",
          hour: "numeric", minute: "2-digit",
        }).format(new Date(appt.start))
      : "date unknown";
    const shortWhen = appt.start
      ? new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", day: "numeric", month: "short" })
          .format(new Date(appt.start))
      : "date unknown";
    lines.push(`  - Confirmed the visit on ${when}, services:`);
    if (!appt.services.length) lines.push("      * (no service recorded)");
    for (const s of appt.services) {
      lines.push(`      * ${s.line} — description: ${JSON.stringify(s.description || "")}`);
    }
    visits.push({ when: shortWhen, services: appt.services.map((s) => s.line) });
  }
  return { lines, visits };
}

/**
 * Deterministic summary from the same facts — no model involved.
 *
 * This is the FALLBACK when the model is unavailable or its output is rejected.
 * It deliberately reads like the generated one (services and dates, no record
 * ids) rather than reverting to the old id-laden bullets: losing the model
 * should cost the recurrence and the customer's questions, not the two things
 * that made the comment useful in the first place.
 */
function renderPlainSummary(visits) {
  if (!visits?.length) return null;
  return visits
    .map((v) => `${v.services.length ? v.services.join(", ") : "visit"} — ${v.when}`)
    .join("; ");
}

/** Reconstruct a chat conversation from the agent's own turn log. */
async function loadChatTranscript(companyId, threadId) {
  const { rows } = await db.query(
    `SELECT human_message, ai_message FROM confirmation_agent_llm_logs
      WHERE company_id = $1 AND thread_id = $2 ORDER BY id`,
    [companyId, threadId]
  );
  const lines = [];
  for (const r of rows) {
    // The synthetic opening trigger is not something the customer said.
    if (r.human_message && !r.human_message.startsWith("(This is a text chat")) lines.push(`CUSTOMER: ${r.human_message}`);
    if (r.ai_message) lines.push(`CLARA: ${r.ai_message}`);
  }
  return lines.join("\n");
}

/** Retell stores the call transcript as text or as a role/content array. */
async function loadCallTranscript(companyId, retellCallId) {
  const { rows } = await db.query(
    `SELECT transcript FROM calls WHERE company_id = $1 AND retell_call_id = $2`,
    [companyId, retellCallId]
  );
  const t = rows[0]?.transcript;
  if (!t) return "";
  if (typeof t === "string") return t;
  if (Array.isArray(t)) return t.map((m) => `${String(m.role || "").toUpperCase()}: ${m.content}`).join("\n");
  return "";
}

module.exports = {
  summarizeConversation, buildOutcomeFacts, renderPlainSummary, loadChatTranscript, loadCallTranscript,
  MODEL, MAX_WORDS, ID_LEAK,
};
