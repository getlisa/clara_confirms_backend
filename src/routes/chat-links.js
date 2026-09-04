/**
 * Chat links — generate + resolve shareable, token-based links to a web chat
 * widget for a specific job/appointment.
 *
 * POST /chat-links/appointments/:id            — authenticated (staff), generates/reuses a link
 * POST /chat-links/jobs/:id                    — authenticated (staff), generates/reuses a link
 * POST /chat-links/appointments/:id/send-email — authenticated (staff), same as above + emails it
 * POST /chat-links/jobs/:id/send-email         — authenticated (staff), same as above + emails it
 * GET  /chat-links/:token                      — PUBLIC, no auth — the token IS the credential.
 *                                                 Opened by an anonymous customer's browser, so
 *                                                 CORS is intentionally opened wide for this one route.
 */

const express = require("express");
const cors = require("cors");
const { authenticate, getCompanyId } = require("../auth");
const chatLinksService = require("../services/chat-links");
const db = require("../db");
const chatLinksDb = require("../db/chat-links");
const sendEventsDb = require("../db/chat-link-send-events");
const confirmationAgent = require("../confirmation-agent");
const { PROPOSE_REMAINING_TRIGGER } = require("../confirmation-agent/actions");
const { resolveSlugForCompany } = require("../services/crm");
const { getWorkflow } = require("../confirmation-agent/workflows");
const logger = require("../utils/logger");

const router = express.Router();

// Named triggers for POST /:token/messages that map to a FIXED internal
// marker string, in place of the frontend having to hardcode that text
// itself — a public API contract should never depend on a magic string
// staying byte-for-byte stable. `trigger` is always the real tool name being
// invoked (chat-cards-frontend.md §1) — propose_remaining_appointments has no
// per-call argument values (the model composes everything itself), so it's
// the only one that maps to a fixed marker here. The five card-action
// triggers below (confirm_appointment/reschedule_appointment/
// cancel_appointment/confirm_job_appointments/decline_remaining_appointments)
// carry real, request-known args instead, so they're handled separately by
// handleCardTriggerMessage/buildCardTriggerArgs further down.
const NAMED_TRIGGERS = { propose_remaining_appointments: PROPOSE_REMAINING_TRIGGER };

router.post("/appointments/:id", authenticate, async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const callType = req.body?.call_type || "customer_confirmation";
    const result = await chatLinksService.createChatLinkForAppointment(companyId, Number(req.params.id), callType);
    if (!result.ok) return res.status(result.status || 400).json({ error: result.error });

    // A staff member clicked. Attribute it, so the Logs detail sheet can answer
    // "did someone send this by hand, and who?" — the dispatcher's own sends
    // leave origin at its 'scheduler' default.
    await chatLinksDb.setOrigin(result.token, { origin: "manual", userId: req.user?.userId ?? null })
      .catch((err) => logger.warn("chat link: failed to record manual origin", { error: err.message }));
    return res.status(201).json({ token: result.token });
  } catch (err) {
    logger.error("POST /chat-links/appointments/:id failed", { error: err.message });
    return res.status(500).json({ error: "Failed to create chat link" });
  }
});

router.post("/jobs/:id", authenticate, async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const callType = req.body?.call_type || "customer_confirmation";
    const result = await chatLinksService.createChatLinkForJob(companyId, Number(req.params.id), callType);
    if (!result.ok) return res.status(result.status || 400).json({ error: result.error });

    // A staff member clicked. Attribute it, so the Logs detail sheet can answer
    // "did someone send this by hand, and who?" — the dispatcher's own sends
    // leave origin at its 'scheduler' default.
    await chatLinksDb.setOrigin(result.token, { origin: "manual", userId: req.user?.userId ?? null })
      .catch((err) => logger.warn("chat link: failed to record manual origin", { error: err.message }));
    return res.status(201).json({ token: result.token });
  } catch (err) {
    logger.error("POST /chat-links/jobs/:id failed", { error: err.message });
    return res.status(500).json({ error: "Failed to create chat link" });
  }
});

// "Send chat link" via email — creates/reuses the link (same as the plain
// POST above) and additionally emails it to the customer on file, for a
// button that actually delivers the link instead of just copying a URL.
router.post("/appointments/:id/send-email", authenticate, async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const callType = req.body?.call_type || "customer_confirmation";
    const overrideEmail = req.body?.email != null ? String(req.body.email) : null;
    const result = await chatLinksService.sendConfirmationEmailForAppointment(companyId, Number(req.params.id), callType, overrideEmail);
    if (!result.ok) return res.status(result.status || 400).json({ error: result.error });

    if (result.token) {
      await chatLinksDb.setOrigin(result.token, { origin: "manual", userId: req.user?.userId ?? null })
        .catch((err) => logger.warn("chat link: failed to record manual origin", { error: err.message }));
      // Who the conversation is now with. A manual send goes to the address on
      // file (or a typed override) — we never learn a person's NAME here, so it
      // is cleared rather than left pointing at whoever a previous send used.
      await chatLinksDb.setRecipient(result.token, { name: null, email: result.email ?? null })
        .catch((err) => logger.warn("chat link: failed to snapshot recipient", { error: err.message }));
      await sendEventsDb.recordSafe({
        companyId, token: result.token, medium: "email", destination: result.email ?? null,
        origin: "manual", triggeredByUserId: req.user?.userId ?? null, ok: result.sent !== false,
      });
    }
    return res.json(result);
  } catch (err) {
    logger.error("POST /chat-links/appointments/:id/send-email failed", { error: err.message });
    return res.status(500).json({ error: "Failed to send confirmation email" });
  }
});

