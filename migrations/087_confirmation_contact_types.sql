-- Company-wide default confirmation recipients, chosen by contact type.
--
-- Until now a confirmation went to the customer RECORD (customers.phone /
-- customers.email) plus any contacts a manager had hand-picked into
-- customers.confirmation_contact_ids (migration 081). Curating that per
-- customer doesn't scale, and the customer record's number is often a main
-- switchboard rather than the person who actually grants site access.
--
-- ServiceTrade contacts carry free-text `types` ("on-site", "management",
-- "scheduling", "property manager", ...) which are already synced into
-- contacts.types (jsonb array). This setting lets a company pick the types
-- once; confirmations then go to the contacts carrying them.
--
-- TEXT[] rather than JSONB deliberately: db/call-settings.js's upsert() builds
-- its parameters generically with no JSON.stringify step, so a jsonb column
-- would need a special case there, whereas node-postgres serialises a JS
-- string array straight into text[]. It also matches the nearest list-valued
-- precedent, customers.confirmation_contact_ids INTEGER[] (migration 081).
--
-- Values are stored normalised (lower-cased, trimmed) by the route, so
-- matching against lower(btrim(type)) is exact. Empty '{}' means "off" — the
-- default, so no company's behaviour changes until it opts in.

ALTER TABLE call_settings
  ADD COLUMN IF NOT EXISTS confirmation_contact_types TEXT[] NOT NULL DEFAULT '{}';

-- A broad type selection can match far more contacts than anyone wants to
-- call — one company-9 customer has 59 matching contacts, and the scheduler
-- enqueues one call/chat-link PER recipient. The resolver caps the fan-out and
-- records the contacts it dropped as a todo, so truncation is auditable rather
-- than silent. todos.type is CHECK-constrained, so the new value has to be
-- admitted here first (drop + re-add, same pattern as migration 069).
ALTER TABLE todos DROP CONSTRAINT IF EXISTS todos_type_check;
ALTER TABLE todos ADD CONSTRAINT todos_type_check CHECK (type IN (
  'NOT_PICKED', 'VOICEMAIL', 'ASKED_FOR_RESCHEDULE', 'ASKED_FOR_CANCELLATION',
  'UNCONFIRMED', 'APPOINTMENT_NEEDED', 'MISSING_PHONE', 'SERVICE_OPPORTUNITY',
  'SERVICE_LINK', 'CRM_SYNC', 'APPOINTMENT_CANCELLED', 'MISSING_EMAIL',
  'RECIPIENTS_TRUNCATED'
));
