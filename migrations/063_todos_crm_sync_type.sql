-- Allow CRM_SYNC todos — raised when an in-call change was written to our
-- platform (source of truth) but the mirror write to ServiceTrade failed, so a
-- human must reconcile the CRM. Mirrors 062's drop/re-add of the CHECK.

ALTER TABLE todos DROP CONSTRAINT IF EXISTS todos_type_check;
ALTER TABLE todos ADD  CONSTRAINT todos_type_check
  CHECK (type IN ('NOT_PICKED','VOICEMAIL','ASKED_FOR_RESCHEDULE','ASKED_FOR_CANCELLATION','UNCONFIRMED','APPOINTMENT_NEEDED','MISSING_PHONE','SERVICE_OPPORTUNITY','SERVICE_LINK','CRM_SYNC'));
