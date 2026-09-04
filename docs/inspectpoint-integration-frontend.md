# InspectPoint Integration — Frontend Guide

> **For the frontend agent.** InspectPoint is the platform's **second real CRM**,
> alongside ServiceTrade (see `docs/integration-document.md`, which this guide
> assumes you've read — it covers the shared two-layer sync architecture, the
> SSE progress stream, and the "Coming soon" tile pattern this replaces).
>
> **Status:** this document specifies the contract for **Phase 1–2 of the
> backend work** (credentials + read-only entity sync), which is what's being
> implemented next. §8 below covers Phase 3–5 (write-back, chat behavior,
> slot management) — informational only, nothing to build yet, so you can see
> where this is headed without starting on it early.

Base URL: `VITE_API_URL`. Auth header: `Authorization: Bearer <token>` on every endpoint below.

---

## 0. Two real CRMs now exist — read this before touching Settings

`docs/integration-document.md` §5 shows ServiceTrade "Connected" next to BuildOps
and ServiceTitan as inert "Coming soon" tiles. That mockup never had to answer
"what if the user clicks *both*?" — there was only ever one real option.

**That question is now real, and the backend enforces an answer: a company can
have at most one active CRM connection.** The InspectPoint credentials endpoint
refuses to connect while a ServiceTrade connection is active for that company
(and vice versa), specifically because both CRMs can genuinely describe the
same real-world jobs with no way to deduplicate them, so running both at once
would double every job on the dashboard. See §5 for the exact settings-page
behavior this requires.

---

## 1. Two prerequisite fixes — verify these before InspectPoint data reaches a screen

These are gaps in the **existing, ServiceTrade-only** frontend that InspectPoint
will expose immediately, because it violates assumptions ServiceTrade happened
to always satisfy. Check both before wiring up anything below.

### 1.1 `Customer.phone` must become `string | null`

`docs/frontend-implementation-guide.md` types `Customer.phone` as `string`
(non-nullable). That was safe for ServiceTrade — every customer record carries
some phone value. **InspectPoint accounts have no phone field at all**; it will
always be `null` for every InspectPoint-sourced customer, not as a data-quality
edge case but structurally, for every single one. Any component that reads
`customer.phone` directly (a list row, a click-to-call button, a formatted
display string) needs a null-safe path — e.g. "No phone on file" — or an
InspectPoint company's customer list will show `"undefined"` or throw.

### 1.2 The job-type dropdown must be fully dynamic — verify the old hardcoded list is actually gone

`docs/frontend-implementation-guide.md` §12(ish) already documented this exact
failure mode for ServiceTrade: a hardcoded 5-value `TYPE_OPTIONS` was "silently
hiding most jobs from the filter" once ServiceTrade's real ~24 job types were
synced, and the fix was to source the dropdown from `GET /jobs/job-types`
(distinct values actually present for the company) instead.

**Confirm that fix actually shipped**, not just that it was written down.
InspectPoint's job types are freeform, tenant-configured inspection-type names
(e.g. *"Annual Fire Alarm"*, *"Semi-Annual Sprinkler"*) — nothing like
ServiceTrade's snake_case set, and a second reason for a closed list or stale
union to silently drop an entire CRM's jobs from every filter. If any component
still imports the closed `JobType` union instead of calling `/jobs/job-types`,
fix it now — it will otherwise fail exactly the same way, on exactly the same
class of company, twice.

---

## 2. TypeScript Types

Extend `src/types/integration.ts`:

```typescript
export type CrmSlug = 'servicetrade' | 'inspectpoint' | 'buildops' | 'servicetitan';
```

`IntegrationStatus` and `SyncResult` (already defined for ServiceTrade) are
reused as-is — see §4 for the one real shape difference (no `user` object).

Create `src/types/inspectpoint.ts` for the raw shapes. **Read this carefully —
these are NOT shaped like `STCustomer`/`STJob`.** ServiceTrade's raw tables
duplicate every scalar field into a typed column. InspectPoint's raw tables
deliberately don't: only fields needed as a filter, a soft foreign key, or a
status are promoted to real columns; everything else — name, email, address,
every display field — lives inside `payload`. Read display fields out of
`payload`, not off the row.

