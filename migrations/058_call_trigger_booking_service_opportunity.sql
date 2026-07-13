-- Add the 'booking_service_opportunity' trigger type for the new
-- Service Opportunity Follow-Up calling agent. Mirrors 029's drop/re-add of the
-- CHECK constraint. (This trigger is user-initiated only — a config row exists
-- for settings visibility + call_type mapping + enable flag; there is no cron
-- processTrigger sweep for it.)

ALTER TABLE call_trigger_configs
  DROP CONSTRAINT IF EXISTS call_trigger_configs_trigger_type_check;

ALTER TABLE call_trigger_configs
  ADD CONSTRAINT call_trigger_configs_trigger_type_check
  CHECK (trigger_type IN (
    'scheduled_unconfirmed',
    'quotation_pending',
    'open_job_due_soon',
    'technician_unconfirmed',
    'booking_service_opportunity'
  ));
