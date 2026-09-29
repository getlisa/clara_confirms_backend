/**
 * Build the per-conversation notification email: outcome, summary, transcript,
 * and the recording as a playable attachment.
 *
 * Two hard rules this file enforces:
 *
 * 1. NO RETELL URL, ever — not in the HTML, not in the plain-text part, not as
 *    a fallback when the audio could not be attached. The recording URL is an
 *    unauthenticated link to a customer conversation and an email is
 *    forwardable. The audio travels as bytes or not at all.
 *
 * 2. The subject carries the literal word "Outbound" (CMAP-226). Ultimate Fire
 *    already receives inbound answering-service mail from a different system
 *    into the same inbox; that token is what makes a mail rule possible.
 */

const config = require("../../config");
const { buildEmailTemplate, COMPANY_NAME } = require("../../utils/email");
const { eventLabel } = require("./event");

// Inline transcript budget. Past this the body shows the tail and says so —
// the .txt attachment always carries the whole thing, so nothing is lost.
const INLINE_TRANSCRIPT_MAX_CHARS = 12000;

function escapeHtml(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Safe for a filename on any platform. */
function slugify(str, fallback = "call") {
  const out = String(str || "").trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return out || fallback;
}

function formatDuration(ms) {
  if (ms == null || !Number.isFinite(Number(ms))) return null;
  const total = Math.round(Number(ms) / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * The `transcript` column is jsonb written via JSON.stringify, and the two
 * channels do not agree on shape: voice stores Retell's plain STRING
 * ("Agent: ...\nUser: ..."), chat can store an ARRAY of {role, content} turns.
 * Both must render, and neither may throw — a malformed transcript must not
 * cost the recipient the whole email.
 */
function transcriptToText(transcript) {
  if (transcript == null) return "";
  if (typeof transcript === "string") return transcript.trim();

  if (Array.isArray(transcript)) {
    return transcript
      .map((turn) => {
        if (turn == null) return "";
        if (typeof turn === "string") return turn;
        const role = turn.role || turn.speaker || "";
        const content = turn.content ?? turn.message ?? turn.text ?? "";
        if (!content) return "";
        const who = role === "agent" ? "Agent" : role === "user" ? "Customer" : (role || "—");
        return `${who}: ${content}`;
      })
      .filter(Boolean)
      .join("\n");
  }

  // Anything else (an object, a number) — stringify rather than lose it.
  try { return JSON.stringify(transcript, null, 2); } catch { return String(transcript); }
}

/** Speaker turns as HTML, with the agent and customer visually distinguishable. */
function transcriptToHtml(text) {
  if (!text) {
    return `<p style="margin:0;color:#94a3b8;font-style:italic;">No transcript was captured for this conversation.</p>`;
  }

  let body = text;
  let truncatedNote = "";
  if (body.length > INLINE_TRANSCRIPT_MAX_CHARS) {
    body = body.slice(0, INLINE_TRANSCRIPT_MAX_CHARS);
    truncatedNote = `<p style="margin:12px 0 0 0;font-size:12px;color:#64748b;">Transcript truncated here — the attached .txt file has the full conversation.</p>`;
  }

  const rows = body.split("\n").map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return "";
    const match = trimmed.match(/^(Agent|Customer|User|Bot)\s*:\s*(.*)$/i);
    if (!match) {
      return `<p style="margin:0 0 8px 0;color:#334155;">${escapeHtml(trimmed)}</p>`;
    }
    const isAgent = /^(agent|bot)$/i.test(match[1]);
    const who = isAgent ? "Agent" : "Customer";
    const colour = isAgent ? "#0f172a" : "#1d4ed8";
    return `<p style="margin:0 0 8px 0;color:#334155;"><span style="font-weight:700;color:${colour};">${who}:</span> ${escapeHtml(match[2])}</p>`;
  }).join("");

  return `<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:16px;font-size:13px;line-height:1.6;">${rows}${truncatedNote}</div>`;
}

/** The facts table above the summary. Only rows with a value are rendered. */
function detailTableHtml(rows) {
  const cells = rows
    .filter(([, value]) => value != null && value !== "")
    .map(([label, value]) => `
      <tr>
        <td style="padding:6px 12px 6px 0;color:#64748b;font-size:13px;white-space:nowrap;vertical-align:top;">${escapeHtml(label)}</td>
        <td style="padding:6px 0;color:#0f172a;font-size:13px;font-weight:600;">${escapeHtml(value)}</td>
      </tr>`)
    .join("");
  return `<table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;margin:0 0 20px 0;">${cells}</table>`;
}

/**
 * @param {object} args
 * @param {object} args.call            the calls row (rowToCall shape)
 * @param {string} args.event           notification event key
 * @param {string} args.companyName
 * @param {string|null} args.whenLabel  conversation time, already in company tz
 * @param {object|null} args.recording  a fetchRecording() result, or null for chat
 * @param {string|null} args.portalUrl
 * @param {string|null} args.recipientName
 * @returns {{subject: string, html: string, text: string, attachments: Array}}
 */
function buildNotificationEmail({
  call, event, companyName, whenLabel = null, recording = null,
  portalUrl = null, recipientName = null,
}) {
  const isChat = (call.channel || "voice") === "sms";
  const medium = isChat ? "chat" : "call";
  const customer = call.customer?.name || call.location_name || call.to_number || "Unknown contact";
  const outcome = eventLabel(event);

  // "Outbound" is load-bearing — see the file header.
  const testTag = call.is_test ? "[TEST] " : "";
  const subject = `${testTag}${COMPANY_NAME} · Outbound ${medium} — ${customer} — ${outcome}`;

  const details = detailTableHtml([
    ["Outcome",  outcome],
    ["Customer", customer],
    ["Site",     call.location_name],
    ["Job",      call.job_name],
    ["Phone",    call.to_number],
    ["When",     whenLabel],
    ["Duration", isChat ? null : formatDuration(call.duration_ms)],
    ["Channel",  isChat ? "SMS chat" : "Phone call"],
    ["Sentiment", call.user_sentiment && call.user_sentiment !== "Unknown" ? call.user_sentiment : null],
  ]);

  const summaryHtml = call.call_summary
    ? `<p style="margin:0 0 20px 0;color:#334155;">${escapeHtml(call.call_summary)}</p>`
    : `<p style="margin:0 0 20px 0;color:#94a3b8;font-style:italic;">No summary was generated for this ${medium}.</p>`;

  // The one line about the recording. When the audio could not be attached this
  // says WHY and points at the portal — never at Retell.
  let recordingHtml = "";
  if (!isChat) {
    if (recording?.status === "ok") {
      recordingHtml = `<p style="margin:0 0 20px 0;color:#334155;">🎧 <strong>The recording is attached</strong> — most email apps will play it right here in this message.</p>`;
    } else {
      const why = recording?.reason ? ` (${recording.reason})` : "";
      recordingHtml = `<p style="margin:0 0 20px 0;color:#64748b;">The recording could not be attached to this email${escapeHtml(why)}. It is still available on the call's page in the portal.</p>`;
    }
  }

  const transcriptText = transcriptToText(call.transcript);
  const bodyHtml = `
    ${details}
    ${recordingHtml}
    <p style="margin:0 0 4px 0;font-weight:700;color:#0f172a;font-size:13px;">Summary</p>
    ${summaryHtml}
    <p style="margin:0 0 8px 0;font-weight:700;color:#0f172a;font-size:13px;">Transcript</p>
    ${transcriptToHtml(transcriptText)}`;

  const html = buildEmailTemplate({
    userName: recipientName,
    companyName,
    greetingWord: "Hi",
    title: `Outbound ${medium} to ${customer} — ${outcome}.`,
    bodyHtml,
    ...(portalUrl ? { buttonText: "Open in portal", buttonUrl: portalUrl } : {}),
    footerText: "You're receiving this because your address is on this company's call notification list. An admin can change which outcomes you're notified about in Settings.",
  });

  const textLines = [
    `${companyName} — outbound ${medium}`,
    `Outcome:  ${outcome}`,
    `Customer: ${customer}`,
    call.location_name ? `Site:     ${call.location_name}` : null,
    whenLabel ? `When:     ${whenLabel}` : null,
    "",
    "Summary",
    call.call_summary || `(none generated for this ${medium})`,
    "",
    "Transcript",
    transcriptText || "(none captured)",
  ].filter((l) => l !== null);
  const text = textLines.join("\n");

  // ── Attachments ──────────────────────────────────────────────────────────
  // utils/email.js base64-encodes a raw Buffer for SendGrid and sets
  // disposition "attachment", which is correct here: "inline" is for
  // cid:-referenced images, not audio.
  const datePart = new Date(call.created_at || Date.now()).toISOString().slice(0, 10);
  const stem = `${datePart}-${slugify(customer)}`;
  const attachments = [];

  if (recording?.status === "ok" && recording.buffer) {
    attachments.push({
      filename: `${medium}-${stem}.${recording.ext}`,
      content: recording.buffer,
      contentType: recording.contentType,
    });
  }

  attachments.push({
    filename: `transcript-${stem}.txt`,
    content: Buffer.from(text, "utf8"),
    contentType: "text/plain",
  });

  return { subject, html, text, attachments };
}

/**
 * Deep link to the call in the portal.
 *
 * NOTE FOR THE FRONTEND AGENT: this path is a placeholder. Confirm the real
 * route for a call's detail view and correct this one constant — it is the only
 * place the app's own URL shape is assumed.
 */
function buildPortalUrl(callId) {
  if (!config.frontendUrl || !callId) return null;
  return `${config.frontendUrl}/logs?call=${encodeURIComponent(callId)}`;
}

module.exports = {
  buildNotificationEmail, buildPortalUrl,
  transcriptToText, transcriptToHtml, slugify, formatDuration,
  INLINE_TRANSCRIPT_MAX_CHARS,
};
