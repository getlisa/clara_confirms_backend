-- Allow SERVICE_OPPORTUNITY todos — raised post-call when a customer wanted to
-- book a service opportunity but the agent was not allowed to make changes
-- (agent_can_make_changes = false), so a human must follow up. Mirrors 047's
-- drop/re-add of the CHECK constraint.

ALTER TABLE todos DROP CONSTRAINT IF EXISTS todos_type_check;
ALTER TABLE todos ADD  CONSTRAINT todos_type_check
  CHECK (type IN ('NOT_PICKED','VOICEMAIL','ASKED_FOR_RESCHEDULE','ASKED_FOR_CANCELLATION','UNCONFIRMED','APPOINTMENT_NEEDED','MISSING_PHONE','SERVICE_OPPORTUNITY'));
