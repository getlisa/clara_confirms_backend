/**
 * Engine registry — maps `kind` strings to engine modules. Each engine module
 * exposes `start(opts) → Promise<Engine>`. Adding a new engine = add the file
 * under src/engines/<kind>/ and register here.
 */

const crmSync = require("./crm-sync");
const schedulerRun = require("./scheduler-run");

const registry = {
  crm_sync:       crmSync,
  scheduler_run:  schedulerRun,
};

function getEngine(kind) {
  return registry[kind] || null;
}

function listKinds() {
  return Object.keys(registry);
}

module.exports = { getEngine, listKinds };