```typescript
export interface IPAccount {
  id: number;
  company_id: number;
  inspectpoint_id: number;
  is_active: boolean;
  payload: Record<string, unknown>;   // name, reference_number, billing_address*, tags, custom_fields
  created_at: string;
  updated_at: string;
}

export interface IPBuilding {
  id: number;
  company_id: number;
  inspectpoint_id: number;
  inspectpoint_account_id: number | null;
  payload: Record<string, unknown>;   // name, address*, phone_number, latitude/longitude, contacts[]
  created_at: string;
  updated_at: string;
}

export interface IPContact {
  id: number;
  company_id: number;
  inspectpoint_id: number;
  inspectpoint_account_id: number | null;
  payload: Record<string, unknown>;   // name (single string — no first/last split here), email,
                                       // cell/home/business phone, buildings[], account_contact_types[]
  created_at: string;
  updated_at: string;
}

export interface IPTechnician {
  id: number;
  company_id: number;
  inspectpoint_id: number;
  is_active: boolean;
  payload: Record<string, unknown>;   // name, email, phone_number, system (bool — service accounts, filtered out downstream)
  created_at: string;
  updated_at: string;
}

export interface IPInspection {
  id: number;
  company_id: number;
  inspectpoint_id: number;
  inspectpoint_building_id: number | null;
  inspectpoint_account_id: number | null;
  inspectpoint_technician_id: number | null;
  status_code: string;                // the FULL 15-value InspectPoint vocabulary — see §7 for how it maps to jobs.status
  scheduled_at: string | null;        // tenant-local instant, already timezone-correct
  payload: Record<string, unknown>;   // reference_number, due_date, frequency_type, inspection_type, technician_instructions
  created_at: string;
  updated_at: string;
}

export interface IPInspectionVisit {
  id: number;
  company_id: number;
  inspectpoint_id: number;
  inspectpoint_inspection_id: number | null;
  inspectpoint_technician_id: number | null;
  visit_status: string | null;        // scheduled | started | complete | cancelled — may be null (unscheduled visit)
  scheduled_date: string | null;      // nullable — an unscheduled visit is a real, valid row
  payload: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}
```

---

## 3. API Functions to Add

Add to `src/lib/auth-api.ts`, following the exact `connectServiceTrade` /
`getServiceTradeStatus` / `disconnectServiceTrade` pattern:

```typescript
// ── InspectPoint — credentials & session ──────────────────────────────────────

export async function connectInspectPoint(
  token: string,
  body: { subdomain: string; apiKey: string; metadata?: Record<string, unknown> }
): Promise<{ connected: boolean; error?: string }>;

export async function getInspectPointStatus(token: string): Promise<IntegrationStatus | null>;

export async function disconnectInspectPoint(token: string): Promise<{ ok: boolean; error?: string }>;

// ── InspectPoint — sync ─────────────────────────────────────────────────────

export async function runInspectPointSync(
  token: string,
  opts?: { full?: boolean; stream?: boolean }
): Promise<SyncResult | { runId: string; kind: string; streamToken: string; streamUrl: string; snapshotUrl: string } | null>;

// ── InspectPoint — list raw rows ─────────────────────────────────────────────

export async function getIPAccounts(token: string, params?: { page?: number; perPage?: number }): Promise<{ accounts: IPAccount[] } | null>;
export async function getIPBuildings(token: string, params?: { accountId?: number; page?: number; perPage?: number }): Promise<{ buildings: IPBuilding[] } | null>;
export async function getIPContacts(token: string, params?: { accountId?: number; buildingId?: number }): Promise<{ contacts: IPContact[] } | null>;
export async function getIPTechnicians(token: string): Promise<{ technicians: IPTechnician[] } | null>;
export async function getIPInspections(token: string, params?: { buildingId?: number; page?: number; perPage?: number }): Promise<{ inspections: IPInspection[] } | null>;
export async function getIPInspectionVisits(token: string, params?: { inspectionId?: number }): Promise<{ visits: IPInspectionVisit[] } | null>;
```

Start `runInspectPointSync` with `stream: true` from day one — do not repeat
the ServiceTrade blocking-call mistake described in `integration-document.md`
§4.4/§7.1. There is no reason to build the blocking path for a brand-new
integration.

---

## 4. Endpoint Reference

