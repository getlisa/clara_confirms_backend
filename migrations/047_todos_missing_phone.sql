-- Allow MISSING_PHONE todos so the scheduler can surface customers/technicians
-- whose phone number is missing — instead of silently skipping the call.

ALTER TABLE todos DROP CONSTRAINT IF EXISTS todos_type_check;
ALTER TABLE todos ADD  CONSTRAINT todos_type_check
  CHECK (type IN ('NOT_PICKED','VOICEMAIL','ASKED_FOR_RESCHEDULE','ASKED_FOR_CANCELLATION','UNCONFIRMED','APPOINTMENT_NEEDED','MISSING_PHONE'));