router.post("/jobs/:id/send-email", authenticate, async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const callType = req.body?.call_type || "customer_confirmation";
    const overrideEmail = req.body?.email != null ? String(req.body.email) : null;
    const result = await chatLinksService.sendConfirmationEmailForJob(companyId, Number(req.params.id), callType, overrideEmail);
    if (!result.ok) return res.status(result.status || 400).json({ error: result.error });

    if (result.token) {
      await chatLinksDb.setOrigin(result.token, { origin: "manual", userId: req.user?.userId ?? null })
        .catch((err) => logger.warn("chat link: failed to record manual origin", { error: err.message }));
      // Who the conversation is now with. A manual send goes to the address on
      // file (or a typed override) — we never learn a person's NAME here, so it
      // is cleared rather than left pointing at whoever a previous send used.
      await chatLinksDb.setRecipient(result.token, { name: null, email: result.email ?? null })
        .catch((err) => logger.warn("chat link: failed to snapshot recipient", { error: err.message }));
      await sendEventsDb.recordSafe({
        companyId, token: result.token, medium: "email", destination: result.email ?? null,
        origin: "manual", triggeredByUserId: req.user?.userId ?? null, ok: result.sent !== false,
      });
    }
    return res.json(result);
  } catch (err) {
    logger.error("POST /chat-links/jobs/:id/send-email failed", { error: err.message });
    return res.status(500).json({ error: "Failed to send confirmation email" });
  }
});

// Same idea as send-email above, but texts the link via Twilio instead — a
// plain text with a link, NOT the conversational Retell "Text Now" feature.
router.post("/appointments/:id/send-sms", authenticate, async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const callType = req.body?.call_type || "customer_confirmation";
    const overridePhone = req.body?.phone != null ? String(req.body.phone) : null;
    const result = await chatLinksService.sendConfirmationSmsForAppointment(companyId, Number(req.params.id), callType, overridePhone);
    if (!result.ok) return res.status(result.status || 400).json({ error: result.error });

    if (result.token) {
      await chatLinksDb.setOrigin(result.token, { origin: "manual", userId: req.user?.userId ?? null })
        .catch((err) => logger.warn("chat link: failed to record manual origin", { error: err.message }));
      await chatLinksDb.setRecipient(result.token, { name: null, phone: result.phone ?? null })
        .catch((err) => logger.warn("chat link: failed to snapshot recipient", { error: err.message }));
      await sendEventsDb.recordSafe({
        companyId, token: result.token, medium: "sms", destination: result.phone ?? null,
        origin: "manual", triggeredByUserId: req.user?.userId ?? null, ok: result.sent !== false,
      });
    }
    return res.json(result);
  } catch (err) {
    logger.error("POST /chat-links/appointments/:id/send-sms failed", { error: err.message });
    return res.status(500).json({ error: "Failed to send confirmation sms" });
  }
});

router.post("/jobs/:id/send-sms", authenticate, async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const callType = req.body?.call_type || "customer_confirmation";
    const overridePhone = req.body?.phone != null ? String(req.body.phone) : null;
    const result = await chatLinksService.sendConfirmationSmsForJob(companyId, Number(req.params.id), callType, overridePhone);
    if (!result.ok) return res.status(result.status || 400).json({ error: result.error });

    if (result.token) {
      await chatLinksDb.setOrigin(result.token, { origin: "manual", userId: req.user?.userId ?? null })
        .catch((err) => logger.warn("chat link: failed to record manual origin", { error: err.message }));
      await chatLinksDb.setRecipient(result.token, { name: null, phone: result.phone ?? null })
        .catch((err) => logger.warn("chat link: failed to snapshot recipient", { error: err.message }));
      await sendEventsDb.recordSafe({
        companyId, token: result.token, medium: "sms", destination: result.phone ?? null,
        origin: "manual", triggeredByUserId: req.user?.userId ?? null, ok: result.sent !== false,
      });
    }
    return res.json(result);
  } catch (err) {
    logger.error("POST /chat-links/jobs/:id/send-sms failed", { error: err.message });
    return res.status(500).json({ error: "Failed to send confirmation sms" });
  }
});