All endpoints mounted under `/integrations/inspectpoint/*`, JWT-authenticated,
same shapes as the ServiceTrade equivalents in `integration-document.md` §4
except where noted.

### 4.1 `POST /integrations/inspectpoint/credentials`

**The one real shape difference from ServiceTrade.** InspectPoint auth is a
static per-tenant API key against a subdomain — there is no login handshake, so
there is no `user` object to return. The backend verifies the key with one
lightweight read (`GET /accounts?max=1`) before saving.

```json
// Request
{ "subdomain": "acme", "apiKey": "ip_live_...", "metadata": {} }

// Response 200
{ "connected": true, "message": "Connected to InspectPoint" }

// Response 400 — missing fields
{ "error": "subdomain and apiKey are required" }

// Response 403 — bad key or subdomain
{ "connected": false, "error": "Invalid InspectPoint credentials" }

// Response 409 — the other CRM is already connected (see §0)
{ "connected": false, "error": "ServiceTrade is already connected for this company. Disconnect it first." }
```

**Handle the 409 explicitly** — it is not a generic failure, it is the
mutual-exclusivity rule from §0. Show it as its own message, not a fallback
"failed to connect" toast.

### 4.2 `GET /integrations/inspectpoint/status`

Identical shape to ServiceTrade's (`integration-document.md` §4.2) minus `user`:

```json
{
  "connected": true,
  "hasCredentials": true,
  "sync": {
    "syncing": false,
    "currentState": null,
    "runId": null,
    "startedAt": null,
    "lastSyncAt": "2026-09-01T10:12:04.000Z",
    "lastSyncStatus": "success",
    "lastSyncError": null,
    "lastRunAbandoned": false
  }
}
```

Same rules apply: `sync.syncing` is server-derived truth, poll on page load,
subscribe to `sync.runId` if a run is already in flight.

### 4.3 `DELETE /integrations/inspectpoint/session`

Same as ServiceTrade — clears the stored key, preserves metadata for one-click reconnect.

### 4.4 `POST /integrations/inspectpoint/sync?full=true&stream=true&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD`

Same contract as `integration-document.md` §4.4. **Always pass `stream: true`.**

```json
{ "runId": "2001", "kind": "crm_sync", "streamToken": "...", "streamUrl": "/engines/2001/stream?token=...", "snapshotUrl": "/engines/2001" }
```

**Custom range** (e.g. backfilling a past month): pass `startDate`/`endDate` together —
both required if either is given, at most 31 days apart, mutually exclusive with
`full=true`. A bad range 400s immediately (`{ error: "..." }`) before any run
starts — same five validation messages as ServiceTrade's. Unlike ServiceTrade's
version, there's no company-timezone conversion here — InspectPoint's own date
filter has no time-of-day component, so the dates are used as plain calendar
days. A custom-range run still only pulls open work (`pending`/`scheduled`) —
it changes WHICH dates are searched, not which statuses qualify — and
deliberately doesn't advance the regular incremental cursor, so it's safe to
run repeatedly without disturbing normal incremental syncs.

### 4.11 Chat bootstrap now returns `crm` + `capabilities` (NEW)

The customer-facing chat bootstrap (`GET /chat/:token`, the call that returns
`company_name`/`messages`/`appointments`) gained two keys:

```jsonc
{
  "crm": "inspectpoint",              // "servicetrade" | "inspectpoint"
  "capabilities": {
    "service_link": false,            // is the "email me a link" step possible at all
    "slot_suggestion": true,          // can the agent propose concrete slots
    "cancellation_reason": "optional" // "optional" | "required"
  }
}
```

Bootstrap-only — capabilities are a property of the connected CRM, so they
can't change mid-conversation and are not repeated on every turn. Cache them
with the session.

`cancellation_reason` is the one the widget **must** honour (see §8.1); the
other two are informational and safe to ignore, since the backend already
withholds the corresponding tools.

Treat an absent `capabilities` object as `{service_link: true,
slot_suggestion: false, cancellation_reason: "required"}` — i.e. today's
ServiceTrade behaviour — so the widget still works against an older backend.

### 4.5–4.10 Raw list endpoints

`GET /integrations/inspectpoint/{accounts,buildings,contacts,technicians,inspections,inspection-visits}`

