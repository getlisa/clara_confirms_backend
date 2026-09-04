-- Soft slot holds for reschedule/create slot suggestion (Phase 6), plus a
-- database backstop against a genuine technician double-booking.
--
-- Two independent races this migration guards against:
--
-- 1. Two conversations (possibly one chat, one voice call) both reading a
--    technician's open windows at the same moment and both offering the
--    SAME slot to two different customers. A `slot_holds` row is inserted
--    the instant a slot is READ OUT to a customer/agent, before they've
--    agreed to it — not just at confirm time — so the second offer never
--    happens in the first place. TTL-bounded (application-enforced, not a
--    column CHECK) so an abandoned conversation doesn't permanently lock a
--    technician's calendar.
--
-- 2. The hold mechanism itself racing against a second hold for an
--    overlapping window: `slot_holds_no_overlap` is a real GiST exclusion
--    constraint, not an application-level check-then-insert — the database
--    is the only thing that can atomically guarantee two concurrent inserts
--    for the same technician/time can't both succeed.
--
-- A `WHERE (expires_at > now())` predicate on that exclusion constraint would
-- be invalid — now() is not IMMUTABLE, and Postgres rejects a non-immutable
-- function in an index/constraint predicate. So the constraint is
-- unconditional, and the application deletes expired holds first, inside the
-- SAME transaction as the new insert (see db/slot-holds.js) — a hold that
-- expired five minutes ago no longer exists to conflict with by the time the
-- INSERT runs, and two truly-concurrent holds for the same window still can't
-- both commit.
--
-- btree_gist supplies the GiST operator class for `=` on an integer column
-- (technician_id) — the native integer opclass only supports btree, and a
-- multi-column EXCLUDE needs every column's operator class to be GiST-based.
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE slot_holds (
  id             SERIAL PRIMARY KEY,
  company_id     INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  technician_id  INTEGER NOT NULL REFERENCES technicians(id) ON DELETE CASCADE,

  starts_at      TIMESTAMPTZ NOT NULL,
  ends_at        TIMESTAMPTZ NOT NULL,

  -- Whichever conversation/call currently owns this hold — a chat thread
  -- token or a Retell call id, whichever channel offered the slot. Used to
  -- let that SAME conversation re-confirm its own held slot without
  -- colliding with itself, and to release all of a conversation's holds at
  -- once when it ends without confirming any of them.
  held_by_token  VARCHAR NOT NULL,

  -- Set only once a hold is converted into a real appointment (confirm step)
  -- — kept for traceability; the hold row itself is deleted immediately
  -- after, so this rarely outlives the row that carries it in practice.
  appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL,

  expires_at     TIMESTAMPTZ NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT slot_holds_no_overlap EXCLUDE USING gist (
    technician_id WITH =,
    tstzrange(starts_at, ends_at) WITH &&
  )
);

CREATE INDEX slot_holds_expires_at_idx ON slot_holds (expires_at);
CREATE INDEX slot_holds_token_idx      ON slot_holds (company_id, held_by_token);

-- Real double-booking backstop, scoped to source = 'inspectpoint' ONLY.
-- ServiceTrade's appointments are synced from years of live upstream
-- scheduling data that was never constrained this way — an unscoped
-- constraint here would very likely fail to apply (existing overlaps) or,
-- worse, start rejecting a legitimate ServiceTrade sync write the moment one
-- occurred. InspectPoint has zero connected companies as of this migration,
-- so scoping to it is provably safe: there is no existing data for the
-- constraint to conflict with. NULL technician_id rows never participate in
-- a `WITH =` comparison regardless, but the predicate spells that out
-- explicitly rather than relying on that as an implicit reader assumption.
ALTER TABLE appointments ADD CONSTRAINT appointments_inspectpoint_no_overlap
  EXCLUDE USING gist (
    technician_id WITH =,
    tstzrange(scheduled_start, COALESCE(scheduled_end, scheduled_start + interval '2 hours')) WITH &&
  )
  WHERE (source = 'inspectpoint' AND technician_id IS NOT NULL AND status <> 'cancelled');