// GET /chat-links — STAFF monitoring view: every chat link for the company with
// where it stands in its lifecycle (sent → in_progress → ended, or expired).
// Deliberately separate from the conversation `state` that drives the widget:
// `state` defaults to chat_started at creation, so it reports an unsent link as
// an active chat and cannot answer "what is outstanding right now".
router.get("/", authenticate, async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const status = req.query.status ? String(req.query.status) : null;
    if (status && !["sent", "in_progress", "ended", "expired"].includes(status)) {
      return res.status(400).json({ error: "status must be one of sent, in_progress, ended, expired" });
    }
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const search = req.query.search ? String(req.query.search) : null;
    const [{ rows, total }, counts] = await Promise.all([
      chatLinksDb.listForMonitoring(companyId, { status, limit, offset, search }),
      chatLinksDb.statusCounts(companyId),
    ]);
    return res.json({ chat_links: rows, counts, pagination: { limit, offset, total } });
  } catch (err) {
    logger.error("GET /chat-links failed", { error: err.message });
    return res.status(500).json({ error: "Failed to list chat links" });
  }
});

// GET /chat-links/:id/sends — every send of one link, oldest first.
//
// Keyed on the numeric id, never the token: the token IS the credential for that
// customer's conversation and must not travel through a staff URL.
// Numeric id validated in the handler, not in the path: this
// path-to-regexp version rejects inline "(\\d+)" patterns outright and the
// whole route file fails to load — taking the app with it.
router.get("/:id/sends", authenticate, async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid chat link id" });

    const link = await chatLinksDb.getByIdForCompany(companyId, id);
    if (!link) return res.status(404).json({ error: "Chat link not found" });

    const events = await sendEventsDb.listForToken(companyId, link.token);
    return res.json({ send_events: events });
  } catch (err) {
    logger.error("GET /chat-links/:id/sends failed", { error: err.message });
    return res.status(500).json({ error: "Failed to load send history" });
  }
});

// GET /chat-links/:id/messages — the conversation itself, for the Logs detail
// sheet. The call equivalent is GET /calls/:id's `transcript`; this is the chat
// one, and like that endpoint it is fetched on demand rather than shipped with
// every list row.
//
// Numeric id, never the token (see /sends above), and validated in the handler
// because an inline pattern in the path breaks route loading here.
router.get("/:id/messages", authenticate, async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid chat link id" });

    const link = await chatLinksDb.getByIdForCompany(companyId, id);
    if (!link) return res.status(404).json({ error: "Chat link not found" });

    // Read-only: this must never start a conversation the customer has not.
    const { messages, message_count } = await confirmationAgent.getConversation(companyId, link.token);
    return res.json({
      chat_link_id: link.id,
      status: link.status,
      state: link.state,
      outcome_comment_posted_at: link.outcome_comment_posted_at ?? null,
      message_count,
      messages,
    });
  } catch (err) {
    logger.error("GET /chat-links/:id/messages failed", { error: err.message });
    return res.status(500).json({ error: "Failed to load conversation" });
  }
});

// PUBLIC — no authenticate() call. Wide-open CORS scoped to this single route
// only (the app-level CORS in src/server.js stays restrictive for everything else).
const openCors = cors();
router.options("/:token", openCors);
router.get("/:token", openCors, async (req, res) => {
  try {
    const result = await chatLinksService.resolveChatLink(req.params.token);
    if (!result.ok) return res.status(result.status || 404).json({ error: result.error, ...(result.code && { code: result.code }) });
    return res.json(result);
  } catch (err) {
    logger.error("GET /chat-links/:token failed", { error: err.message });
    return res.status(500).json({ error: "Failed to resolve chat link" });
  }
});

// PUBLIC, same openCors convention as GET /:token — fire-and-forget click
// tracking for the widget's "Powered by Clara AI" footer link. Best-effort
// by design: a failure here logs and returns, never anything the customer
// sees — the frontend's own call is itself a fire-and-forget
// fetch(...).catch(() => {}), so nothing downstream depends on this
// succeeding.
router.options("/:token/footer-click", openCors);
router.post("/:token/footer-click", openCors, async (req, res) => {
  try {
    const link = await chatLinksDb.getByToken(req.params.token);
    if (!link) return res.status(404).json({ ok: false });
    await db.query(
      `INSERT INTO chat_footer_link_clicks (chat_link_token, company_id) VALUES ($1, $2)`,
      [link.token, link.company_id]
    );
    return res.json({ ok: true });
  } catch (err) {
    logger.error("POST /chat-links/:token/footer-click failed", { error: err.message });
    return res.status(500).json({ ok: false });
  }
});

