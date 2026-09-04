-- Delete all synced InspectPoint data for company_id = 11 (Ultimate Fire).
--
-- Scoped by BOTH company_id AND source='inspectpoint' on every platform table,
-- so it can never touch manually-created rows or a second CRM's data if one is
-- ever connected to this company. The raw inspectpoint_* mirror tables are
-- scoped by company_id alone — they are InspectPoint-only by definition.
--
-- Credentials are deliberately NOT deleted: inspectpoint_integration keeps the
-- subdomain + API key so the next sync just re-populates. Uncomment the last
-- statement if you want a full disconnect instead.
--
-- ORDER IS LOAD-BEARING — it follows the real FK graph, not intuition:
--   * jobs.customer_id -> customers is RESTRICT (not CASCADE), so every job
--     must be gone before its customer can be deleted. Same for
--     quotations.customer_id, though company 11 has no quotations today.
--   * Deleting jobs CASCADEs to appointments, chat_links, job_comments,
--     job_notes, job_offices, job_tags, scheduling_comments, service_requests
--     and job_confirmation_assessments automatically.
--   * Deleting appointments CASCADEs to appointment_notes, appointment_offices,
--     appointment_services and appointment_technicians.
--   * Deleting contacts CASCADEs to contact_companies and contact_locations.
--   * confirmation_events, confirmation_agent_llm_logs, quotations and
--     service_opportunities are SET NULL, not CASCADE — our own operational
--     history survives with its job/customer reference nulled out. That is
--     intended: the ledger is the platform's record, not the CRM's.
--
-- Run inside the transaction below so a RESTRICT violation rolls everything
-- back rather than leaving a half-deleted graph.

BEGIN;

-- 1. Appointments FIRST, explicitly. They would CASCADE from jobs anyway, but
--    appointments.job_id is nullable (migration 046), so an orphaned visit with
--    job_id IS NULL would otherwise survive the cascade.
DELETE FROM appointments WHERE company_id = 11 AND source = 'inspectpoint';

-- 2. Jobs. Cascades the job_* junctions and comment/note tables listed above.
DELETE FROM jobs WHERE company_id = 11 AND source = 'inspectpoint';

-- 3. Contacts. Cascades contact_companies + contact_locations; nulls out
--    locations.primary_contact_id and jobs.primary_contact_id.
DELETE FROM contacts WHERE company_id = 11 AND source = 'inspectpoint';

-- 4. Locations. Cascades location_offices/location_tags and any remaining
--    contact_locations rows.
DELETE FROM locations WHERE company_id = 11 AND source = 'inspectpoint';

-- 5. Technicians. Cascades appointment_technicians; nulls the technician on any
--    surviving job/appointment (there are none left by this point).
DELETE FROM technicians WHERE company_id = 11 AND source = 'inspectpoint';

-- 6. Customers LAST — the RESTRICT edges from jobs and quotations are only
--    satisfied once everything above is gone.
DELETE FROM customers WHERE company_id = 11 AND source = 'inspectpoint';

-- 7. Raw mirror tables (InspectPoint-only by definition, so company_id alone).
DELETE FROM inspectpoint_appointments WHERE company_id = 11;
DELETE FROM inspectpoint_jobs         WHERE company_id = 11;
DELETE FROM inspectpoint_contacts     WHERE company_id = 11;
DELETE FROM inspectpoint_locations    WHERE company_id = 11;
DELETE FROM inspectpoint_technicians  WHERE company_id = 11;
DELETE FROM inspectpoint_customers    WHERE company_id = 11;

-- 8. Sync cursors/watermarks, so the next run starts clean instead of
--    incrementally skipping everything it already "synced".
DELETE FROM inspectpoint_sync_state WHERE company_id = 11;

-- Optional: full disconnect (forces reconnecting with subdomain + API key).
-- Leave commented to keep credentials and allow an immediate re-sync.
-- DELETE FROM inspectpoint_integration WHERE company_id = 11;

COMMIT;

-- Verification — every count must be 0.
SELECT 'appointments' AS table_name, count(*) FROM appointments WHERE company_id = 11 AND source = 'inspectpoint'
UNION ALL SELECT 'jobs',        count(*) FROM jobs        WHERE company_id = 11 AND source = 'inspectpoint'
UNION ALL SELECT 'contacts',    count(*) FROM contacts    WHERE company_id = 11 AND source = 'inspectpoint'
UNION ALL SELECT 'locations',   count(*) FROM locations   WHERE company_id = 11 AND source = 'inspectpoint'
UNION ALL SELECT 'technicians', count(*) FROM technicians WHERE company_id = 11 AND source = 'inspectpoint'
UNION ALL SELECT 'customers',   count(*) FROM customers   WHERE company_id = 11 AND source = 'inspectpoint'
UNION ALL SELECT 'raw_appointments', count(*) FROM inspectpoint_appointments WHERE company_id = 11
UNION ALL SELECT 'raw_jobs',         count(*) FROM inspectpoint_jobs         WHERE company_id = 11
UNION ALL SELECT 'raw_contacts',     count(*) FROM inspectpoint_contacts     WHERE company_id = 11
UNION ALL SELECT 'raw_locations',    count(*) FROM inspectpoint_locations    WHERE company_id = 11
UNION ALL SELECT 'raw_technicians',  count(*) FROM inspectpoint_technicians  WHERE company_id = 11
UNION ALL SELECT 'raw_customers',    count(*) FROM inspectpoint_customers    WHERE company_id = 11
UNION ALL SELECT 'sync_state',       count(*) FROM inspectpoint_sync_state   WHERE company_id = 11
ORDER BY 1;
