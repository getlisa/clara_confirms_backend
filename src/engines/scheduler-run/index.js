/**
 * SchedulerRunEngine — wraps `runDailyJob` and emits per-trigger workflow
 * events so the UI can show a live feed of what got scheduled / skipped.
 *
 * State machine:
 *   started → loading_triggers → running_trigger (many) → done | failed
 *
 * Sub-events:
 *   trigger_done   {trigger_type, company_id, scheduled, skipped}
 *   trigger_error  {trigger_type, company_id, error}
 */

const { Engine } = require("../core/engine");
const scheduler = require("../../services/scheduler");

async function start({ companyId, respectAutoFlag = false, startedBy = null }) {
  const engine = await Engine.create({ kind: "scheduler_run", companyId, startedBy });
  run(engine, { companyId, respectAutoFlag }).catch(() => {});
  return engine;
}

async function run(engine, { companyId, respectAutoFlag }) {
  await engine.wrap(async (eng) => {
    await eng.transition("loading_triggers", { company_id: companyId });
    const result = await scheduler.runDailyJob({
      companyId,
      respectAutoFlag,
      engine: eng,
    });
    return { totals: result };
  });
}

module.exports = { start, run };