Same pagination convention as ServiceTrade (`page`/`perPage`, max 200). Filters:
`buildings?accountId=`, `contacts?accountId=` or `?buildingId=`,
`inspections?buildingId=`, `inspection-visits?inspectionId=`. Response envelope
keys match the plural entity name (`{ accounts: [...] }`, etc.) — see §2 for row shape.

---

## 5. Settings Page — the mutual-exclusivity state machine

This is the part with no ServiceTrade precedent. Replace the static "Coming
soon" InspectPoint tile with a real one, and add the cross-tile logic:

```
CRM Integrations
─────────────────────────────────────────────────────────────────
  Connect your field-service CRM so Clara can automatically pull
  customers, jobs, appointments, and technicians. Only one CRM can
  be connected at a time.

  ┌──────────────────────────────────────────────────────────┐
  │  🔌  ServiceTrade                          ✅ Connected   │
  │  ops@acme.com · Last synced: 2 minutes ago                │
  │  [ Sync now ]  [ Full re-sync ]  [ Disconnect ]            │
  └──────────────────────────────────────────────────────────┘

  ┌──────────────────────────────────────────────────────────┐
  │  🔌  InspectPoint                    🔒 Disconnect ServiceTrade first │
  └──────────────────────────────────────────────────────────┘
```

or, symmetrically, when InspectPoint is the active one:

```
  ┌──────────────────────────────────────────────────────────┐
  │  🔌  ServiceTrade                    🔒 Disconnect InspectPoint first │
  └──────────────────────────────────────────────────────────┘

  ┌──────────────────────────────────────────────────────────┐
  │  🔌  InspectPoint                          ✅ Connected   │
  │  acme.inspectpoint.com · Last synced: 5 minutes ago        │
  │  [ Sync now ]  [ Full re-sync ]  [ Disconnect ]            │
  └──────────────────────────────────────────────────────────┘
```

