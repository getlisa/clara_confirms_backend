-- Per-call extra context for calls that don't fit the flat single-job columns.
--
-- The dispatcher (src/services/scheduler.js) builds Retell dynamic variables
-- from scheduled_calls' flat scalar columns. The Service Opportunity Follow-Up
-- agent needs to carry MULTIPLE service requests' details into one call, which
-- the flat columns can't express. `call_context` is a generic JSONB bag of
-- already-stringified dynamic variables (e.g. service_opportunities,
-- service_opportunity_count, location_name, location_address) that the
-- dispatcher merges into the dynamic-variable dict for that call.
--
-- Nullable and additive — existing call types ignore it.

ALTER TABLE scheduled_calls ADD COLUMN IF NOT EXISTS call_context JSONB;
