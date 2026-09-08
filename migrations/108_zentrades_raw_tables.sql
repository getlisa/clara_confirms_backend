-- ZenTrades raw sync tables — mirrors the shape of
-- 104_inspectpoint_raw_tables.sql (tables named after the PLATFORM
-- destination they feed, slim: promote a column only when it's a soft FK, a
-- filter, or a status; everything else lives in `payload`) with one
-- structural difference: ZenTrades has ONE fat endpoint (a ticket search)
-- whose every "hit" embeds its customer, service address (+ additional
-- contacts), assignments, and each assignment's technician — six entities
-- decomposed from one fetch, not six independent endpoints. See
-- src/services/zentrades-sync.js's header for what that means for
-- `complete`/cursor semantics.
--
-- `updated_at` on every table is OUR write time (drives
-- fetchAllByCompanyChunked's `updatedSince` for the normalize watermark,
-- once that exists). ZenTrades' own `updatedAt` per object goes in
-- `zt_updated_at` instead — reusing the name would silently break
-- incremental normalize the moment our clock and ZenTrades' disagree about
-- what "changed since last time" means, exactly as migration 104 warns for
-- InspectPoint's `ip_updated_at`.
--
-- node-postgres returns BIGINT as a STRING. Every soft-FK lookup against
-- these tables must String() both sides of the comparison — this already
-- caused a real whole-tenant bug on InspectPoint (a Map keyed on the raw
-- JSON number instead of the string the DB returns), nulling
-- locations.primary_contact_id for every single row.

-- ── customers (from ticket.customer) ─────────────────────────────────────────
--
-- billingAddress is deliberately NOT stored in payload, even though the raw
-- API response includes it — product decision is service-address-only, and
-- billingAddress carries its own full address + additionalContacts[], which
-- would roughly double the row and invite a downstream reader to grab the
-- wrong address. The row-mapper in services/zentrades-sync.js must strip it
-- before writing; this comment is the other half of that contract.

CREATE TABLE zentrades_customers (
  id             BIGSERIAL PRIMARY KEY,
  company_id     BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  zentrades_id   BIGINT NOT NULL,
  is_active      BOOLEAN NOT NULL DEFAULT true,   -- payload.isActive !== false && payload.isDeleted !== true
  payload        JSONB   NOT NULL DEFAULT '{}'::jsonb,  -- billingAddress stripped — see header
  zt_updated_at  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, zentrades_id)
);
CREATE INDEX zentrades_customers_company_idx ON zentrades_customers (company_id, is_active);

-- ── locations (from ticket.serviceAddress) ───────────────────────────────────

CREATE TABLE zentrades_locations (
  id                     BIGSERIAL PRIMARY KEY,
  company_id             BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  zentrades_id           BIGINT NOT NULL,
  zentrades_customer_id  BIGINT,   -- soft link -> zentrades_customers.zentrades_id (serviceAddress.customerId)
  -- Highest-consequence promotion in this migration: a hard gate on
  -- outreach, not just informational. Burying this in JSONB is how we
  -- eventually call someone who explicitly opted out of service.
  do_not_serve           BOOLEAN NOT NULL DEFAULT false,
  is_active              BOOLEAN NOT NULL DEFAULT true,
  payload                JSONB   NOT NULL DEFAULT '{}'::jsonb,
  zt_updated_at          TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, zentrades_id)
);
CREATE INDEX zentrades_locations_company_idx  ON zentrades_locations (company_id);
CREATE INDEX zentrades_locations_customer_idx ON zentrades_locations (company_id, zentrades_customer_id);
CREATE INDEX zentrades_locations_dns_idx      ON zentrades_locations (company_id, do_not_serve);

-- ── technicians (from assignment.technician) ─────────────────────────────────

