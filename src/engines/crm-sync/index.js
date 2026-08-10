/**
 * CrmSyncEngine — orchestrates a full CRM sync (raw + normalize) and emits
 * progress as workflow-engine events.
 *
 * State machine (as actually emitted by the ServiceTrade provider):
 *   started → authenticating → fetching_jobs → fetching_job_details
 *           → fetching_appointments → fetching_job_comments
 *           → fetching_service_requests → normalizing → done | failed
 *
 * Customers/locations/contacts/users/projects arrive inside the
 * `fetching_jobs` stage (one paged pass), so they have no state of their own —
 * they report via `fetched` instead.
 *
 * Per-state sub-events:
 *   fetched      {entity, count}   raw-table stage finished
 *   entity_done  {entity, count}   normalize stage finished
 *
 * The actual sync work is delegated to the CrmProvider via `syncAll`. The
 * provider receives the engine instance and calls back into engine.transition/
 * engine.emit at the right moments. If `engine` is null (cron path), the
 * provider runs silently — same behavior as before.
 */

const { Engine } = require("../core/engine");
const crm = require("../../services/crm");

async function start({ companyId, provider = "servicetrade", full = false, range = "month", startedBy = null }) {
  const engine = await Engine.create({ kind: "crm_sync", companyId, startedBy });
  // Don't await — run in background so HTTP can return the runId immediately.
  run(engine, { provider, full, range }).catch(() => { /* errors already captured by engine.fail */ });
  return engine;
}

async function run(engine, { provider, full, range }) {
  await engine.wrap(async (eng) => {
    const p = crm.getProvider(provider);
    if (!p) throw new Error(`Unknown CRM provider: ${provider}`);
    await eng.transition("authenticating", { provider });
    const result = await p.syncAll(eng.companyId, { full, range, engine: eng });
    if (!result.ok) throw new Error(result.error || "sync failed");
    return result.counts;
  });
}

module.exports = { start, run };