// ── SSE message send ─────────────────────────────────────────────────────────
// Events, in order for one turn: `thinking` (was `typing` — renamed so the UI
// can say something more honest than a generic spinner), then for each model
// generation `message_delta`* → `message_complete`, with `tool_call` /
// `tool_result` interleaved around any tool the model actually calls (name +
// args on start, name + parsed result on end — previously silent for every
// tool except get_service_link, which left the customer staring at a blank
// gap for however long a confirm/reschedule/cancel took). Finally `done` with
// the updated state/input_hint/appointments.
//
// Deltas are real model tokens, streamed from the LangGraph run as they are
// generated, rather than the finished text sliced into 12-character ticks
// after the whole (multi-second, tool-calling) turn had already completed.
//
// Emission is driven entirely by the onEvent callback below. The resolved
// `result.messages` carry the same content and must NOT also be written, or
// every reply would be sent twice.

function sseSend(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// Proxies (and Vercel) drop an idle response; a turn can sit silent for tens
// of seconds while a tool runs, which is exactly the gap streaming was meant
// to make survivable. A comment line is ignored by every SSE client.
const HEARTBEAT_MS = 15000;

/**
 * Open an SSE response — shared by POST /:token/messages and every
 * card-action route below (confirm/reschedule/cancel/bulk-confirm/
 * decline-remaining all stream now too, see the "card actions" section).
 * Call this only once the request is known-good (link resolved, body
 * validated) — headers go out immediately, so nothing after this point can
 * fall back to a plain JSON error response; the `error` SSE event is that
 * path's replacement.
 */
function startSse(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    // Nginx buffers proxied responses by default, which would hold every
    // delta back until the turn ended — reinstating the old wait invisibly.
    "X-Accel-Buffering": "no",
  });
  // Node coalesces small writes by default; each SSE frame must go out on its
  // own or the deltas arrive in clumps.
  res.flushHeaders?.();
  if (typeof res.socket?.setNoDelay === "function") res.socket.setNoDelay(true);

  const heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
  // If the customer closes the tab mid-turn, stop writing into a dead socket.
  // The graph run itself is deliberately NOT aborted — its tool calls may
  // already have confirmed an appointment, and the checkpointer keeps the
  // reply for the transcript replay on their next visit.
  let aborted = false;
  // MUST be res, not req: since Node 16 the request's own "close" fires as
  // soon as its body has been fully read, which for a normal POST is
  // immediately — guarding on that silently truncated every reply after the
  // first chunk. The response closing before we end it is the real signal
  // that the customer went away.
  res.on("close", () => { if (!res.writableEnded) aborted = true; });

  return { isAborted: () => aborted, stop: () => clearInterval(heartbeat) };
}

router.options("/:token/messages", openCors);
router.post("/:token/messages", openCors, async (req, res) => {
  // Three kinds of body, never combined: a real customer message (`content`),
  // a named internal trigger with no args (`trigger` alone — currently just
  // propose_remaining_appointments), or a card-action trigger with real,
  // request-known args (`trigger` + `args` — confirm_appointment/
  // reschedule_appointment/cancel_appointment/confirm_job_appointments/
  // decline_remaining_appointments; chat-cards-frontend.md §3). The five
  // separate per-action routes this used to be are retired — every card
  // button now posts here instead (see the "card actions" section below).
  const { trigger, args } = req.body || {};
  if (trigger && CARD_TRIGGER_TOOLS.has(trigger)) {
    return handleCardTriggerMessage(req, res, trigger, args || {});
  }

  let content = req.body?.content;
  if (trigger) {
    if (!NAMED_TRIGGERS[trigger]) return res.status(400).json({ error: `Unknown trigger: ${trigger}` });
    content = NAMED_TRIGGERS[trigger];
  }
  if (typeof content !== "string" || !content.trim()) {
    return res.status(400).json({ error: "content is required" });
  }

  const sse = startSse(res);

  // Time-to-first-token is the only number that says whether streaming
  // actually helped — total turn duration barely moves, since the same LLM
  // and tool calls still run. Measured from the moment the request is
  // accepted, so it includes link resolution and context hydration (the DB
  // work before the model is even called), which is what the customer feels.
  const startedAt = Date.now();
  let firstTokenMs = null;

  try {
    sseSend(res, "thinking", {});

    // Defense in depth — every event in this stream must be role:"agent"
    // (the doc promises the customer's own message is never echoed back);
    // the real fix is upstream (the agent no longer includes it), but this
    // guards against any future regression too.
    const onEvent = (ev) => {
      if (sse.isAborted()) return;
      if (ev.type === "delta") {
        if (firstTokenMs === null) firstTokenMs = Date.now() - startedAt;
        sseSend(res, "message_delta", { role: "agent", chunk: ev.chunk });
      } else if (ev.type === "message" && ev.message.role === "agent") {
        sseSend(res, "message_complete", ev.message);
      } else if (ev.type === "tool_call") {
        sseSend(res, "tool_call", { tool: ev.tool, args: ev.args });
      } else if (ev.type === "tool_result") {
        sseSend(res, "tool_result", { tool: ev.tool, result: ev.result });
      }
    };

    const result = await chatLinksService.sendChatMessage(req.params.token, content, onEvent);
    if (!result.ok) {
      sseSend(res, "error", { error: result.error });
      return res.end();
    }

    const totalMs = Date.now() - startedAt;
    logger.info("Chat turn streamed", { token: req.params.token, firstTokenMs, totalMs });
    // Also on the wire, so the timing is visible from the browser's network
    // tab without server log access — the frontend may ignore both fields.
    sseSend(res, "done", { state: result.state, input_hint: result.input_hint, appointments: result.appointments, first_token_ms: firstTokenMs, total_ms: totalMs });
    return res.end();
  } catch (err) {
    logger.error("POST /chat-links/:token/messages failed", { error: err.message });
    sseSend(res, "error", { error: "Failed to send message" });
    return res.end();
  } finally {
    sse.stop();
  }
});