CREATE TABLE zentrades_technicians (
  id             BIGSERIAL PRIMARY KEY,
  company_id     BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  zentrades_id   BIGINT NOT NULL,
  is_active      BOOLEAN NOT NULL DEFAULT true,
  payload        JSONB   NOT NULL DEFAULT '{}'::jsonb,  -- phone fields are OPTIONAL — do not assume presence
  zt_updated_at  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, zentrades_id)
);
CREATE INDEX zentrades_technicians_company_idx ON zentrades_technicians (company_id, is_active);

-- ── contacts (synthesized — NOT a real ZenTrades entity) ─────────────────────
--
-- ZenTrades has no single "contact" concept. A person shows up as: the
-- ticket's `customer` person fields, the `serviceAddress`'s OWN person
-- fields, or an entry in `serviceAddress.additionalContacts[]` — three
-- different id spaces (customer.id, serviceAddress.id, additionalContact.id)
-- that can collide as plain integers. zentrades_id is therefore TEXT here,
-- namespaced: 'cust:<customerId>' | 'addr:<serviceAddressId>' | 'ac:<additionalContactId>'.
--
-- Dedup-by-lowercased-email across these three kinds happens at NORMALIZE
-- time, not here — see services/crm/inspectpoint/provider.js's
-- buildPrimaryContactByBuilding for the precedent (a normalize-phase
-- heuristic specifically so it re-runs without a re-fetch). All three
-- source rows are stored verbatim; email_lower is promoted+indexed to make
-- that later dedup cheap. Contacts with no email have no dedupe key and
-- must still survive as distinct rows.

CREATE TABLE zentrades_contacts (
  id                     BIGSERIAL PRIMARY KEY,
  company_id             BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  zentrades_id           TEXT NOT NULL,   -- namespaced synthetic key — see header
  contact_kind           TEXT NOT NULL,   -- 'customer' | 'service_address' | 'additional' (redundant with the id prefix on purpose — a string prefix isn't usefully indexable)
  zentrades_customer_id  BIGINT,          -- soft link -> zentrades_customers.zentrades_id
  zentrades_location_id  BIGINT,          -- soft link -> zentrades_locations.zentrades_id (NULL for 'customer' kind)
  email_lower            TEXT,            -- lowercased+trimmed dedupe key; NULL when no email
  is_active              BOOLEAN NOT NULL DEFAULT true,
  payload                JSONB   NOT NULL DEFAULT '{}'::jsonb,  -- a PROJECTED person object, not the whole parent — see mapper
  zt_updated_at          TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, zentrades_id),
  CHECK (contact_kind IN ('customer', 'service_address', 'additional'))
);
CREATE INDEX zentrades_contacts_company_idx  ON zentrades_contacts (company_id);
CREATE INDEX zentrades_contacts_customer_idx ON zentrades_contacts (company_id, zentrades_customer_id);
CREATE INDEX zentrades_contacts_location_idx ON zentrades_contacts (company_id, zentrades_location_id);
CREATE INDEX zentrades_contacts_email_idx    ON zentrades_contacts (company_id, email_lower);

-- ── tickets (from ticket; -> platform jobs) ──────────────────────────────────

