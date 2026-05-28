-- Add technician_scheduled trigger type to the CHECK constraint.
-- Fires when an appointment is scheduled and a technician is assigned.

ALTER TABLE call_trigger_configs
  DROP CONSTRAINT IF EXISTS call_trigger_configs_trigger_type_check;

ALTER TABLE call_trigger_configs
  ADD CONSTRAINT call_trigger_configs_trigger_type_check
  CHECK (trigger_type IN (
    'scheduled_unconfirmed',
    'quotation_pending',
    'open_job_due_soon',
    'technician_scheduled'
  ));