// ── Card actions, routed through the agent, over POST /:token/messages ─────
// Public, same openCors convention as GET /:token and POST /:token/messages —
// the token IS the credential.
//
// There is no separate URL per action anymore — the six routes this used to
// be (`/appointments/:id/confirm`, `/reschedule`, `/cancel`,
// `/appointments/bulk-confirm`, `/appointments/decline-remaining`,
// `/service-link`) are all retired. Every card button is now
// `POST /:token/messages` with `{ trigger, args }` (chat-cards-frontend.md
// §1/§3), dispatched by handleCardTriggerMessage below via the SAME
// mechanism the old routes used: a card-trigger marker (actions.js's
// buildCardTrigger) sent through the graph, structurally forcing the model
// to call exactly one tool (registry.js's exclusiveTool + model.js's
// tool_choice — binding alone doesn't guarantee the call happens, forcing
// does) with the real, request-known argument values (ctx.cardTriggerArgs —
// never trusting the model to relay them). The write itself is unchanged:
// the promoted tool handlers call the SAME actions.js core functions these
// routes used to call directly. There is no more synthetic checkpoint
// injection anywhere — the real tool call IS the checkpoint entry, always.
//
// Response is SSE — same event names as a normal /:token/messages turn
// (thinking/tool_call/tool_result/done/error), but deliberately NARROWER:
// only tool_call/tool_result ever reach the wire here (see
// runOneCardTriggerTurn) — no delta/message events — so the shape of a
// successful response is always exactly the same four events... with ONE
// deliberate exception: `send_service_link` runs TWO forced tool turns in
// sequence (resolve_service_link_contact, then get_service_link) within one
// SSE response when the first one succeeds, so its happy-path shape is
// seven events, not four. See handleCardTriggerMessage below.

const actions = require("../confirmation-agent/actions");
const { buildJobConfirmationContext } = require("../services/job-confirmation-context");

/**
 * Resolve a token to everything an action route needs. Mirrors
 * chatLinksService.resolveChatLink's own link-lookup + loadLinkContext call,
 * without the ensureOpened/markOpened side effects that route has (an action
 * route must NOT implicitly "open" a link that was never actually opened).
 *
 * jobRef/customerRef (ServiceTrade external ids) live on neither chat_links
 * nor job-confirmation-context.js's ctx.job — same query as
 * confirmation-agent/index.js's resolveJobRefs, duplicated rather than
 * imported to avoid a route file depending on that module's internals.
 *
 * Deliberately does NOT open the SSE stream — a bad/unknown token still gets
 * a plain JSON 404 here, before any headers go out.
 */
async function resolveForAction(token) {
  const link = await chatLinksDb.getByToken(token);
  if (!link) return { ok: false, status: 404, error: "Chat link not found" };
  const ctx = await buildJobConfirmationContext(link.company_id, link.job_id);
  if (!ctx.ok) return { ok: false, status: ctx.status || 404, error: ctx.error };

  const { rows } = await db.query(
    `SELECT j.external_ref AS job_ref, cu.external_ref AS customer_ref
       FROM jobs j LEFT JOIN customers cu ON cu.id = j.customer_id
      WHERE j.id = $1 AND j.company_id = $2`,
    [link.job_id, link.company_id]
  );

  // The FULL resolution the chat agent itself uses for "who is this
  // conversation actually with" (snapshot → nominated contact → send-events
  // fallback) — not just the raw recipient_name snapshot, which is null on
  // most live links (see confirmation-agent/index.js's resolveRecipient's own
  // comment: it names 8 of 10 links that would otherwise have had no name at
  // all). This is what /:token/end passes into finalizeConversation for the
  // CRM comment's "Who confirmed" line — using only the snapshot there meant
  // that line fell back to "unknown" far more often than it needed to.
  // customerEmail/customerPhone are passed null: they only affect the
  // returned email/phone fields, never recipientName, and this call site has
  // no use for them.
  const { recipientName } = await confirmationAgent.resolveRecipient(
    link.company_id, link.recipient_contact_id, null, null,
    { name: link.recipient_name, email: link.recipient_email, phone: link.recipient_phone },
    token
  );
  // Same "prefer a name the customer actually gave us this session" rule as
  // the LLM's own end_conversation path — see capture-confirmer-identity.js.
  const confirmedBy = await confirmationAgent.resolveConfirmedBy(token);

  return {
    ok: true, link, ctx, companyId: link.company_id, jobId: link.job_id,
    threadId: token, jobRef: rows[0]?.job_ref ?? null, customerRef: rows[0]?.customer_ref ?? null,
    recipientContactId: link.recipient_contact_id, recipientName, confirmedBy,
  };
}

