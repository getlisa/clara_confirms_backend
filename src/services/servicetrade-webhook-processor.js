/**
 * Applies queued ServiceTrade webhook events.
 *
 * The receiver could only afford one INSERT (5-second delivery budget), so this
 * is where the work happens: turn each event into the ServiceTrade JOB ids it
 * affects, refresh those jobs through the existing sync pipeline, then
 * normalize.
 *
 * ── Why everything resolves to a job id ────────────────────────────────────
 * runSync's per-job detail fetch already fans out the entire graph around a
 * job — appointments, customer, location, contacts, offices, tags,
 * technicians, comments — so feeding it a job id refreshes all of them with no
 * second code path to keep in step with the bulk sync. An event about a
 * contact or a location is therefore translated into "which jobs does this
 * affect", not into a bespoke contact fetch.
 *
 * ── What this does NOT do ──────────────────────────────────────────────────
 * It is not a replacement for the hourly /admin/crm-sync. ServiceRequest is not
 * a webhookable entity, so service_opportunities can only ever come from the
 * poll; and ServiceTrade discards a message after 3 failed delivery attempts,
 * so an outage means events are simply gone. The poll remains the correctness
 * backstop — this only makes the common case fast.
 */

const db = require("../db");
const webhooksDb = require("../db/servicetrade-webhooks");
const credentialsDb = require("../db/servicetrade-credentials");
const stEngine = require("./servicetrade-sync");
const logger = require("../utils/logger");

// How many queued events one drain pass claims per company. Each pass ends with
// a single sync + normalize over the union of resolved job ids, so a bigger
// batch is *cheaper* per event, not more expensive — the cap exists to bound
// one invocation's wall time, not the work itself.
const BATCH_SIZE = Number(process.env.SERVICETRADE_WEBHOOK_BATCH) || 100;

// An event about a customer, location or contact can implicate many jobs. A
// renamed customer with 80 open jobs must not trigger 80 job-detail fetches, so
// the fan-out is capped and restricted to jobs that still have an outstanding
// appointment — the only ones the confirmation product acts on.
const MAX_JOBS_PER_INDIRECT_EVENT = 25;

const OUTSTANDING = "('scheduled','confirmed','rescheduled')";

// ServiceTrade ids are ~2.3e15 today — within Number's exact range, but close
// enough to 2^53 that converting them would eventually corrupt one SILENTLY and
// sync the wrong job. They stay strings end to end: external_ref is TEXT,
// pg returns BIGINT as a string anyway, and the id is only ever interpolated
// into a URL path.
const isRef = (v) => typeof v === "string" && /^[0-9]{1,19}$/.test(v);

/**
 * Jobs with at least one outstanding appointment, filtered by a join on some
 * related entity's external_ref. Ordered soonest-first so that when the cap
 * bites, it keeps the visits happening next rather than an arbitrary slice.
 */
async function jobsByRelated(sql, params) {
  const { rows } = await db.query(sql, params);
  return rows.map((r) => String(r.external_ref)).filter(isRef);
}

async function jobsForCustomer(companyId, customerRef) {
  return jobsByRelated(`
    SELECT DISTINCT j.external_ref, min(a.scheduled_start) AS soonest
      FROM jobs j
      JOIN customers c ON c.id = j.customer_id
      JOIN appointments a ON a.job_id = j.id AND a.status IN ${OUTSTANDING}
     WHERE j.company_id = $1 AND c.external_ref = $2 AND j.external_ref IS NOT NULL
     GROUP BY j.external_ref
     ORDER BY soonest
     LIMIT $3`, [companyId, String(customerRef), MAX_JOBS_PER_INDIRECT_EVENT]);
}

async function jobsForLocation(companyId, locationRef) {
  return jobsByRelated(`
    SELECT DISTINCT j.external_ref, min(a.scheduled_start) AS soonest
      FROM jobs j
      JOIN locations l ON l.id = j.location_id
      JOIN appointments a ON a.job_id = j.id AND a.status IN ${OUTSTANDING}
     WHERE j.company_id = $1 AND l.external_ref = $2 AND j.external_ref IS NOT NULL
     GROUP BY j.external_ref
     ORDER BY soonest
     LIMIT $3`, [companyId, String(locationRef), MAX_JOBS_PER_INDIRECT_EVENT]);
}

