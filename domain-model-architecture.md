# Domain Model & Lifecycle Architecture

> **Status:** Proposal for ratification. Nothing here is migrated yet.
> **Current focus:** **Process 2 — Delivery** (Jobs → Appointments) on the data we already have. The
> **Service Opportunity process (Process 1)** — Service Requests, Recurrences, Deficiencies, and
> inspections/routing — is **documented here but deferred** (§5, §6, §9; see roadmap §11).
> **Purpose:** Define the core domain precisely — what a Service Request, Job, Appointment, and
> Recurring Service *are*, which one owns time, how residential vs commercial differ — and how a
> **configurable Campaign system** lets Clara own the full lifecycle of work, not just place calls.
>
> This is the foundation the inspections / route-planning flow and CRM integration sit on top of.
> Read it before writing any migration. Model shape is deliberately aligned with **ServiceTrade**
> (the sync source) so CRM integration is a near-direct field map.

---

# 0 — Why this doc exists

Today the system handles **jobs and appointments only**, and the two are hard to tell apart because
**both own a scheduled time**. In [`migrations/026`](migrations/026_core_domain_tables.sql):

- `jobs` has `scheduled_date`, `scheduled_window_start/end`
- `appointments` has `scheduled_start/end`

When two tables both answer *"when is this happening?"*, every "when do we call?" decision in
[`scheduler.js`](src/services/scheduler.js) has to guess which is authoritative. That guess is the
fragility we keep hitting. Adding **recurring services** on top multiplies it.

This doc fixes the model first, then layers a configurable lifecycle/campaign system on top.

---

# 1 — Design principles (the invariants)

1. **Only the Appointment owns concrete ("hard") time.** A Job never stores a canonical scheduled
   time; its schedule is *derived* from its appointments. This single rule dissolves the job/appointment
   ambiguity. Confirmed as the consensus of ServiceTitan, Jobber, ServiceTrade, Salesforce FS.
2. **Hard time vs soft time are different.** A *due / target window* ("must be done by") is **soft
   time** — a planning target. Soft time lives on the Job's `due_by` (and, when Process 1 lands, also on
   Service Requests). **Hard
   time** (a committed slot + assigned technician) lives *only* on Appointments.
3. **The Service Request is the central unit of opportunity.** All work originates as a Service Request
   (from an end-user request, a recurrence, or a deficiency), which is grouped into a Job and scheduled
   via Appointments. See §5.
4. **Location is a first-class entity** (with geo), not an address on the customer. Required for
   commercial multi-site and for the later routing flow.
5. **A Recurring Service is a template, never an appointment.** It *generates* Service Requests on a
   cadence. Definition ≠ instance.
6. **Everything that could be a business decision is per-company configuration**, with sane defaults —
   campaigns, channels, automated-vs-manual handling, and agent selection are all user-configurable.
7. **Multi-tenant always.** Every table scoped by `company_id`.
8. **Two separate lifecycles, one boundary.** *Service Opportunity* (the Service Request process) and *Delivery*
   (the Job → Appointment process) are modeled and run as **distinct processes** — each with its own
   state machine, campaigns, and agents — joined by a single **conversion boundary** (`SR → Job`).
   Keeping them decoupled is what stops opportunity logic and delivery logic from contaminating each other.
   See §9.

---

# 2 — The entity model

```
Account (Customer)                         ← type = residential | commercial
  ├─ Contact (M:N, role: billing / scheduling / on-site / approver)
  └─ Location / Site (1:N)                 ← FIRST-CLASS, carries geo (lat/lon). commercial = many
        ├─ Asset / Equipment (1:N)         ← the specific unit serviced (nullable on an SR)
        └─ Contact (M:N, site-level roles)

  Origins of opportunity ────────┐
    end-user request             │
    Service Recurrence (template)├──▶  Service Request   ← ★ THE unit of opportunity
    Deficiency (found on a visit)┘         │  grouped / converted into
                                           ▼
                                     Job / Work Order    ← container; groups SRs; type; isProject
                                           │  scheduled via
                                           ▼
                                     Appointment(s)      ← ★ committed hard time + technician

Sales-to-cash:  Quote ─(accept)→ Job ─(complete appointments)→ Invoice ─→ Payment
```

## Entity definitions

