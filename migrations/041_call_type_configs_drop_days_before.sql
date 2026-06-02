-- days_before now lives only in call_trigger_configs (it's a trigger property,
-- not a call-type property). Remove the unused duplicate column.
ALTER TABLE call_type_configs DROP COLUMN IF EXISTS days_before;