/**
 * A contact reaches jobs three ways: as a job's primary contact, and through
 * the customer/location junctions that migration 081's confirmation-recipients
 * feature depends on. A contact's phone or email changing is exactly the kind
 * of edit that must reach us before we place a call, so all three count.
 */
async function jobsForContact(companyId, contactRef) {
  return jobsByRelated(`
    SELECT DISTINCT j.external_ref, min(a.scheduled_start) AS soonest
      FROM contacts ct
      JOIN jobs j ON j.company_id = ct.company_id AND (
             j.primary_contact_id = ct.id
          OR j.customer_id IN (SELECT customer_id FROM contact_companies WHERE contact_id = ct.id)
          OR j.location_id IN (SELECT location_id FROM contact_locations WHERE contact_id = ct.id)
      )
      JOIN appointments a ON a.job_id = j.id AND a.status IN ${OUTSTANDING}
     WHERE ct.company_id = $1 AND ct.external_ref = $2 AND j.external_ref IS NOT NULL
     GROUP BY j.external_ref
     ORDER BY soonest
     LIMIT $3`, [companyId, String(contactRef), MAX_JOBS_PER_INDIRECT_EVENT]);
}

/** A technician reassignment arrives as a `user` event; find their open work. */
async function jobsForUser(companyId, userRef) {
  return jobsByRelated(`
    SELECT DISTINCT j.external_ref, min(a.scheduled_start) AS soonest
      FROM jobs j
      JOIN appointments a ON a.job_id = j.id AND a.status IN ${OUTSTANDING}
      JOIN appointment_technicians at ON at.appointment_id = a.id
      JOIN technicians t ON t.id = at.technician_id
     WHERE j.company_id = $1 AND t.external_ref = $2 AND j.external_ref IS NOT NULL
     GROUP BY j.external_ref
     ORDER BY soonest
     LIMIT $3`, [companyId, String(userRef), MAX_JOBS_PER_INDIRECT_EVENT]);
}

/**
 * An appointment event names the appointment, not its job. The local raw table
 * answers this for free for any appointment we have already synced.
 *
 * For one we have never seen (a brand-new appointment on a job outside our
 * month window) we ask ServiceTrade — except for `deleted`, where the record is
 * already gone and the fetch would 404. A deleted appointment we never had is
 * genuinely nothing to do.
 */
async function jobForAppointment(companyId, appointmentRef, action, credentials) {
  const { rows } = await db.query(
    `SELECT servicetrade_job_id FROM servicetrade_appointments
      WHERE company_id = $1 AND servicetrade_id = $2`,
    [companyId, String(appointmentRef)]
  );
  const local = rows[0]?.servicetrade_job_id;
  if (local) return String(local);
  if (action === "deleted") return null;

  const res = await stEngine.requestWithRetry(companyId, "GET", `/appointment/${appointmentRef}`, {}, credentials);
  if (!res.ok) return null;
  // Both documented response shapes: flat (job embedded as an object) and
  // compound (job carried as a bare id).
  const appt = res.data?.appointment || res.data;
  const jobId = String(appt?.job?.id ?? appt?.job ?? appt?.jobId ?? "");
  return isRef(jobId) ? jobId : null;
}

/**
 * Resolve one claimed event to the job ids it affects.
 * @returns {Promise<string[]>} possibly empty — an empty result is a legitimate
 *   outcome (the entity touches no job we track), not a failure.
 */
async function resolveJobIds(companyId, event, credentials) {
  const ref = event.entity_id;
  switch (event.entity_type) {
    case "job":
      return isRef(String(ref)) ? [String(ref)] : [];
    case "appointment": {
      const jobId = await jobForAppointment(companyId, ref, event.action, credentials);
      return jobId ? [jobId] : [];
    }
    case "company":  return jobsForCustomer(companyId, ref);
    case "location": return jobsForLocation(companyId, ref);
    case "contact":  return jobsForContact(companyId, ref);
    case "user":     return jobsForUser(companyId, ref);
    default:         return [];
  }
}

