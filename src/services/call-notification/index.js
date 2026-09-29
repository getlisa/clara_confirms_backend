/**
 * Per-conversation notification emails — CMAP-224 / CMAP-226.
 *
 * Stage 1 of two. The webhook calls enqueueForConversation the moment a call or
 * chat is analysed; it does no network work beyond the database, so
 * routes/retell.js still returns fast (that file's own comment explains why
 * that matters on Vercel). Stage 2 — services/call-notification/drain.js — does
 * the fetching and sending on a cron.
 *
 * The split exists because Retell types recording_url as optional and its S3
 * object can lag the call_analyzed webhook. Fetching inline would cost the
 * audio on that email permanently; deferring gets retries for free.
 *
 * LOGGING: every step below logs, including the two "do nothing" outcomes
 * (switch off, nobody subscribed). Those are the states someone debugging "why
 * did no email arrive?" actually needs to distinguish, and silence cannot tell
 * them apart. See log.js for the grep recipe.
 */

const callSettingsDb = require("../../db/call-settings");
const recipientsDb = require("../../db/call-notification-recipients");
const sendsDb = require("../../db/call-notification-sends");
const logger = require("../../utils/logger");
const { resolveNotificationEvent, eventLabel } = require("./event");
const { PREFIX, maskEmail, since } = require("./log");

/**
 * Queue one email per subscribed recipient for a finished conversation.
 *
 * Every argument except companyId/retellCallId is a value the webhook handler
 * has ALREADY computed — nothing is re-derived here, so the notification can
 * never disagree with the todo raised for the same call.
 *
 * @returns {Promise<{event: string|null, queued: number, reason?: string}>}
 */
async function enqueueForConversation({
  companyId, retellCallId, callId = null, channel = "voice",
  inVoicemail = false, isNoAnswer = false, disconnectionReason = null,
  appointmentConfirmed = null, rescheduleRequested = false, cancellationRequested = false,
  customerOutcome = null,
}) {
  const startedAt = Date.now();

  if (!companyId || !retellCallId) {
    logger.warn(`${PREFIX} enqueue 0/4 — refused: missing identifiers`, {
      companyId: companyId ?? null, retellCallId: retellCallId ?? null,
    });
    return { event: null, queued: 0, reason: "missing_identifiers" };
  }

  logger.info(`${PREFIX} enqueue 1/4 — conversation analysed, evaluating`, {
    companyId, retellCallId, callId, channel,
  });

  // Cheapest gate first: a company with this switched off costs one query.
  const settings = await callSettingsDb.getByCompanyId(companyId);
  if (settings?.call_notification_enabled !== true) {
    logger.info(`${PREFIX} enqueue 2/4 — STOP: notifications are off for this company`, {
      companyId, retellCallId, ms: since(startedAt),
    });
    return { event: null, queued: 0, reason: "disabled" };
  }
  logger.info(`${PREFIX} enqueue 2/4 — notifications are on`, { companyId, retellCallId });

  const event = resolveNotificationEvent({
    inVoicemail, isNoAnswer, disconnectionReason,
    appointmentConfirmed, rescheduleRequested, cancellationRequested, customerOutcome,
  });
  // The inputs are logged alongside the verdict so a misclassification can be
  // diagnosed from the log line alone, without replaying the webhook.
  logger.info(`${PREFIX} enqueue 3/4 — outcome classified`, {
    companyId, retellCallId, event, label: eventLabel(event),
    from: { inVoicemail, isNoAnswer, disconnectionReason, appointmentConfirmed,
            rescheduleRequested, cancellationRequested, customerOutcome },
  });

  const recipients = await recipientsDb.listEnabledForEvent(companyId, event);
  if (!recipients.length) {
    logger.info(`${PREFIX} enqueue 4/4 — STOP: no enabled recipient subscribed to '${event}'`, {
      companyId, retellCallId, event, ms: since(startedAt),
    });
    return { event, queued: 0, reason: "no_recipients_for_event" };
  }

  let queued = 0;
  let duplicates = 0;
  let failed = 0;
  for (const recipient of recipients) {
    try {
      // Returns null when a row already exists for this (call, address): a
      // Retell webhook replay therefore queues — and sends — nothing twice.
      const row = await sendsDb.enqueue({
        companyId, callId, retellCallId,
        recipientId: recipient.id, email: recipient.email, event, channel,
      });
      if (row) {
        queued += 1;
        logger.info(`${PREFIX} enqueue     → queued`, {
          retellCallId, sendId: row.id, recipientId: recipient.id,
          email: maskEmail(recipient.email), event,
        });
      } else {
        duplicates += 1;
        logger.info(`${PREFIX} enqueue     → already queued, skipping (webhook replay)`, {
          retellCallId, recipientId: recipient.id, email: maskEmail(recipient.email),
        });
      }
    } catch (err) {
      // One bad row must not cost the other recipients their email.
      failed += 1;
      logger.error(`${PREFIX} enqueue     → enqueue failed for recipient`, {
        companyId, retellCallId, recipientId: recipient.id,
        email: maskEmail(recipient.email), error: err.message,
      });
    }
  }

  logger.info(`${PREFIX} enqueue 4/4 — done`, {
    companyId, retellCallId, event, label: eventLabel(event),
    subscribed: recipients.length, queued, duplicates, failed, ms: since(startedAt),
  });
  return { event, queued };
}

module.exports = { enqueueForConversation, resolveNotificationEvent, eventLabel };
