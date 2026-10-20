-- A customer accepted Clara's offer to repair open deficiencies on the visit
-- (record_repair_request tool). The office gets a todo listing what they
-- agreed to; ServiceTrade also gets a job comment when write-back is on.
ALTER TABLE todos DROP CONSTRAINT IF EXISTS todos_type_check;
ALTER TABLE todos ADD CONSTRAINT todos_type_check CHECK (type IN (
  'NOT_PICKED', 'VOICEMAIL', 'ASKED_FOR_RESCHEDULE', 'ASKED_FOR_CANCELLATION',
  'UNCONFIRMED', 'APPOINTMENT_NEEDED', 'MISSING_PHONE', 'SERVICE_OPPORTUNITY',
  'SERVICE_LINK', 'CRM_SYNC', 'APPOINTMENT_CANCELLED', 'MISSING_EMAIL',
  'RECIPIENTS_TRUNCATED', 'REPAIR_REQUESTED'
));
