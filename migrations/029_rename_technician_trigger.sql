-- Rename technician_scheduled → technician_unconfirmed to match frontend naming convention.

-- 1. Drop existing CHECK constraint
ALTER TABLE call_trigger_configs
  DROP CONSTRAINT IF EXISTS call_trigger_configs_trigger_type_check;

-- 2. Rename existing rows
UPDATE call_trigger_configs
SET trigger_type = 'technician_unconfirmed'
WHERE trigger_type = 'technician_scheduled';

-- 3. Add updated CHECK constraint with new name
ALTER TABLE call_trigger_configs
  ADD CONSTRAINT call_trigger_configs_trigger_type_check
  CHECK (trigger_type IN (
    'scheduled_unconfirmed',
    'quotation_pending',
    'open_job_due_soon',
    'technician_unconfirmed'
  ));