/**
 * A token-only resolution for the card-trigger dispatch below — deliberately
 * lighter than resolveForAction: it does NOT build a job-confirmation
 * context, since handleCardTriggerMessage never reads one (sendChatMessage,
 * called via runOneCardTriggerTurn, does its own hydration/validation and
 * already returns an `error` event for anything that fails there). Building
 * a full context here just to check `.ok` and then discard it was a real,
 * measured latency contributor — one whole redundant buildJobConfirmationContext
 * (several sequential queries) on every card click.
 */
async function resolveLinkOnly(token) {
  const link = await chatLinksDb.getByToken(token);
  if (!link) return { ok: false, status: 404, error: "Chat link not found" };
  return { ok: true, threadId: token, companyId: link.company_id };
}

/**
 * Run ONE forced tool_choice turn within an ALREADY-OPEN SSE stream (`sse` —
 * from startSse, opened once by the caller). Emits `thinking` → `tool_call`
 * → `tool_result`, then returns `{ toolResult, cards }` on success — `cards`
 * is `{appointments, remaining_unconfirmed, all_confirmed}`, read straight
 * off sendChatMessage's OWN post-write buildJobConfirmationContext call
 * rather than the caller paying for a second, identical one on top of it.
 * On any failure (the tool result itself failed, the expected tool never got
 * called, or an unexpected tool fired instead — the last two should be
 * impossible with forced tool_choice, but are checked anyway per the
 * determinism guardrails), emits `error` and returns `null` — the caller
 * must treat a `null` return as "already handled; end the response, run no
 * further steps."
 *
 * Deliberately does NOT open/close the SSE stream itself (unlike the single
 * old runCardTriggerTurn this replaces) — `send_service_link` needs to call
 * this TWICE in sequence within one response, and `startSse` can only run
 * once per request (it sends headers). Also deliberately does NOT forward
 * `delta`/`message` events — even if the model produces stray narration
 * alongside the forced call, the customer-visible stream never varies in
 * shape.
 */
async function runOneCardTriggerTurn(res, sse, threadId, tool, cardTriggerArgs) {
  let capturedResult = null;
  let sawExpectedTool = false;
  let sawUnexpectedTool = false;

  const onEvent = (ev) => {
    if (sse.isAborted()) return;
    if (ev.type === "tool_call") {
      sseSend(res, "tool_call", { tool: ev.tool, args: ev.args });
    } else if (ev.type === "tool_result") {
      sseSend(res, "tool_result", { tool: ev.tool, result: ev.result });
      if (ev.tool === tool) { capturedResult = ev.result; sawExpectedTool = true; }
      else sawUnexpectedTool = true;
    }
  };

  try {
    sseSend(res, "thinking", {});
    const content = actions.buildCardTrigger(tool);
    const result = await chatLinksService.sendChatMessage(threadId, content, onEvent, cardTriggerArgs);
    if (!result.ok) {
      sseSend(res, "error", { error: result.error });
      return null;
    }
    if (!sawExpectedTool || sawUnexpectedTool || capturedResult?.success === false) {
      sseSend(res, "error", { error: capturedResult?.error || "Action failed" });
      return null;
    }
    return {
      toolResult: capturedResult,
      cards: {
        appointments: result.appointments,
        remaining_unconfirmed: result.remaining_unconfirmed,
        all_confirmed: result.all_confirmed,
      },
    };
  } catch (err) {
    logger.error("runOneCardTriggerTurn failed", { tool, threadId, error: err.message });
    sseSend(res, "error", { error: "Action failed" });
    return null;
  }
}

// Card-action trigger names — every one of these routes through
// runOneCardTriggerTurn (forced tool_choice, narrowed SSE), dispatched from
// handleCardTriggerMessage below. Reschedule's old "skip, no date given"
// special case is no longer a route-level branch: it's now handled INSIDE
// the reschedule_appointment tool handler itself (which takes an optional
// scheduled_start), so it flows through this exact same path as every other
// trigger — see tools/handlers/reschedule-appointment.js.
//
// `send_service_link` is the ONE deliberate exception to "trigger is always
// exactly one real tool name": it represents a two-tool composite action
// (resolve_service_link_contact, then get_service_link) — see
// handleCardTriggerMessage for how it's sequenced.
const CARD_TRIGGER_TOOLS = new Set([
  "confirm_appointment", "reschedule_appointment", "cancel_appointment",
  "confirm_job_appointments", "decline_remaining_appointments",
  "send_service_link", "capture_confirmer_identity",
]);