**Logic:**
1. On page load, call both `getServiceTradeStatus()` and `getInspectPointStatus()`.
2. Whichever returns `hasCredentials: true` is "active" — render its full card (identical states to `integration-document.md` §5's table).
3. Render the *other* tile locked, with the specific reason ("Disconnect X first"), not a generic "coming soon". This is a real, actionable constraint, not a placeholder.
4. When **neither** has credentials, both tiles are open — either can be connected first.
5. After a successful `disconnectX()`, immediately re-render the other tile as connectable — don't require a page reload.

**Connect modal** — mirror `ServiceTradeConnectModal` but with `subdomain` +
`apiKey` fields instead of `username`/`password`, and handle the 409 from §4.1
as a distinct inline error rather than the generic failure toast.

---

## 6. CRM Browser Page

Add InspectPoint as a second provider to the pattern in
`integration-document.md` §6 — **six tabs, not four**, and each row renders
from `payload` (see §2's warning):

```tsx
<Route path="/crm/inspectpoint" element={<CRMBrowserPage provider="inspectpoint" />} />
```

Tabs: Accounts, Buildings, Contacts, Technicians, Inspections, Inspection Visits.
Click-through linkage: Account → Buildings (`accountId` filter) → Inspections
(`buildingId` filter) → Inspection Visits (`inspectionId` filter) — one level
deeper than ServiceTrade's, matching the extra Building layer.

If `CRMBrowserPage` is already parameterized on `CrmSlug` per
`integration-document.md` §8's future-proofing checklist, this should mostly be
new table components (`IPAccountsTable`, etc.) plus a `payload`-reading row
renderer, not new page-level logic.

---

## 7. Sync Progress — stage names (authoritative contract for Phase 2)

Same SSE mechanics as ServiceTrade (`integration-document.md` §7.2) — same
`snapshot`/`state`/`fetched`/`entity_done`/`done`/`failed` events, same
"empty ≠ finished" rule while `sync.syncing` is true. These are the exact stage
values Phase 2 implements against — treat this table as the source of truth
when you build the InspectPoint stage checklist, not something to infer once
the backend ships:

| `state` | What's happening |
|---|---|
| `authenticating` | verifying the API key |
| `fetching_accounts` | paged account pull |
| `fetching_buildings` | paged building pull |
| `fetching_contacts` | full contact pull (no incremental filter exists on this endpoint) |
| `fetching_technicians` | full technician pull (same) |
| `fetching_inspections` | paged inspection pull, filtered to open work (`pending`/`scheduled`) |
| `fetching_inspection_visits` | one request per inspection touched this run |
| `normalizing` | raw → platform tables |
| `done` / `failed` | terminal |

`fetched` entities (raw layer): `accounts`, `buildings`, `contacts`,
`technicians`, `inspections`, `inspection_visits`.

`entity_done` entities (platform layer), in the order they actually fire:
`customers`, `contacts`, `technicians`, `locations`, `service_lines`, `jobs`,
`appointments`, `appointment_services` — note these are **platform** names, the
same shared tables ServiceTrade normalizes into, not InspectPoint's own entity
names. A `jobs` `entity_done` event fires for either CRM. Unlike ServiceTrade
(where jobs-before-appointments is load-bearing for the "zero appointments =
still loading" UI rule), technicians/locations have no ordering dependency on
each other — don't infer one from the other.

⚠️ **`service_lines` and `appointment_services` are new** (they were not in the
original Phase 2 contract). If your stage checklist is a fixed list of expected
entities, add them or the progress UI will either miss two steps or never reach
100%. `appointment_services` is always the LAST entity to fire, so it — not
`appointments` — is the reliable "normalize is finished" signal.

One real behavioral note distinct from ServiceTrade: **`contacts` and
`technicians` have no incremental cursor** — every InspectPoint sync does a
full pull of those two entities regardless of `full=true`. This is a backend
API limitation (no `updated_at` filter exists on those endpoints), not a bug —
don't be surprised that `fetching_contacts` runs the same on every sync.

---

## 8. Shipped since Phase 2 — what actually needs frontend work

Everything previously listed here as "later phase" has now shipped. Only the
first item below needs code; the rest are behaviour you should know about.

### 8.1 ⚠️ Cancellation reason is now optional on InspectPoint — REQUIRES a change

`docs/chat-cards-frontend.md` §7 documents `args.reason` as required on a
`cancel_appointment` card trigger (400 otherwise). That is still true for
ServiceTrade, but **InspectPoint now accepts an empty/absent reason**.

The chat bootstrap response (§4.11) carries the flag to branch on:

```ts
if (bootstrap.capabilities.cancellation_reason === "optional") {
  // don't block submit on an empty reason; label the field "optional"
}
```

Keep sending `reason` when the customer gives one — it is still stored and
still written back to the CRM. This only relaxes the client-side requirement.

### 8.2 No service-link step for InspectPoint — no code change

The "would you like a link emailed to you?" step never fires for an
InspectPoint company; the backend withholds the tools entirely. The absence is
the feature — don't build a conditional. `capabilities.service_link` is exposed
anyway if you want to hide a menu affordance proactively.

### 8.3 Reschedule slot suggestion — no new card type

The agent can now propose concrete technician-availability slots instead of
asking for a free-text time. It delivers them **as ordinary assistant message
text**, not a new card type, so there is nothing to render differently. Two
consequences worth knowing:

- A reschedule can now come back as a normal `409`-style conflict if the slot
  was taken between the offer and the confirm. The agent handles it
  conversationally and re-offers; no special frontend handling needed.
- `capabilities.slot_suggestion` tells you whether this CRM does it at all
  (`true` for InspectPoint, `false` for ServiceTrade today).

### 8.4 Frequency and service-line context — now real data, see §8.5

Frequency ("Semi Annual") and the derived service line ("Fire Extinguishers")
now reach the platform as structured fields rather than prompt-only prose.

### 8.5 InspectPoint jobs/appointments now populate fields that used to be null

This is the one to sanity-check against your existing rendering. Before this
change an InspectPoint job rendered with a placeholder title, no description,
no service line, and — the serious one — **appointments with a null
`scheduled_start`**. All are now populated:

| Field | Before | Now |
|---|---|---|
| `appointment.scheduled_start` | `null` on every row | real instant |
| `appointment.scheduled_end` | `null` | derived from the visit's own duration |
| `job.title` / `job.job_type` | `"Inspection 2839"` | `"Fire Extinguishers"` (real type), else `"Semi Annual Inspection"` |
| `job.description` | `null` | `"Annual Fire Extinguishers inspection (about 2 hours)"` |
| `job.scheduled_window_end` | `null` | derived from projected duration |
| `job.additional_information.frequency_type` | `null` | `"annual"` / `"semiannual"` / … |
| `job.additional_information.frequency_label` | *(absent)* | `"Annual"` / `"Semi Annual"` — **new key** |
| `service_details` on an appointment | empty | `[{ service_line, description }]` |

Nothing here is a breaking type change — fields that were `string | null` are
still `string | null`, they just stop being null. But if any screen special-cases
"InspectPoint jobs have no time/description," remove that.

⚠️ **Not every job gets a service line.** On a real tenant, ~60% of inspections
carry a true inspection type; the rest fall back to a frequency-derived title
and have `service_line: null` with the description still populated. Render the
description as the fallback, not the job number.

---

## 9. Frontend Checklist

### Prerequisites (§1) — do these first, they affect ServiceTrade rendering too
- [ ] Verify `Customer.phone` is `string | null` everywhere it's typed and rendered, with a null-safe display path
- [ ] Verify the job-type dropdown is 100% sourced from `GET /jobs/job-types` — no hardcoded `TYPE_OPTIONS` or closed `JobType` union left anywhere

### Types
- [ ] Add `'inspectpoint'` to `CrmSlug`
- [ ] Create `src/types/inspectpoint.ts` — `IPAccount`, `IPBuilding`, `IPContact`, `IPTechnician`, `IPInspection`, `IPInspectionVisit` (§2)

### API layer
- [ ] `connectInspectPoint()`, `getInspectPointStatus()`, `disconnectInspectPoint()`, `runInspectPointSync()`
- [ ] `getIPAccounts()`, `getIPBuildings()`, `getIPContacts()`, `getIPTechnicians()`, `getIPInspections()`, `getIPInspectionVisits()`

### Settings page — the new part
- [ ] Replace the static InspectPoint "Coming soon" tile with a real connected/disconnected/locked card
- [ ] Implement the mutual-exclusivity state machine (§5): whichever CRM has credentials is active; the other renders locked with an explicit reason, not "coming soon"
- [ ] Handle the `409` "other CRM already connected" response as a distinct inline error (§4.1)
- [ ] `InspectPointConnectModal` — `subdomain` + `apiKey` fields
- [ ] Re-render both tiles immediately after a disconnect, no reload required

### CRM Browser page
- [ ] Add `/crm/inspectpoint` route, six tabs (§6)
- [ ] Row renderers read display fields from `payload`, not flat columns — do not copy the ServiceTrade table components as-is
- [ ] Click-through: Account → Buildings → Inspections → Inspection Visits

### Sync progress
- [ ] Stage checklist using the §7 table — different labels from ServiceTrade's `fetching_jobs`/`fetching_job_details`/etc.
- [ ] Don't be alarmed that `fetching_contacts`/`fetching_technicians` always run in full — no incremental filter exists for those two entities
- [ ] Reuse the existing SSE subscription / "importing, don't show empty state" logic wholesale — it's provider-agnostic already

### Sync range (§4.4)
- [ ] Optional: date-range picker on the sync button (`startDate`/`endDate`, both or neither, ≤31 days, not with `full=true`) for backfilling a past month
- [ ] Surface the 400 message verbatim — the five validation errors are written to be shown to a user

### Shipped since Phase 2 (§8) — the only real code change is the first
- [ ] **Allow an empty cancellation reason when `capabilities.cancellation_reason === "optional"`** (§8.1) — everything else in §8 is behaviour, not code
- [ ] Cache `crm` + `capabilities` from the chat bootstrap; default to ServiceTrade behaviour when absent (§4.11)
- [ ] Add `service_lines` + `appointment_services` to the sync-progress entity checklist, and treat `appointment_services` as the "normalize finished" signal (§7)
- [ ] Remove any special-casing that assumes InspectPoint jobs have no scheduled time, description, or service line — all now populated (§8.5)
- [ ] Handle `service_line: null` with the description as the fallback label (~40% of inspections have no true type)
- [ ] No service-link conditional needed — the absence still requires no code
- [ ] No new card type for slot suggestion — slots arrive as ordinary assistant message text
