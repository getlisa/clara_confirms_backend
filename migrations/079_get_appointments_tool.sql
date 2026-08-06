-- Appointment data comes from a tool; job details come from the prompt.
--
-- Replaces two read tools with one:
--   get_job          (job + every appointment on it)  → gone
--   get_appointment  (one appointment by id)          → gone
--   get_appointments (every appointment on a job)     → new
--
-- Why: Retell binds dynamic variables ONCE, at createCall / chat.create. Any
-- appointment fact injected as a variable is therefore a snapshot that goes
-- stale as the agent confirms, reschedules, cancels or creates appointments
-- mid-conversation — and it duplicated the tool, so two sources of the same fact
-- could disagree. Job details don't have that problem (they don't change during
-- a call), so those stay in the prompt and this tool is purely appointments.
--
-- get_job is removed for technician_confirmation too: every job detail that
-- prompt needs was already injected as a variable, so its get_job call was
-- redundant.
--
-- NOTE on why the UPDATE below is required, not optional: toolDefsDb.seedAll()
-- is an upsert loop over TOOL_SEEDS and never deletes rows that left the array.
-- registerToolsForCompany rebuilds each Retell node's `tools` array wholesale
-- from `getAll()`, which filters `enabled = true` — so flipping `enabled` is
-- what actually removes a tool from the live agent. Removing the seed alone
-- leaves the DB row enabled and the tool still registered.
-- Disabled rather than DELETEd so the rows stay as a record and this is
-- trivially reversible (same approach as migrations/071).

INSERT INTO tool_definitions
  (call_type, name, description, endpoint, method, parameters,
   speak_during_execution, speak_after_execution, execution_message_description,
   is_write_tool, gated_by_setting, sort_order, enabled)
VALUES
  (
    'customer_confirmation',
    'get_appointments',
    'Retrieve every appointment on this job — how many are upcoming, which one is next, and for each one its date, assigned technician, service line, services and whether the customer has already confirmed it. Also returns a few past appointments. This is the ONLY source of appointment information: you were given the JOB''s details up front, but nothing about its appointments. Call this first and state nothing about dates, counts, technicians or services until you have.',
    '/retell/tools/get_appointments',
    'POST',
    '{"type":"object","required":["job_id"],"properties":{"job_id":{"type":"string","description":"The job ID for this conversation. You were given this value at the start — use that exact numeric ID."}}}'::jsonb,
    true, false, 'Let me pull up the appointments on this job.',
    false, NULL, 1, true
  ),
  (
    'technician_confirmation',
    'get_appointments',
    'Retrieve the appointments on this job — the scheduled date/time, service line and confirmation status of each. Use it to verify the appointment time before you confirm the technician''s availability. The job''s own details were given to you up front.',
    '/retell/tools/get_appointments',
    'POST',
    '{"type":"object","required":["job_id"],"properties":{"job_id":{"type":"string","description":"The job ID for this call. You were given this value at the start of the call — use that exact numeric ID."}}}'::jsonb,
    true, false, 'Let me pull up the appointment details.',
    false, NULL, 1, true
  )
ON CONFLICT (call_type, name) DO UPDATE SET
  description                   = EXCLUDED.description,
  endpoint                      = EXCLUDED.endpoint,
  parameters                    = EXCLUDED.parameters,
  speak_during_execution        = EXCLUDED.speak_during_execution,
  speak_after_execution         = EXCLUDED.speak_after_execution,
  execution_message_description = EXCLUDED.execution_message_description,
  sort_order                    = EXCLUDED.sort_order,
  enabled                       = true,
  updated_at                    = NOW();

UPDATE tool_definitions
   SET enabled = false, updated_at = NOW()
 WHERE name IN ('get_job', 'get_appointment');

-- The six appointment variables this replaces. Left in place they would keep
-- being emitted into every flow's default_dynamic_variables (buildDefaultsForCompany
-- reads the DB, not the seed array) — harmless but misleading, since nothing
-- populates them any more.
DELETE FROM dynamic_variable_definitions
 WHERE name IN (
   'upcoming_appointment_count',
   'next_appointment_date',
   'next_appointment_service',
   'next_appointment_technician',
   'upcoming_appointments_summary',
   'all_appointments_confirmed'
 );
