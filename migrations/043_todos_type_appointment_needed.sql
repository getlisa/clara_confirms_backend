-- Align todos.type CHECK with call_analysis_configs.todo_type so APPOINTMENT_NEEDED inserts succeed.
ALTER TABLE todos DROP CONSTRAINT IF EXISTS todos_type_check;
ALTER TABLE todos ADD CONSTRAINT todos_type_check
  CHECK (type IN ('NOT_PICKED','VOICEMAIL','ASKED_FOR_RESCHEDULE','ASKED_FOR_CANCELLATION','UNCONFIRMED','APPOINTMENT_NEEDED'));