/**
 * Drain one company's queue.
 *
 * Resolution failures and sync failures are handled differently on purpose:
 * a single event that cannot be resolved is marked failed (or skipped) and the
 * rest of the batch proceeds, whereas a failed sync returns the WHOLE batch to
 * 'pending' — the jobs were not refreshed, so pretending otherwise would lose
 * the changes until the hourly poll happened to cover them.
 */
async function drainCompany(companyId, { batchSize = BATCH_SIZE } = {}) {
  const events = await webhooksDb.claimPending(companyId, batchSize);
  if (events.length === 0) return { claimed: 0, jobIds: [], synced: false };

  const credentials = await credentialsDb.getByCompanyId(companyId);
  if (!credentials) {
    // Disconnected mid-flight. Back to pending: a reconnect should apply these
    // rather than have them silently expire.
    await webhooksDb.markFailed(events.map((e) => e.id), "ServiceTrade not connected");
    return { claimed: events.length, jobIds: [], synced: false, error: "not connected" };
  }

  const jobIds = new Set();
  const resolvedIds = [];
  const skippedIds = [];
  const failedIds = [];

  for (const event of events) {
    try {
      const ids = await resolveJobIds(companyId, event, credentials);
      if (ids.length === 0) {
        skippedIds.push(event.id);
        continue;
      }
      ids.forEach((id) => jobIds.add(id));
      resolvedIds.push({ id: event.id, jobRef: ids[0] });
    } catch (err) {
      logger.warn("ServiceTrade webhook: resolve failed", {
        companyId, eventId: event.id, entity: `${event.entity_type}#${event.entity_id}`, error: err.message,
      });
      failedIds.push(event.id);
    }
  }

  if (skippedIds.length) await webhooksDb.markSkipped(skippedIds, "no job affected");
  if (failedIds.length) await webhooksDb.markFailed(failedIds, "could not resolve job");

  if (jobIds.size === 0) {
    return { claimed: events.length, jobIds: [], synced: false, skipped: skippedIds.length, failed: failedIds.length };
  }

  const ids = [...jobIds];
  logger.info("ServiceTrade webhook drain: syncing jobs", { companyId, events: events.length, jobs: ids.length });

  try {
    const sync = await stEngine.runSync(companyId, { jobIds: ids });
    if (!sync.success) throw new Error(sync.error || "targeted sync failed");

    // normalizeAll is watermark-driven (migration 086), so it picks up exactly
    // the raw rows the targeted sync just wrote — no need to tell it which.
    // Required lazily: provider.js requires the CRM registry, which requires
    // this module's siblings, and a top-level require closes that loop.
    const provider = require("./crm/servicetrade/provider");
    await provider.normalizeAll(companyId);

    // One statement, per-event resolved_job_ref, so a stale row stays traceable
    // to the job it came from.
    await webhooksDb.markDoneWithRefs(resolvedIds);
    return { claimed: events.length, jobIds: ids, synced: true, skipped: skippedIds.length, failed: failedIds.length };
  } catch (err) {
    logger.error("ServiceTrade webhook drain: sync failed", { companyId, jobs: ids.length, error: err.message });
    // Whole batch back to pending — nothing was refreshed.
    await webhooksDb.markFailed(resolvedIds.map((r) => r.id), err.message);
    return { claimed: events.length, jobIds: ids, synced: false, error: err.message };
  }
}

/**
 * Drain every company with queued events. Sequential by company: a targeted
 * sync already runs its own bounded-concurrency fetches, and two companies
 * draining at once would multiply that against the same ServiceTrade rate limit.
 */
async function drainAll({ batchSize = BATCH_SIZE } = {}) {
  const companyIds = await webhooksDb.listCompaniesWithPending();
  const byCompany = {};
  for (const companyId of companyIds) {
    try {
      byCompany[companyId] = await drainCompany(companyId, { batchSize });
    } catch (err) {
      logger.error("ServiceTrade webhook drain failed", { companyId, error: err.message });
      byCompany[companyId] = { error: err.message };
    }
  }
  return { companies: companyIds.length, byCompany };
}

module.exports = {
  drainAll, drainCompany, resolveJobIds,
  jobsForCustomer, jobsForLocation, jobsForContact, jobsForUser, jobForAppointment,
  BATCH_SIZE, MAX_JOBS_PER_INDIRECT_EVENT,
};
