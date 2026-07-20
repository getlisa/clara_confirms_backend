-- Allow APPOINTMENT_CANCELLED todos — a low-priority FYI raised when the agent
-- ITSELF already cancelled an appointment/job live during the call (via the new
-- cancel_appointment tool). Distinct from ASKED_FOR_CANCELLATION, which means
-- the customer asked to cancel but nothing was actioned yet (needs a human).
-- Mirrors 063's drop/re-add of the CHECK.

ALTER TABLE todos DROP CONSTRAINT IF EXISTS todos_type_check;
ALTER TABLE todos ADD  CONSTRAINT todos_type_check
  CHECK (type IN ('NOT_PICKED','VOICEMAIL','ASKED_FOR_RESCHEDULE','ASKED_FOR_CANCELLATION','UNCONFIRMED','APPOINTMENT_NEEDED','MISSING_PHONE','SERVICE_OPPORTUNITY','SERVICE_LINK','CRM_SYNC','APPOINTMENT_CANCELLED'));
