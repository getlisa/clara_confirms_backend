-- One-time cleanup: remove InspectPoint inspections that should never have
-- been synced, for company_id = 11.
--
-- WHY THIS IS NEEDED SEPARATELY FROM THE CODE FIX
--
-- `status_name=pending,scheduled` was silently ignored by InspectPoint (the
-- filter takes ONE value, matched on the status display name, and answers an
-- unrecognised value with the full unfiltered set instead of an error). So
-- every inspection ever created was synced — 2,455 rows, of which only ~1,559
-- are open work.
--
-- Fixing the filter stops NEW non-open rows arriving, but does nothing about
-- the ones already stored: `normalizeAll` re-reads the whole
-- `inspectpoint_jobs` raw table on every run and re-upserts platform `jobs`
-- from it, so those 891 rows would keep being rewritten as cancelled/completed
-- jobs forever. They have to be deleted from the RAW table, not just the
-- platform one.
--
-- Scoped by status_code, so genuinely open work is untouched. Safe to re-run.
--
-- Order matters: `jobs.customer_id -> customers` is RESTRICT, and deleting a
-- job CASCADEs to its appointments — same FK reasoning as
-- delete-inspectpoint-company-11.sql.

BEGIN;

-- 1. Platform appointments belonging to non-open inspections. Explicit rather
--    than relying on the cascade from `jobs`, because appointments.job_id is
--    nullable (migration 046) — an orphaned appointment would otherwise survive.
DELETE FROM appointments a
 USING jobs j
 WHERE a.job_id = j.id
   AND j.company_id = 11 AND j.source = 'inspectpoint'
   AND j.status IN ('cancelled', 'completed');

-- 2. Platform jobs derived from non-open inspections.
--    'in_progress' (InspectPoint `started`) is deliberately KEPT — a visit
--    already under way is still real work, and the agent may legitimately need
--    to talk about it.
DELETE FROM jobs
 WHERE company_id = 11 AND source = 'inspectpoint'
   AND status IN ('cancelled', 'completed');

-- 3. The raw rows themselves — the actual source of the recurring rewrite.
--    Mirrors normalize.js's JOB_STATUS_MAP: these are the codes that map to
--    'cancelled' or 'completed'. `pending`, `scheduled`, `started`, `quoted`,
--    `proposal_approved`, `processing` and `error` are all left in place.
DELETE FROM inspectpoint_jobs
 WHERE company_id = 11
   AND status_code IN (
     'cancelled', 'cancelled_by_parent_tenant', 'deleted_by_technician',
     'completed', 'invoiced', 'paid', 'waiting_for_review', 'ready_to_generate'
   );

-- 4. Raw visits whose parent inspection just went away, so the next normalize
--    can't resurrect an appointment for a job that no longer exists.
DELETE FROM inspectpoint_appointments a
 WHERE a.company_id = 11
   AND NOT EXISTS (
     SELECT 1 FROM inspectpoint_jobs j
      WHERE j.company_id = a.company_id
        AND j.inspectpoint_id = a.inspectpoint_job_id
   );

COMMIT;

-- Verification — the two status lists must contain only open/in-flight work.
SELECT 'raw' AS layer, status_code AS status, count(*)
  FROM inspectpoint_jobs WHERE company_id = 11 GROUP BY 1, 2
UNION ALL
SELECT 'platform', status, count(*)
  FROM jobs WHERE company_id = 11 AND source = 'inspectpoint' GROUP BY 1, 2
ORDER BY 1, 3 DESC;