CREATE TABLE zentrades_tickets (
  id                       BIGSERIAL PRIMARY KEY,
  company_id               BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  zentrades_id             BIGINT NOT NULL,
  zentrades_customer_id    BIGINT,   -- soft link -> zentrades_customers.zentrades_id
  zentrades_location_id    BIGINT,   -- soft link -> zentrades_locations.zentrades_id
  -- Both id and label promoted, deliberately: only "1 = Open" is documented,
  -- so `SELECT DISTINCT job_status_id, job_status` is how the full map gets
  -- resolved from production data. See services/zentrades-sync.js.
  job_status_id            INTEGER,
  job_status               TEXT,
  -- The list filter (gteDate/ltDate) is an OVERLAP test against these two
  -- columns together (end >= X AND start < Y) — both are needed, neither
  -- alone reproduces the filter's own semantics for the local absence check.
  scheduled_start          TIMESTAMPTZ,
  scheduled_end            TIMESTAMPTZ,
  ticket_number            TEXT,     -- the human-facing job number ("009670") the agent says out loud
  -- Drives the conditional recurrence fan-out — presence (non-empty string)
  -- means recurring, per product decision. Kept as the raw string, not a
  -- boolean, so a second flag value would be visible in this column.
  combined_feature_flag    TEXT,
  is_active                BOOLEAN NOT NULL DEFAULT true,
  payload                  JSONB   NOT NULL DEFAULT '{}'::jsonb,
  zt_updated_at            TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, zentrades_id)
);
CREATE INDEX zentrades_tickets_company_idx    ON zentrades_tickets (company_id, job_status_id);
CREATE INDEX zentrades_tickets_location_idx   ON zentrades_tickets (company_id, zentrades_location_id);
CREATE INDEX zentrades_tickets_customer_idx   ON zentrades_tickets (company_id, zentrades_customer_id);
CREATE INDEX zentrades_tickets_scheduled_idx  ON zentrades_tickets (company_id, scheduled_start);
CREATE INDEX zentrades_tickets_window_idx     ON zentrades_tickets (company_id, scheduled_end, scheduled_start);
CREATE INDEX zentrades_tickets_recurring_idx  ON zentrades_tickets (company_id) WHERE combined_feature_flag IS NOT NULL;

-- ── appointments (from ticket.assignments[], 1:1) ────────────────────────────
--
-- Confirmed product decision: one assignment = one appointment, always —
-- even two assignments sharing an identical time window are two different
-- technicians independently dispatched to the same visit, not one visit
-- with two people. scheduled_start/scheduled_end come from the ASSIGNMENT,
-- never the parent ticket — the dispatch record is what the customer is
-- actually being asked to confirm.

CREATE TABLE zentrades_appointments (
  id                          BIGSERIAL PRIMARY KEY,
  company_id                  BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  zentrades_id                BIGINT NOT NULL,
  zentrades_ticket_id         BIGINT,   -- soft link -> zentrades_tickets.zentrades_id
  zentrades_technician_id     BIGINT,   -- soft link -> zentrades_technicians.zentrades_id
  assignment_status_id        INTEGER,
  assignment_status           TEXT,
  -- assignmentStatusCFId/statusCF ("Open: return trip needed") is a
  -- materially different operational sub-state from plain "Open" and is
  -- almost certainly the tenant-configurable field — both id and label
  -- promoted for the same discovery reason as job_status above.
  assignment_status_cf_id     INTEGER,
  assignment_status_cf        TEXT,
  scheduled_start             TIMESTAMPTZ,
  scheduled_end                TIMESTAMPTZ,
  -- Per-ASSIGNMENT series key (two assignments on the same ticket carry
  -- DIFFERENT recurringAssignmentId values in the documented sample) — the
  -- only stable "same weekly visit by the same tech" identity across
  -- occurrences. Not per-ticket.
  recurring_assignment_id     BIGINT,
  is_active                   BOOLEAN NOT NULL DEFAULT true,
  payload                     JSONB   NOT NULL DEFAULT '{}'::jsonb,
  zt_updated_at               TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, zentrades_id)
);
CREATE INDEX zentrades_appointments_ticket_idx     ON zentrades_appointments (company_id, zentrades_ticket_id);
CREATE INDEX zentrades_appointments_technician_idx ON zentrades_appointments (company_id, zentrades_technician_id);
CREATE INDEX zentrades_appointments_scheduled_idx  ON zentrades_appointments (company_id, scheduled_start);
CREATE INDEX zentrades_appointments_recurring_idx  ON zentrades_appointments (company_id, recurring_assignment_id);

