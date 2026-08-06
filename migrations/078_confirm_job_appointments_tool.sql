-- Batch-confirm tool for job-centric confirmations.
--
-- A confirmation conversation is now about a JOB, which can have several
-- upcoming appointments. The agent confirms the next one, then asks "would you
-- like to give confirmation for the other appointments as well?" — this tool is
-- what answers yes.
--
-- Deliberately not a loop over confirm_appointment: that tool has
-- speak_after_execution = true, so N sequential calls make the agent narrate N
-- times, and models drop writes in long tool chains. One call here is also one
-- job-status recompute and one service-link check.
--
-- Attaches to the customer_confirmation node only (technician_confirmation stays
-- appointment-specific — a technician is assigned per appointment).

INSERT INTO tool_definitions
  (call_type, name, description, endpoint, method, parameters,
   speak_during_execution, speak_after_execution, is_write_tool, gated_by_setting, sort_order, enabled)
VALUES
  (
    'customer_confirmation',
    'confirm_job_appointments',
    'Confirm MORE THAN ONE upcoming appointment on this job in a single step. Use this after the customer says yes to "would you like to give confirmation for the other appointments as well?". Set confirm_all=true to confirm every upcoming appointment on the job that isn''t confirmed yet, or pass appointment_ids to confirm only the specific ones the customer agreed to. For a single appointment, use confirm_appointment instead.',
    '/retell/tools/confirm_job_appointments',
    'POST',
    '{"type":"object","required":["job_id"],"properties":{"job_id":{"type":"string","description":"The job ID for this conversation. You were given this value at the start — use that exact numeric ID."},"appointment_ids":{"type":"string","description":"Comma-separated appointment IDs to confirm, e.g. \"234,235\". Use the exact IDs from the get_job result. Leave this out when confirm_all is true."},"confirm_all":{"type":"boolean","description":"True to confirm every upcoming appointment on this job that isn''t confirmed yet."}}}'::jsonb,
    false, true, true, NULL, 8, true
  )
ON CONFLICT DO NOTHING;
