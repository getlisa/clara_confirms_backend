/**
 * Which notification event a finished conversation belongs to.
 *
 * Built ON TOP OF db/todos.js deriveTodoType rather than beside it. That
 * function is already the canonical, priority-ordered outcome classifier for a
 * conversation and returns exactly ONE answer, which is what guarantees one
 * conversation can never produce two emails to the same address. Re-deriving
 * the same judgement here would create a second source of truth that drifts.
 *
 * Two deliberate adaptations:
 *
 * 1. deriveTodoType returns null for the happy path (a confirmed appointment
 *    raises no todo). That is the 'confirmed' event here.
 *
 * 2. `isNoAnswer` is taken from the CALLER, not re-derived. deriveTodoType
 *    carries its own inner NO_ANSWER set which omits the synthetic
 *    'sms_no_reply' that routes/retell.js's NO_ANSWER_REASONS includes — so an
 *    unanswered SMS classifies as UNCONFIRMED through the todo path. The
 *    webhook handlers have already computed the correct isNoAnswer for both
 *    channels, so passing it in lands an unanswered chat on 'not_picked' where
 *    it belongs. The todo behaviour is left exactly as it is: changing it would
 *    alter existing escalations, which is out of scope here.
 */

const todosDb = require("../../db/todos");
const { EVENT_KEYS } = require("../../db/call-notification-recipients");

const TODO_TYPE_TO_EVENT = {
  [todosDb.TODO_TYPES.VOICEMAIL]:               "voicemail",
  [todosDb.TODO_TYPES.NOT_PICKED]:              "not_picked",
  [todosDb.TODO_TYPES.ASKED_FOR_CANCELLATION]:  "cancellation_requested",
  [todosDb.TODO_TYPES.ASKED_FOR_RESCHEDULE]:    "reschedule_requested",
  [todosDb.TODO_TYPES.APPOINTMENT_NEEDED]:      "appointment_needed",
  [todosDb.TODO_TYPES.UNCONFIRMED]:             "unconfirmed",
};

/** Human wording for the subject line and the email's outcome row. */
const EVENT_LABELS = {
  confirmed:              "Confirmed",
  reschedule_requested:   "Reschedule requested",
  cancellation_requested: "Cancellation requested",
  appointment_needed:     "Appointment needed",
  unconfirmed:            "Not confirmed",
  voicemail:              "Voicemail",
  not_picked:             "No answer",
};

/**
 * @param {object} args  the values the webhook handler has already computed
 * @param {boolean} args.inVoicemail
 * @param {boolean} args.isNoAnswer            includes 'sms_no_reply' for chat — see note 2 above
 * @param {string|null} args.disconnectionReason
 * @param {string|null} args.appointmentConfirmed  'yes' | 'no' | 'unclear'
 * @param {boolean} args.rescheduleRequested
 * @param {boolean} args.cancellationRequested
 * @param {string|null} [args.customerOutcome]
 * @returns {string} one key from EVENT_KEYS
 */
function resolveNotificationEvent({
  inVoicemail = false,
  isNoAnswer = false,
  disconnectionReason = null,
  appointmentConfirmed = null,
  rescheduleRequested = false,
  cancellationRequested = false,
  customerOutcome = null,
}) {
  // Checked ahead of deriveTodoType purely to cover 'sms_no_reply', which its
  // own inner set does not know about. Voice no-answers reach the same answer
  // by either route.
  if (!inVoicemail && isNoAnswer) return "not_picked";

  const todoType = todosDb.deriveTodoType({
    inVoicemail,
    disconnectionReason,
    appointmentConfirmed,
    rescheduleRequested,
    cancellationRequested,
    customerOutcome,
  });

  if (todoType === null) return "confirmed"; // happy path — no todo is raised
  return TODO_TYPE_TO_EVENT[todoType] || "unconfirmed";
}

function eventLabel(event) {
  return EVENT_LABELS[event] || event;
}

module.exports = { resolveNotificationEvent, eventLabel, EVENT_LABELS, EVENT_KEYS };