// A partial confirm/reschedule/bulk-confirm can leave other appointments on
// the job unconfirmed — these three triggers' `done` includes
// needs_propose_remaining so the frontend knows whether to run
// chat-cards-frontend.md §8 next. Cancel closes the chat outright (§7) and
// decline-remaining IS the answer to that same question — neither has
// anything left to propose.
const TRIGGERS_WITH_NEEDS_PROPOSE_REMAINING = new Set([
  "confirm_appointment", "reschedule_appointment", "confirm_job_appointments",
]);

/**
 * Build the real, request-known `cardTriggerArgs` for one card-action
 * trigger from the request body's `args`, validating whatever must 400
 * before any SSE stream opens (a bad/missing appointment_id, cancel's
 * `reason`) — the same checks the five now-retired per-action routes ran
 * before their own SSE opened. `confirm_job_appointments`'s "neither
 * confirm_all nor a non-empty appointment_ids" case is deliberately NOT
 * checked here — that surfaces as a tool_result-driven `error` event instead
 * (see bulkConfirmCore), exactly as it did on the old bulk-confirm route.
 */
function buildCardTriggerArgs(trigger, args, { reasonRequired = true } = {}) {
  switch (trigger) {
    case "confirm_appointment": {
      const appointment_id = Number(args.appointment_id);
      if (!appointment_id) return { ok: false, status: 400, error: "args.appointment_id is required" };
      return { ok: true, cardTriggerArgs: { appointment_id } };
    }
    case "reschedule_appointment": {
      const appointment_id = Number(args.appointment_id);
      if (!appointment_id) return { ok: false, status: 400, error: "args.appointment_id is required" };
      const cardTriggerArgs = { appointment_id };
      // Omitted on purpose IS the "skip, let staff follow up" path — see
      // tools/handlers/reschedule-appointment.js's own branch on this.
      if (args.scheduled_start) cardTriggerArgs.scheduled_start = args.scheduled_start;
      if (args.scheduled_end) cardTriggerArgs.scheduled_end = args.scheduled_end;
      return { ok: true, cardTriggerArgs };
    }
    case "cancel_appointment": {
      const appointment_id = Number(args.appointment_id);
      if (!appointment_id) return { ok: false, status: 400, error: "args.appointment_id is required" };
      // Required by default (ServiceTrade's workflow); a workflow whose
      // capabilities.cancellationReason is "optional" (InspectPoint) relaxes
      // this — see the caller, which resolves the company's workflow before
      // building args.
      if (reasonRequired && (!args.reason || !String(args.reason).trim())) {
        return { ok: false, status: 400, error: "args.reason is required" };
      }
      return {
        ok: true,
        cardTriggerArgs: { appointment_id, reason: args.reason || null, scope: args.scope === "entire_job" ? "entire_job" : "appointment_only" },
      };
    }
    case "confirm_job_appointments":
      return { ok: true, cardTriggerArgs: { confirm_all: args.confirm_all === true, appointment_ids: args.appointment_ids || [] } };
    case "decline_remaining_appointments":
      return { ok: true, cardTriggerArgs: {} };
    case "capture_confirmer_identity": {
      const ROLES = new Set(["management", "on_site", "billing", "scheduling", "owner", "other"]);
      if (!args.first_name || !String(args.first_name).trim()) return { ok: false, status: 400, error: "args.first_name is required" };
      if (!args.last_name || !String(args.last_name).trim()) return { ok: false, status: 400, error: "args.last_name is required" };
      if (!ROLES.has(args.role)) return { ok: false, status: 400, error: `args.role must be one of: ${[...ROLES].join(", ")}` };
      if (!args.phone || !String(args.phone).trim()) return { ok: false, status: 400, error: "args.phone is required" };
      return {
        ok: true,
        cardTriggerArgs: {
          first_name: args.first_name, last_name: args.last_name, role: args.role,
          phone: args.phone, email: args.email || null,
        },
      };
    }
    case "send_service_link": {
      if (!args.email || !String(args.email).trim()) return { ok: false, status: 400, error: "email is required" };
      // email_confirmed is always forced true — the frontend's own Yes/No
      // step (chat-cards-frontend.md's service-link flow) already happened
      // before this call was made, so reaching here at all IS the
      // confirmation, same as the old REST route this replaces.
      return {
        ok: true,
        cardTriggerArgs: {
          email: args.email, email_confirmed: true,
          first_name: args.first_name, last_name: args.last_name, role: args.role, phone: args.phone,
        },
      };
    }
    default:
      // Unreachable via the CARD_TRIGGER_TOOLS gate in the route above —
      // kept as a defensive fallback rather than assuming the caller always
      // checks first.
      return { ok: false, status: 400, error: `Unknown trigger: ${trigger}` };
  }
}