-- ── recurrences (from GET /api/ticket?id= -> rruleDetails) ───────────────────
--
-- The ONLY table whose conflict key is NOT zentrades_id — it's
-- zentrades_ticket_id, because this is a conditional per-ticket fan-out
-- (only fetched for tickets carrying combined_feature_flag), and re-fetching
-- must replace, not accumulate, whatever we had for that ticket before.
-- zentrades_id (rruleDetails.id) is still stored and indexed, just not
-- unique.

CREATE TABLE zentrades_recurrences (
  id                      BIGSERIAL PRIMARY KEY,
  company_id              BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  zentrades_id            BIGINT,
  zentrades_ticket_id     BIGINT NOT NULL,   -- soft link -> zentrades_tickets.zentrades_id — THE conflict key
  rrule                   TEXT,              -- the iCal RRULE string
  rrule_string            TEXT,              -- "every day for 14 times" — verbatim into what the agent says
  nth_event               INTEGER,           -- "visit 8 of 14"
  module_id               INTEGER,
  -- OURS, not ZenTrades' — the ticket's own updatedAt AT THE MOMENT we
  -- fetched this recurrence. This is the fan-out skip key in
  -- services/zentrades-sync.js: if a ticket's current updatedAt still
  -- matches this column, its recurrence detail hasn't changed and the
  -- expensive per-ticket fetch is skipped. Named distinctly from
  -- zt_updated_at (rruleDetails' OWN updatedAt) so the two are never
  -- confused.
  zt_ticket_updated_at    TIMESTAMPTZ,
  is_active               BOOLEAN NOT NULL DEFAULT true,
  payload                 JSONB   NOT NULL DEFAULT '{}'::jsonb,
  zt_updated_at           TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, zentrades_ticket_id)
);
CREATE INDEX zentrades_recurrences_rrule_id_idx ON zentrades_recurrences (company_id, zentrades_id);

-- ── sync state ────────────────────────────────────────────────────────────────
--
-- Per migration 104's naming discipline: `_updated_at` = a real incremental
-- cursor is applied to the request; `_synced_at` = informational only, no
-- time filter exists on that fetch. Whether ZenTrades' list filter accepts
-- an `updatedAt` term at all is UNRESOLVED (see services/zentrades-sync.js's
-- header) — so only `_synced_at` columns ship here. Shipping a `_updated_at`
-- column that filters nothing would be exactly the lie that naming
-- discipline exists to prevent. If/when a real cursor is confirmed, it gets
-- its own follow-up migration adding a `last_tickets_updated_at` column,
-- not a rename of one of these.
--
-- Six per-entity `_synced_at` stamps below are all written from ONE fetch
-- outcome (ZenTrades has one ticket-search endpoint, not six independent
-- ones) — they cannot disagree, and exist only so this table's shape
-- matches inspectpoint_sync_state's for tooling/dashboards that read across
-- providers generically. last_recurrences_synced_at is the one genuinely
-- independent signal, since the recurrence fan-out is its own fetch that
-- can fail while the main ticket walk succeeds, or vice versa.

CREATE TABLE zentrades_sync_state (
  company_id                    BIGINT NOT NULL PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  last_sync_at                  TIMESTAMPTZ,
  last_full_sync_at             TIMESTAMPTZ,
  last_sync_status              TEXT,
  last_sync_error               TEXT,
  last_tickets_synced_at        TIMESTAMPTZ,
  last_customers_synced_at      TIMESTAMPTZ,
  last_locations_synced_at      TIMESTAMPTZ,
  last_contacts_synced_at       TIMESTAMPTZ,
  last_technicians_synced_at    TIMESTAMPTZ,
  last_appointments_synced_at   TIMESTAMPTZ,
  last_recurrences_synced_at    TIMESTAMPTZ,   -- the one genuinely independent fetch — see header
  last_pagination_mode          TEXT,          -- observability only: which sort/pagination strategy the last run used
  last_normalized_at            TIMESTAMPTZ    -- normalize-phase watermark, not yet used (Phase B)
);
