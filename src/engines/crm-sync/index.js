/**
 * CrmSyncEngine — orchestrates a full CRM sync (raw + normalize) and emits
 * progress as workflow-engine events.
 *
 * State machine:
 *   started → authenticating → fetching_customers → fetching_jobs
 *           → fetching_appointments → fetching_technicians
 *           → normalizing → done | failed
 *
 * Per-state sub-events:
 *   progress     {entity, fetched}
 *   entity_done  {entity, count}
 *   warning      {code, entity, subject_name, message}
 *
 * The actual sync work is delegated to the CrmProvider via `syncAll`. The
 * provider receives the engine instance and calls back into engine.transition/
 * engine.emit at the right moments. If `engine` is null (cron path), the
 * provider runs silently — same behavior as before.
 */

const { Engine } = require("../core/engine");
const crm = require("../../services/crm");

async function start({ companyId, provider = "servicetrade", full = false, startedBy = null }) {
  const engine = await Engine.create({ kind: "crm_sync", companyId, startedBy });
  // Don't await — run in background so HTTP can return the runId immediately.
  run(engine, { provider, full }).catch(() => { /* errors already captured by engine.fail */ });
  return engine;
}

async function run(engine, { provider, full }) {
  await engine.wrap(async (eng) => {
    const p = crm.getProvider(provider);
    if (!p) throw new Error(`Unknown CRM provider: ${provider}`);
    await eng.transition("authenticating", { provider });
    const result = await p.syncAll(eng.companyId, { full, engine: eng });
    if (!result.ok) throw new Error(result.error || "sync failed");
    return result.counts;
  });
}

module.exports = { start, run };