| Entity | Answers | Owns (time) | Notes |
|---|---|---|---|
| **Account** (`customers` today) | who we bill/relate to | — | `account_type: residential\|commercial` (§4) |
| **Location / Site** | where work happens | — | First-class, **geo lat/lon**. Commercial: many. |
| **Asset / Equipment** | which unit is serviced | — | Hangs off Location. Nullable on an SR. |
| **Contact** | who we talk to | — | M:N with Account & Location, with a **role**. |
| **Service Request** | *what is requested, on what, where, by when* | **soft** target window | ★ central opportunity unit (§5) |
| **Service Line** | trade / discipline | — | taxonomy ref (e.g. Fire Protection → Sprinkler) |
| **Service Recurrence** | what recurs, how often | recurrence rule | template; spawns SRs (§6) |
| **Deficiency** | problem found on site | — | origin of follow-up SRs |
| **Job / Work Order** | container + status | **soft** `due_by` (+ derived earliest appt) | `due_by` drives booking; groups appointments; `type` |
| **Appointment / Visit** | when + who goes | **★ hard** `scheduled_start/end` + tech | the only source of truth for concrete time |

> Grounded in the ServiceTrade `servicerequest` payload: an SR references `serviceLine` (trade),
> `asset` (equipment, nullable), `location` (with `lat`/`lon`), `job`, `serviceRecurrence`,
> `deficiency`, and carries `windowStart/End`, `duration`, `preferredStartTime`, `preferredTechs`.

---

# 3 — Timing semantics (the crux)

One timeline; each entity owns exactly one kind of time:

```
recurrence rule  →  next due  →  Service Request (soft target window)  →  Appointment (HARD slot)
   (template)                        + duration + preferred window            (the ONE clock)
```

| Entity | Time it owns | Kind |
|---|---|---|
| Service Recurrence | `frequency` + `interval` (e.g. monthly ×3) | rule |
| Service Request | target `window_start/end` + `duration` + `preferred_start_time` | **soft** |
| Job | explicit `due_by` deadline (+ derived earliest appointment) | **soft** |
| Appointment | `scheduled_start` / `scheduled_end` + technician | **hard** |

**Why this kills the fragility:** "when do we act?" is now uniform — *(entity, state, its own clock)* —
never a guess between two hard-time fields. A Job's convenience "next scheduled time" is a **derived**
read of its earliest appointment, never an independent source of truth.

**`due_by` — the booking deadline.** The Job's `due_by` is the date by which an appointment must be
booked (or the work completed). It drives the **Appointment-needed** campaign (§7): the agent reaches
out *before* `due_by` when a job still has no appointment. It is **soft** time — a target, never a
committed slot. (When Process 1 lands, `due_by` can be derived from a job's Service-Request windows;
until then it is set directly / synced from the CRM.)

---

# 4 — Residential vs Commercial

Not a cosmetic flag — it changes structural shape and drives campaign audience.

| | Residential | Commercial |
|---|---|---|
| Account ↔ Location | ~1:1 | 1:many |
| Assets | rare | central (inspections/PM) |
| Recurring services | annual tune-up | heavy (contracts, inspections) |
| Confirm with | homeowner | on-site / scheduling contact ≠ billing |
| Geography/routing | low | high (→ inspections flow) |

## Classifying `account_type`

Explicit enum on the Account, never inferred at query time. 3-tier priority, tracked via
`account_type_source ∈ {synced, inferred, manual}`:

1. **Synced (primary):** map the CRM/ServiceTrade account type during sync.
2. **Inferred (fallback, low-confidence):** when the source is silent, *suggest* a type and set
   `needs_review = true`. Signals: >1 Location · has Assets · has a contract/recurrence · business (vs
   person) name · corporate email · PO/net-terms billing.
3. **Manual (always wins):** ops sets/corrects in UI; locked against re-sync.

Inferred classifications go to a human for bulk confirmation via the existing
[`copilot_pending_actions`](migrations/052_copilot.sql) human-in-the-loop pattern.

---

# 5 — Service Requests (the central unit)

**Definition:** A Service Request is a unit of *requested work* — what service (`service_line`/trade),
on what `asset` (optional), at which `location`, due within a target window. It has **its own lifecycle
status**, is **grouped into a Job**, and is fulfilled by the Job's **Appointments**.

Key facts:

- **Origins:** end-user request · Service Recurrence occurrence · Deficiency follow-up. All three
  converge into a Service Request — one unified opportunity funnel.
- **`SR → Job`** is many-to-one (`job_id` nullable until converted; null = open, unscheduled opportunity).
- **`Appointment ↔ SR`** is many-to-many (a visit fulfils several SRs; an SR may span visits).
- **Service Line ≠ Asset.** `service_line` = trade/discipline taxonomy (Fire Protection → Sprinkler);
  `asset` = the specific equipment. An SR references both.