/**
 * Dispatch one card-action trigger — the shared handler behind every
 * `POST /:token/messages` call whose `trigger` is in CARD_TRIGGER_TOOLS.
 * Resolves the token and validates `args` as plain JSON (404/400) BEFORE any
 * SSE stream opens, then owns the SSE lifecycle for the whole request
 * (opens it once, always stops the heartbeat in `finally`) — running either
 * one forced tool turn (the five simple triggers) or, for
 * `send_service_link`, up to two in sequence:
 *
 *   1. Force `resolve_service_link_contact`.
 *   2. If its result is `status: "need_more_info"` — stop here; nothing to
 *      fetch yet, no contact resolved. `done` reflects step 1's cards.
 *   3. Otherwise (a real contact was found/created) — force
 *      `get_service_link` too, so the response also carries a URL the
 *      frontend can render as a preview card. `done` reflects step 2's cards.
 *
 * Any step failing surfaces `error` immediately and skips whatever would
 * have come after it — a failed resolve never reaches get_service_link.
 */
async function handleCardTriggerMessage(req, res, trigger, args) {
  let sse = null;
  try {
    const r = await resolveLinkOnly(req.params.token);
    if (!r.ok) return res.status(r.status).json({ error: r.error });

    // Only cancel_appointment's reason-required check depends on the
    // company's workflow, so only resolve it for that trigger — every other
    // trigger's arg validation is CRM-agnostic and doesn't need this.
    let reasonRequired = true;
    if (trigger === "cancel_appointment") {
      const slug = await resolveSlugForCompany(r.companyId);
      reasonRequired = getWorkflow(slug).capabilities?.cancellationReason !== "optional";
    }
    const built = buildCardTriggerArgs(trigger, args, { reasonRequired });
    if (!built.ok) return res.status(built.status).json({ error: built.error });

    sse = startSse(res);

    if (trigger === "send_service_link") {
      const step1 = await runOneCardTriggerTurn(res, sse, r.threadId, "resolve_service_link_contact", built.cardTriggerArgs);
      if (!step1) return res.end();

      if (step1.toolResult?.status === "need_more_info") {
        sseSend(res, "done", step1.cards);
        return res.end();
      }

      const step2 = await runOneCardTriggerTurn(res, sse, r.threadId, "get_service_link", {});
      if (!step2) return res.end();

      sseSend(res, "done", step2.cards);
      return res.end();
    }

    const turn = await runOneCardTriggerTurn(res, sse, r.threadId, trigger, built.cardTriggerArgs);
    if (!turn) return res.end();

    const done = TRIGGERS_WITH_NEEDS_PROPOSE_REMAINING.has(trigger)
      ? { ...turn.cards, needs_propose_remaining: turn.cards.remaining_unconfirmed > 0 }
      : turn.cards;
    sseSend(res, "done", done);
    return res.end();
  } catch (err) {
    logger.error("POST /:token/messages (card trigger) failed", { trigger, error: err.message });
    if (res.headersSent) { sseSend(res, "error", { error: "Action failed" }); return res.end(); }
    return res.status(500).json({ error: "Action failed" });
  } finally {
    sse?.stop();
  }
}

router.options("/:token/end", openCors);
router.post("/:token/end", openCors, async (req, res) => {
  try {
    const r = await resolveForAction(req.params.token);
    if (!r.ok) return res.status(r.status).json({ error: r.error });

    // Refuse to close a conversation that still has other unconfirmed
    // appointments nobody has actually been asked about yet. NOT a
    // customer-facing error — chat-cards-frontend.md documents this 409 as a
    // pure signal: the frontend must handle it silently and show the
    // "confirm the rest?" step (or send trigger: "decline_remaining_appointments"
    // via /:token/messages), then retry /end.
    if (r.ctx.ok && r.ctx.counts.unconfirmed > 0 && !r.link.remaining_addressed_at) {
      return res.status(409).json({ ok: false, error: "remaining_appointments_unaddressed", code: "remaining_appointments_unaddressed" });
    }

    await confirmationAgent.finalizeConversation(r.threadId, {
      companyId: r.companyId, jobId: r.jobId, recipientName: r.recipientName, confirmedBy: r.confirmedBy,
    });
    return res.json({ ok: true, state: "chat_ended" });
  } catch (err) {
    logger.error("POST /:token/end failed", { error: err.message });
    return res.status(500).json({ error: "Failed to end conversation" });
  }
});

module.exports = router;
// Exported for direct unit testing of the pure arg-building/validation logic
// (notably the cancellationReason relaxation), matching the existing
// convention elsewhere (e.g. servicetrade-comments.js's buildCommentBody/
// deriveLabel) of exposing small pure helpers alongside the route's default export.
module.exports.buildCardTriggerArgs = buildCardTriggerArgs;
