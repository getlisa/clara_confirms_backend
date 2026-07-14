-- ServiceTrade entity-type config: maps our platform entity concepts to the
-- numeric ServiceTrade entityType values (from ServiceTrade's entity-types
-- reference) so we can write comments back onto the correct CRM entity.
-- Global (not per-company) — entity types are ServiceTrade-wide.
-- Seeded with only the entities we actually comment on today:
--   Appointment (16)  ← confirmation calls
--   ServiceRequest(18) ← service-opportunity follow-up calls
-- Extend with more rows (e.g. Quote=9) as write-back scope grows.

CREATE TABLE IF NOT EXISTS servicetrade_entity_type_config (
  id                       SERIAL PRIMARY KEY,
  entity_key               VARCHAR NOT NULL UNIQUE,   -- 'appointment', 'service_request'
  servicetrade_entity_type INTEGER NOT NULL,          -- 16, 18
  servicetrade_entity_name VARCHAR NOT NULL,          -- 'Appointment', 'ServiceRequest'
  platform_table           VARCHAR NOT NULL,          -- 'appointments', 'service_opportunities'
  description              TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO servicetrade_entity_type_config
  (entity_key, servicetrade_entity_type, servicetrade_entity_name, platform_table, description)
VALUES
  ('appointment',     16, 'Appointment',    'appointments',          'Confirmation calls comment on the appointment.'),
  ('service_request', 18, 'ServiceRequest', 'service_opportunities', 'Service-opportunity follow-up calls comment on the service request.')
ON CONFLICT (entity_key) DO UPDATE SET
  servicetrade_entity_type = EXCLUDED.servicetrade_entity_type,
  servicetrade_entity_name = EXCLUDED.servicetrade_entity_name,
  platform_table           = EXCLUDED.platform_table,
  description              = EXCLUDED.description,
  updated_at               = now();
