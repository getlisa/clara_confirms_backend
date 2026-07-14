/**
 * ServiceTrade entity-type config accessor.
 *
 * Maps our platform entity concepts (entity_key) to ServiceTrade's numeric
 * entityType values, used when writing comments back onto CRM entities.
 * The table is global (ServiceTrade-wide) and tiny, so results are cached
 * in-memory for the process lifetime.
 *
 * See migrations/060_servicetrade_entity_type_config.sql.
 */

const db = require("./index");

// The entities we currently write comments to. Values from ServiceTrade's
// entity-types reference. Keep in sync with migration 060's seed.
const RELEVANT_ENTITY_TYPES = [
  { entityKey: "appointment",     servicetradeEntityType: 16, servicetradeEntityName: "Appointment",    platformTable: "appointments",          description: "Confirmation calls comment on the appointment." },
  { entityKey: "service_request", servicetradeEntityType: 18, servicetradeEntityName: "ServiceRequest", platformTable: "service_opportunities", description: "Service-opportunity follow-up calls comment on the service request." },
];

let _cache = null;

/**
 * Upsert the relevant entity-type rows. Idempotent; safe to call at startup.
 */
async function seedAll() {
  for (const e of RELEVANT_ENTITY_TYPES) {
    await db.query(
      `INSERT INTO servicetrade_entity_type_config
         (entity_key, servicetrade_entity_type, servicetrade_entity_name, platform_table, description)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (entity_key) DO UPDATE SET
         servicetrade_entity_type = EXCLUDED.servicetrade_entity_type,
         servicetrade_entity_name = EXCLUDED.servicetrade_entity_name,
         platform_table           = EXCLUDED.platform_table,
         description              = EXCLUDED.description,
         updated_at               = now()`,
      [e.entityKey, e.servicetradeEntityType, e.servicetradeEntityName, e.platformTable, e.description]
    );
  }
  _cache = null; // invalidate
}

/**
 * Return the full config as a { entity_key -> row } map (cached).
 */
async function getMap() {
  if (_cache) return _cache;
  const { rows } = await db.query(
    `SELECT entity_key, servicetrade_entity_type, servicetrade_entity_name, platform_table
     FROM servicetrade_entity_type_config`
  );
  const map = {};
  for (const r of rows) map[r.entity_key] = r;
  _cache = map;
  return map;
}

/**
 * Look up a single entity-type row by key (e.g. 'appointment').
 * @returns {Promise<{entity_key,servicetrade_entity_type,servicetrade_entity_name,platform_table}|null>}
 */
async function getByKey(entityKey) {
  const map = await getMap();
  return map[entityKey] || null;
}

module.exports = { RELEVANT_ENTITY_TYPES, seedAll, getMap, getByKey };
