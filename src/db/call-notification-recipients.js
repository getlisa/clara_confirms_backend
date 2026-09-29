/**
 * Who gets a notification email after each conversation, and for which
 * outcomes — see migrations/107.
 *
 * Shaped after db/report-recipients.js (the other "mail someone who may have no
 * login" table), with one difference that matters: the per-recipient `events`
 * array. A single company-wide outcome list could not express "Erica wants
 * everything, Maxwell wants only cancellations and no-answers", which is the
 * whole reason this is configurable.
 */

const db = require("./index");

/**
 * The outcome vocabulary. Mirrors db/todos.js deriveTodoType 1:1 so there is no
 * second source of truth about what happened on a call; `confirmed` is its null
 * case (the happy path raises no todo). Exactly one applies per conversation.
 *
 * `label` and `description` are served to the frontend by
 * GET /call-notifications so the settings UI renders its checkboxes from here
 * rather than hardcoding a list that drifts.
 */
const EVENTS = [
  { key: "confirmed",              label: "Appointment confirmed",  description: "The customer confirmed the visit." },
  { key: "reschedule_requested",   label: "Reschedule requested",   description: "The customer asked to move the visit." },
  { key: "cancellation_requested", label: "Cancellation requested", description: "The customer asked to cancel the visit." },
  { key: "appointment_needed",     label: "Appointment needed",     description: "No visit is booked yet and the customer gave no preferred time." },
  { key: "unconfirmed",            label: "Ended unconfirmed",      description: "The customer answered but nothing was settled either way." },
  { key: "voicemail",              label: "Reached voicemail",      description: "Voicemail picked up instead of a person." },
  { key: "not_picked",             label: "No answer / no reply",   description: "Nobody picked up, or an SMS conversation got no reply." },
];

const EVENT_KEYS = EVENTS.map((e) => e.key);
const ALL_EVENTS = [...EVENT_KEYS];

function normalizeEmail(email) {
  return String(email).trim().toLowerCase();
}

/**
 * Unknown event keys are REJECTED, not dropped: silently storing a typo'd key
 * would leave a recipient quietly subscribed to nothing while the UI showed it
 * as saved. Throws with `.code === "BAD_EVENTS"` for the route to turn into a 400.
 */
function normalizeEvents(events) {
  if (!Array.isArray(events)) {
    const e = new Error("events must be an array of event keys");
    e.code = "BAD_EVENTS";
    throw e;
  }
  const cleaned = [...new Set(events.map((v) => String(v).trim().toLowerCase()).filter(Boolean))];
  const unknown = cleaned.filter((v) => !EVENT_KEYS.includes(v));
  if (unknown.length) {
    const e = new Error(`Unknown event key(s): ${unknown.join(", ")}. Valid keys: ${EVENT_KEYS.join(", ")}`);
    e.code = "BAD_EVENTS";
    throw e;
  }
  // Stored in the canonical order rather than the order they arrived, so two
  // recipients with the same subscriptions compare equal in the UI.
  return EVENT_KEYS.filter((k) => cleaned.includes(k));
}

function present(row) {
  if (!row) return null;
  return {
    id: row.id,
    company_id: row.company_id,
    email: row.email,
    name: row.name,
    events: row.events || [],
    enabled: row.enabled,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function list(companyId) {
  const { rows } = await db.query(
    `SELECT * FROM call_notification_recipients WHERE company_id = $1 ORDER BY created_at`,
    [companyId]
  );
  return rows.map(present);
}

async function getById(companyId, id) {
  const { rows } = await db.query(
    `SELECT * FROM call_notification_recipients WHERE company_id = $1 AND id = $2`,
    [companyId, id]
  );
  return present(rows[0]);
}

/**
 * Every enabled recipient at this company subscribed to `event` — the enqueue
 * path's only read.
 */
async function listEnabledForEvent(companyId, event) {
  const { rows } = await db.query(
    `SELECT * FROM call_notification_recipients
      WHERE company_id = $1 AND enabled = true AND $2 = ANY(events)
      ORDER BY created_at`,
    [companyId, event]
  );
  return rows.map(present);
}

/**
 * `enabled` is forced FALSE here regardless of what the caller passes — a
 * recipient must be turned on by a separate PATCH once someone has looked at
 * it, never at creation time. Same rule report_recipients enforces, for the
 * same reason: a half-filled form must not start mailing a real inbox.
 *
 * Throws with `.code === "DUPLICATE"` on a repeat address so the route returns
 * 409 rather than a 500.
 */
async function create({ companyId, email, name = null, events = null }) {
  const eventList = events == null ? ALL_EVENTS : normalizeEvents(events);
  try {
    const { rows } = await db.query(
      `INSERT INTO call_notification_recipients (company_id, email, name, events, enabled)
       VALUES ($1, $2, $3, $4, false)
       RETURNING *`,
      [companyId, normalizeEmail(email), name, eventList]
    );
    return present(rows[0]);
  } catch (err) {
    if (err.code === "23505") {
      const e = new Error("A recipient with this email already exists");
      e.code = "DUPLICATE";
      throw e;
    }
    throw err;
  }
}

async function update(companyId, id, fields) {
  const sets = [];
  const params = [companyId, id];

  if ("email" in fields) {
    params.push(normalizeEmail(fields.email));
    sets.push(`email = $${params.length}`);
  }
  if ("name" in fields) {
    params.push(fields.name);
    sets.push(`name = $${params.length}`);
  }
  if ("events" in fields) {
    params.push(normalizeEvents(fields.events));
    sets.push(`events = $${params.length}`);
  }
  if ("enabled" in fields) {
    params.push(Boolean(fields.enabled));
    sets.push(`enabled = $${params.length}`);
  }

  if (!sets.length) return getById(companyId, id);
  sets.push(`updated_at = now()`);

  try {
    const { rows } = await db.query(
      `UPDATE call_notification_recipients SET ${sets.join(", ")}
        WHERE company_id = $1 AND id = $2 RETURNING *`,
      params
    );
    return present(rows[0]);
  } catch (err) {
    if (err.code === "23505") {
      const e = new Error("A recipient with this email already exists");
      e.code = "DUPLICATE";
      throw e;
    }
    throw err;
  }
}

async function remove(companyId, id) {
  const { rowCount } = await db.query(
    `DELETE FROM call_notification_recipients WHERE company_id = $1 AND id = $2`,
    [companyId, id]
  );
  return rowCount > 0;
}

module.exports = {
  EVENTS, EVENT_KEYS, ALL_EVENTS,
  normalizeEvents,
  list, getById, listEnabledForEvent, create, update, remove,
};