- Carries **soft time**: `window_start/end`, `duration`, `preferred_start_time`, `preferred_techs`.

```
Service Recurrence ─┐
Deficiency ─────────┼─▶ Service Request (open) ──group──▶ Job ──schedule──▶ Appointment(s)
End-user request ───┘        due_by, service_line,           type            hard time + tech
                             asset?, location(geo)
```

Lifecycle (**Service Opportunity** process — §9): `new → open → qualified → converted | deferred | closed_lost`.
The SR lifecycle **ends at conversion** — it does not schedule. After `converted`, the **Delivery**
process (§9) owns scheduling/completion through the linked Job. Open SRs = the queryable backlog of
unbooked opportunity (this is what earlier discussion called "service opportunities" — they are simply
Service Requests in `open` status).

---

# 6 — Recurring Services

**A recurring service is a template that generates Service Requests.** It is *not* an appointment.

```
Service Recurrence   ← frequency + interval (weekly … 2/3-month … yearly … custom), scoped to Location/Asset
        │  generates on a horizon (or ingested from CRM)
        ▼
Service Request (open)   ← a materialized "due occurrence"
        │  grouped + scheduled
        ▼
Job + Appointment(s)     ← real instances with hard time
```

- Recurrence attaches to the SR it produces (mirrors ServiceTrade's `serviceRecurrence` on the SR).
- **Since due-dates are synced from the CRM**, the generator is *ingest-driven* (materialize SRs from
  synced occurrences) rather than us computing recurrence math. CRM integration is a **later** work
  item (§11).
- The inspections / route-planning flow is simply the **recurring-maintenance campaign** operating over
  commercial open SRs, plus a geography/routing/review layer (deferred, §11).

---

# 7 — The Campaign system (config-driven lifecycle)

Generalizes today's `call_trigger_configs` (a boolean per fixed trigger) into a flexible engine. **Clara
owns the lifecycle** — read live context → resolve the action → write it back → chain the next campaign —
which is how the category leaders (Avoca, Sameday, Numa) differentiate from a dumb dialer.

## What a Campaign is

| Field | Meaning |
|---|---|
| `trigger` | *(entity + state + timing-relative-to-its-own-clock)* + config knobs (e.g. due-soon days) |
| `audience` | filters: `account_type`, `job_type`, `service_line`, location, … |
| `goal` | confirm / book / follow-up-estimate / collect-review / … |
| **`mode`** | **`automated` · `manual` · `off`** — the user's handling decision |
| `channels` | ordered sequence + cadence + retries: voice → SMS → email |
| `agent_profile_id` | which Agent Profile runs it (defaulted by campaign type; overridable) |

## Execution mode — the user's direct control

| Mode | What happens | Reuses |
|---|---|---|
| `automated` | outbound agent handles it end-to-end, resolves + writes back | Retell + [`scheduler.js`](src/services/scheduler.js) |
| `manual` | drops into a human work-queue instead of dispatching an agent | existing [`todos`](src/db/todos.js) |
| `off` | nothing runs | — |

The `manual` path is nearly free — it generates a **todo** instead of an agent action (same pattern as
today's `MISSING_PHONE` todo). So *"estimate follow-up: manual, review: automated"* is a per-company
toggle, not a code change.

## The context bundle (owner, not dialer)

A campaign hands the agent *(which entity, its state, the goal, the write-back targets)* — not just a
phone number. This is what lets the agent resolve (confirm / reschedule / book) and write back. Today's
Retell dynamic-variables in [`scheduler.js`](src/services/scheduler.js) are the seed; the campaign
formalizes it.

## Campaign taxonomy (extensible)

Dropped: ~~speed-to-lead~~, ~~membership renewal~~. **Service Opportunity-process campaigns are
deferred (§11); Delivery campaigns are the current focus.** How each maps to today:

Each campaign belongs to **exactly one process** (§9) — Service Opportunity or Delivery.

| Campaign | Process | Trigger | Today |
|---|---|---|---|
| Appointment needed (booking) | **Delivery** | job has no appointment + `due_by` approaching | ✅ `processOpenJobDueSoon` |
| Appointment confirm / remind (customer) | **Delivery** | visit scheduled, pre-appointment window | ✅ `processScheduledUnconfirmed` |
| Technician confirm | **Delivery** | visit needs tech confirm | ✅ `processTechnicianUnconfirmed` |
| Post-job review ("happy call") | **Delivery** | visit completed | ❌ new |
| Unsold estimate follow-up | Service Opportunity *(existing trigger)* | quote aging | ✅ `processQuotationPending` |
| SR conversion · recurring maintenance · deficiency | Service Opportunity *(deferred)* | — | ⏸ Process 1 |

**Two senses of "booking":** placing an appointment on an *existing* Job (the **Appointment-needed**
campaign above — pure Delivery, driven by `due_by`) is distinct from converting an open Service Request
into a Job (the deferred **SR conversion** campaign, which crosses the Process 1 → Process 2 boundary).

> **Extensibility:** new campaign types are added as trigger-evaluator + config, not as new hardcoded
> pipeline branches. A future campaign slots in without touching the dispatch layer.

## What changes vs today

| Today | With campaigns |
|---|---|
| `call_trigger_configs`: boolean per fixed trigger | `campaigns`: rich config, many per trigger type |
| `enabled` bool | `mode`: automated / manual / off |
| 4 hardcoded `process*` functions | campaign-driven trigger evaluation (config knobs + audience) |
| voice-only | multi-channel sequence (voice/SMS/email) |
| one global agent config | Agent Profile per campaign (multi-agent) |
| ad-hoc Retell dynamic vars | formal context bundle |

## What does NOT change (below the campaign layer)

The dispatch machinery in [`scheduling-architecture.md`](scheduling-architecture.md) is untouched —
campaigns dispatch *through* it: per-tenant concurrency + system cap + priority ladder (`claimPending`),
office-hours enforcement, same-phone dedup, retries/callbacks, `call_settings`, Retell voice.

## Migration safety

The four current triggers seed as four default campaigns (`mode=automated`, `channels=[voice]`, default
agent profile, `enabled` mapped from today's flag). Existing behavior preserved on day one; new
capabilities are additive.

---

# 8 — Agent Profiles

**Campaign type selects which agent handles the interaction** — the multi-agent system. Agent Profiles
are a **referenced library**, not surfaced in the main UI (users configure *campaigns*; the agent is
defaulted by campaign type, overridable as an advanced setting).

An **Agent Profile** = persona + capability bundle: system prompt / goal · allowed tools (confirm,
reschedule, book, capture-reason, write-back) · Retell flow · voice.

Relationship: **many campaigns → one Agent Profile** (a reference, not a copy). The same "confirmation
agent" serves both day-before-confirm and reminder campaigns — they differ in cadence/goal, not persona.

```
Campaign ─ selects (by type, default) ─▶ Agent Profile
   │                                          │
 goal + audience + cadence + context     persona + tools + flow
```

---

# 9 — The two lifecycles (the heart of the model)

Work runs as **two distinct processes**, each with its own state machine, campaigns, and agents, joined
by a single **conversion boundary**. Keeping them separate is what stops opportunity logic and delivery logic
from contaminating each other — the root cause of today's fragility. Explicit status machines replace
the scattered status-sync logic in the [`jobs` route handler](src/routes/jobs.js).

```
┌──────────────────────────────┐      conversion       ┌───────────────────────────────┐
│PROCESS 1 — SERVICE OPPORTUNITY│      boundary         │  PROCESS 2 — DELIVERY          │
│  (Service Request lifecycle)  │   ── SR → Job ──▶     │  (Job → Appointment lifecycle) │
│                               │                       │                                │
│  possible business request →  │                       │  committed work →              │
│  qualify → convert / close    │                       │  schedule → confirm → complete │
└──────────────────────────────┘                       └───────────────────────────────┘
     owns: Service Request                                   owns: Job, Appointment
     goal: turn opportunity into work                             goal: deliver reliably
```

## Process 1 — Service Opportunity (Service Request)

From a *possible business request* to a decision. Ends at the boundary; it does **not** schedule.

- **Origins:** end-user request · Service Recurrence occurrence · Deficiency.
- **State machine:** `new → open → qualified → converted | deferred | closed_lost`
- **Campaigns (Service Opportunity):** booking (convert an open SR), recurring-maintenance, unsold-estimate
  follow-up, deficiency follow-up.
- **Boundary event — conversion:** the SR is attached to / creates a Job → SR becomes `converted` and
  Delivery takes over. An SR may instead be `deferred` or `closed_lost` and never enter Delivery.

## Process 2 — Delivery (Job → Appointment)

From a *committed Job* to completed, reviewed work. Begins at the boundary. This is today's
confirmation product.

- **Job:** `open → scheduled → in_progress → completed → (invoiced) | cancelled`
- **Appointment:** `scheduled → confirmed → completed | rescheduled | cancelled | no_show`
- **Campaigns (Delivery):** appointment confirm, technician confirm, reminder/reschedule, post-job
  review.

## Supporting

- **Service Recurrence:** `active → paused | ended` — a *generator that feeds Process 1*, not part of
  either lifecycle itself.

Campaigns fire off transitions and time-relative-to-state — never off a raw time field. A campaign
belongs to exactly one process.

---

# 10 — Migration path from today's schema

Concrete deltas against [`migrations/026`](migrations/026_core_domain_tables.sql). DDL is
**illustrative**, not final.

### New tables
```sql
-- Physical service sites (first-class, geo). Backfill one per residential customer.
CREATE TABLE locations (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  label VARCHAR, address_line1 VARCHAR, city VARCHAR, state VARCHAR, zipcode VARCHAR,
  geo_lat NUMERIC, geo_lon NUMERIC,               -- routing flow source
  external_ref VARCHAR, source VARCHAR,
  additional_information JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE assets ( id ..., location_id INTEGER REFERENCES locations(id), asset_type VARCHAR,
  make VARCHAR, model VARCHAR, serial VARCHAR, install_date DATE, ... );

CREATE TABLE contacts ( id ..., customer_id ..., name VARCHAR, email VARCHAR, phone VARCHAR, ... );
CREATE TABLE contact_roles ( contact_id ..., location_id ... NULL,
  role VARCHAR CHECK (role IN ('billing','scheduling','on_site','approver')) );

-- Trade/discipline taxonomy (Fire Protection → Sprinkler, ...).
CREATE TABLE service_lines ( id ..., name VARCHAR, trade VARCHAR, abbr VARCHAR );

-- Recurrence templates.
CREATE TABLE service_recurrences ( id ..., location_id ..., asset_id ... NULL,
  frequency VARCHAR, interval INTEGER, config JSONB, status VARCHAR, ... );

CREATE TABLE deficiencies ( id ..., location_id ..., asset_id ... NULL,
  ref_number VARCHAR, description TEXT, status VARCHAR, ... );

-- ★ The central opportunity unit (mirrors ServiceTrade servicerequest).
CREATE TABLE service_requests (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  location_id INTEGER NOT NULL REFERENCES locations(id),
  asset_id INTEGER REFERENCES assets(id),                 -- equipment (nullable)
  service_line_id INTEGER REFERENCES service_lines(id),   -- trade
  job_id INTEGER REFERENCES jobs(id),                     -- NULL until grouped/converted
  service_recurrence_id INTEGER REFERENCES service_recurrences(id),  -- if recurring
  deficiency_id INTEGER REFERENCES deficiencies(id),      -- if from a deficiency
  description TEXT,
  status VARCHAR,                                         -- open → converted → scheduled → completed
  window_start TIMESTAMPTZ, window_end TIMESTAMPTZ,       -- SOFT target window
  duration_seconds INTEGER, preferred_start_time INTEGER,
  external_ref VARCHAR, source VARCHAR,
  additional_information JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- M:N between visits and opportunity.
CREATE TABLE appointment_service_requests ( appointment_id ..., service_request_id ... );

-- Campaigns + agent profiles (generalize call_trigger_configs).
CREATE TABLE agent_profiles ( id ..., name VARCHAR, retell_flow_ref VARCHAR, voice VARCHAR,
  system_prompt TEXT, allowed_tools JSONB, ... );
CREATE TABLE campaigns ( id ..., name VARCHAR, trigger JSONB, audience JSONB, goal VARCHAR,
  mode VARCHAR CHECK (mode IN ('automated','manual','off')),
  channels JSONB, agent_profile_id INTEGER REFERENCES agent_profiles(id), enabled BOOLEAN, ... );
```

### Changes to existing tables
```sql
ALTER TABLE customers
  ADD COLUMN account_type VARCHAR CHECK (account_type IN ('residential','commercial')),
  ADD COLUMN account_type_source VARCHAR CHECK (account_type_source IN ('synced','inferred','manual')),
  ADD COLUMN needs_review BOOLEAN NOT NULL DEFAULT false;

-- Jobs become a container: gain due_by, lose HARD time (keep a DERIVED convenience field).
ALTER TABLE jobs
  ADD COLUMN due_by DATE,                                  -- SOFT booking/completion deadline (drives "appointment needed" campaign)
  ADD COLUMN earliest_appointment_at TIMESTAMPTZ,          -- DERIVED convenience, not source of truth
  ADD COLUMN location_id INTEGER REFERENCES locations(id), -- (Process 1 / commercial — deferred)
  ADD COLUMN is_project BOOLEAN NOT NULL DEFAULT false;    -- (deferred)
-- DEPRECATE after backfill: scheduled_date, scheduled_window_start, scheduled_window_end.

ALTER TABLE appointments ADD COLUMN location_id INTEGER REFERENCES locations(id);
```

### Data backfill
- One `location` per existing residential customer from their address; commercial multi-site comes from
  CRM sync.
- Move any `jobs.scheduled_*` into an `appointment`, then stop reading the job columns.
- Default `account_type` via the tier-2 heuristic, `needs_review = true`, ops confirms.

---

# 11 — Roadmap

**Current focus: Process 2 — Delivery**, operating on the jobs/appointments we already have. The
Service Opportunity process is deferred (kept in §5/§6/§9 for when we pick it up).

### Now — Process 2 (Delivery)
| Step | Scope | Depends on |
|---|---|---|
| **0** | Ratify this doc (Process 2 scope) | — |
| **1** | Time-ownership fix — make Appointment the sole owner of hard time; strip `scheduled_*` off jobs (keep a derived convenience field) | 0 |
| **2** | Job + Appointment lifecycle state machines — replace the scattered status-sync in the [`jobs` route handler](src/routes/jobs.js) | 1 |
| **3** | Campaign engine: `campaigns` + `agent_profiles`, `mode` (automated/manual/off), multi-channel; rebuild scheduler as campaign orchestrator | 2 |
| **4** | Delivery campaigns — appointment confirm, technician confirm, remind/reschedule, post-job review (seed today's triggers as default campaigns) | 3 |

### Deferred — Service Opportunity (Process 1) & beyond
| Step | Scope |
|---|---|
| **D1** | Service Opportunity schema: locations, contacts+roles, assets, service_lines, service_requests, recurrences, deficiencies |
| **D2** | SR generator + Service Opportunity campaigns (booking, recurring-maintenance, estimate, deficiency) |
| **D3** | Inspections / route-planning (geography, tech availability, routing, batch review) |
| **D4** | CRM integration — ingest accounts/locations/assets/SRs/recurrences from ServiceTrade |
| **D5** | `account_type` classification; SMS channel |

---

# 12 — Out of scope (deferred for now)

- **Service Opportunity process (Process 1)** — Service Requests, Recurrences, Deficiencies, and the
  opportunity→job funnel. Documented in §5/§6/§9; deferred while we focus on Process 2. (Roadmap D1–D2.)
- **Inspections / route-planning** — geography, tech availability, routing, batch review. (D3.)
- **CRM integration** — ingest accounts/locations/assets/SRs/recurrences from ServiceTrade. (D4.)
- **`account_type` classification + SMS channel** — campaigns model both, but neither is required for
  the Process 2 v1. (D5.)

---

# 13 — Open questions

1. **Recurrence storage:** RRULE string vs structured JSON (`{frequency, interval}`). Leaning JSON to
   match ServiceTrade's `serviceRecurrence`.
2. **Asset depth now vs later:** create `assets` in step 1 (recommended) but keep thin until commercial
   CRM sync populates it.
3. **`Project` layer** (grouping multiple Jobs) for large commercial engagements — `jobs.is_project`
   flag now, full model later? (Recommend defer.)
4. **Agent Profile override in UI** from day one, or hardcode default-per-campaign-type initially?
5. **Who authors campaigns:** per-company only, or Clara-suggested defaults a human ratifies?

---

# File map (today's building blocks this builds on)

| File | Role |
|---|---|
| [`migrations/026_core_domain_tables.sql`](migrations/026_core_domain_tables.sql) | Current customers / jobs / appointments / quotations |
| [`src/services/scheduler.js`](src/services/scheduler.js) | `runDailyJob` + `process*` triggers → becomes the campaign orchestrator |
| [`src/db/todos.js`](src/db/todos.js) | Human work-queue the `manual` campaign mode reuses |
| [`src/copilot/tools/handlers/read/find-call-targets.js`](src/copilot/tools/handlers/read/find-call-targets.js) | Primitive of "discover work in a state" — precursor to campaign triggers |
| [`migrations/052_copilot.sql`](migrations/052_copilot.sql) | `copilot_pending_actions` — HITL pattern reused for classification & approvals |
| [`scheduling-architecture.md`](scheduling-architecture.md) | Dispatch/concurrency/office-hours layer campaigns dispatch through |
