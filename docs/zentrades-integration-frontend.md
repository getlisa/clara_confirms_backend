# ZenTrades Integration — Frontend Guide

> **For the frontend agent.** ZenTrades is the platform's **third real CRM**,
> alongside ServiceTrade (`docs/integration-document.md`) and InspectPoint
> (`docs/inspectpoint-integration-frontend.md`) — both assumed read, since this
> guide only calls out what's genuinely different.
>
> **Status, be precise about this:**
> - ✅ **Done, migrated, and live**: the credentials table + encrypted-password
>   auth layer, the raw sync engine (`runSync`), `routes/zentrades.js`
>   (connect/status/disconnect/sync + raw-browse), **and normalize** (raw →
>   platform `customers`/`locations`/`contacts`/`technicians`/`jobs`/
>   `appointments`). A sync now produces real, visible data — connect a
>   sandbox tenant, run a sync, and its jobs/appointments/customers show up
>   everywhere the platform already reads those tables (dashboard, job list,
>   chat) exactly like a ServiceTrade or InspectPoint company's would. A
>   confirmation-chat workflow is also registered (`workflows/zentrades.js`),
>   so chat bootstrap's `capabilities` (§8) is real today, not aspirational.
> - ⚠️ **One known gap, not yet closed**: ZenTrades' `doNotServe` flag on a
>   service address (a hard "never call this number" signal) is captured and
>   stored (`locations.additional_information.do_not_serve`), but **no
>   platform column exists yet and no outreach/call-target query checks it**.
>   This MUST be wired into a real column + the scheduler/call-hydration
>   queries before a ZenTrades company is used for live outreach — until
>   then, a do-not-serve address could still be dialed. Flagging this
>   prominently because it's a safety gap, not a cosmetic one.
> - ⛔ **Not started at all**: write-back to ZenTrades (§7 — confirm/
>   reschedule/cancel update our platform only, nothing reaches ZenTrades'
>   own API yet).

Base URL: `VITE_API_URL`. Auth header: `Authorization: Bearer <token>` on every endpoint below.

---

## 0. Three real CRMs now — the mutual-exclusivity tile extends, doesn't change shape

`docs/inspectpoint-integration-frontend.md` §0 already established: a company
can have at most one active CRM connection, and a locked tile shows the
specific reason ("Disconnect X first"), not a generic "coming soon". That rule
now needs a third tile, and the state machine needs to handle **any one of
three** being active, not just "the other one":

```
On page load: call getServiceTradeStatus(), getInspectPointStatus(),
getZenTradesStatus() — three calls, not two.

Whichever ONE returns hasCredentials: true is "active" — render its full
card. Render the OTHER TWO locked, each naming the actual active one
("Disconnect ServiceTrade first"), not a generic message.

When NONE has credentials, all three tiles are open.
```

Don't hardcode "the other tile" logic pairwise (if-ServiceTrade-then-lock-
InspectPoint, if-InspectPoint-then-lock-ServiceTrade) — that pattern breaks
the moment a fourth CRM shows up. Loop over all three statuses and lock every
tile except whichever one is connected.

---

## 1. Connect modal — username + password, not an API key

Unlike InspectPoint's static API key, ZenTrades authenticates like a normal
login: **username and password**, no subdomain field.

```
┌────────────────────────────────────┐
│  Connect ZenTrades                  │
│                                      │
│  Username  [_______________]        │
│  Password  [_______________]        │
│                                      │
│           [ Cancel ]  [ Connect ]   │
└────────────────────────────────────┘
```

The backend performs a real login before saving anything — a bad password
fails the connect attempt immediately (see §3.1's 401/403 response), it never
saves invalid credentials and discovers that later.

**This modal needs no "subdomain" or "API key" language anywhere** — reusing
InspectPoint's copy here would be actively wrong, not just generic.

---

## 2. The new thing: `authStatus` — a mid-connection failure state neither other CRM has

This is the one genuinely new piece of UI. Both ServiceTrade's session cookie
and InspectPoint's API key are either present or absent — "connected" or
"not connected" is the whole state space. **ZenTrades' credential is a
password that can stop working while the integration otherwise looks
connected**: someone rotates it in ZenTrades, and the next login attempt gets
rejected. There is no refresh-token endpoint on ZenTrades' side, so the
backend logs back in with the stored password on a fixed 30-day cycle (not
tied to activity) — the same rejection path fires whenever that happens to
land after a rotation. The backend detects this and needs the UI to surface
it as a specific, actionable state — not a generic sync-failure toast that
gets lost between cron runs.

`GET /integrations/zentrades/status` (§3.2) returns an `authStatus` field:

| `authStatus` | Meaning | What the tile should show |
|---|---|---|
| `"ok"` | Working normally | Normal connected card (see §3.2's shape) |
| `"invalid_credentials"` | Login itself is failing — the stored password no longer works | **"Password changed — reconnect"**, with the connect modal (§1) offered inline to re-enter credentials. This is not a transient error; it will not fix itself on the next cron run. |
| `"forbidden"` | Login succeeds, but a specific ZenTrades API call was rejected for this user's role | **"Missing permissions"** — re-entering the same password won't fix this; the message should point at the ZenTrades account's role/permissions, not "reconnect" |

```jsonc
// GET /integrations/zentrades/status — authStatus: "invalid_credentials"
{
  "connected": true,
  "hasCredentials": true,
  "authStatus": "invalid_credentials",
  "authFailedAt": "2026-09-08T14:30:00.000Z",
  "authMessage": "zentrades: login failed — the stored password no longer works. Reconnect with the current password.",
  "sync": { "syncing": false, "lastSyncStatus": "failed", "lastSyncError": "Incomplete: tickets", ... }
}
```

**Design the card so `authStatus !== "ok"` takes visual priority over the sync
fields** — `sync.lastSyncStatus` will also say `"failed"` while locked out
(every sync attempt short-circuits without even trying to log in — see the
backend plan's reasoning: retrying a known-bad password every 2 hours risks
the ZenTrades account itself getting rate-limited), but "your last sync
failed" and "your password stopped working, here's exactly why and how to
fix it" are very different messages to show a user. Don't let the generic
sync-error UI mask the specific one.

**Recovery is just the connect modal again** — submitting new credentials via
§3.1 clears `authStatus` back to `"ok"` on success. No separate "clear error"
action needed.

---

## 2.5 Every ZenTrades API error is monitored via Action Items — not just auth failures

`authStatus` (§2) covers the *connection*-level failure (can we log in at
all). Separately, **any individual ZenTrades API call that fails — a 404, a
500, a network timeout, anything other than the 401/403 cases already
covered above — files a `CRM_SYNC` todo**, visible on the existing Action
Items page (`docs/frontend-implementation-guide.md`'s `/todos` → `TodosPage`).
This is intentional and CRM-agnostic infrastructure (`db/todos.js`'s
`createCrmApiErrorTodo`), currently wired up for ZenTrades specifically per
product decision — no new frontend concept, since generic `CRM_SYNC` todos
already render today. Two things worth knowing if you're building
anything that reads todo metadata directly rather than just the `notes`
string:

- These are tagged `metadata.kind: "api_error"` (distinct from the
  auth-failure todos in §2, which carry `metadata.reason` instead) —
  `metadata.method`/`metadata.path`/`metadata.status` identify what failed.
- Repeated failures of the **same** endpoint collapse into one open item
  rather than flooding the list, and it **auto-resolves** the next time a
  full sync run completes with nothing incomplete — so a transient ZenTrades
  outage doesn't leave a permanent, manually-dismissed-forever item once the
  service recovers on its own.

No frontend action item here beyond being aware that a ZenTrades company may
show more `CRM_SYNC` todos than the other two CRMs, and that's by design, not
a bug.

---

## 3. Endpoint Reference (live now)

### 3.1 `POST /integrations/zentrades/credentials`

```json
// Request
{ "username": "alice@example.com", "password": "hunter2" }

// Response 200
{ "connected": true, "message": "Connected to ZenTrades" }

// Response 400 — missing fields
{ "error": "username and password are required" }

// Response 403 — bad credentials (always 403, never 401, for a rejected login)
{ "connected": false, "error": "Invalid ZenTrades username or password" }

// Response 409 — another CRM is already connected (see §0)
{ "connected": false, "error": "ServiceTrade is already connected for this company. Disconnect it first." }
```

Handle the 409 as its own inline message, same as InspectPoint's §4.1.

### 3.2 `GET /integrations/zentrades/status`

Same base shape as ServiceTrade/InspectPoint's status endpoints, **plus** the
three `auth*` fields from §2:

```jsonc
{
  "connected": true,
  "hasCredentials": true,
  "authStatus": "ok",           // "ok" | "invalid_credentials" | "forbidden" — see §2
  "authFailedAt": null,
  "authMessage": null,
  "sync": {
    "syncing": false,
    "currentState": null,
    "runId": null,
    "startedAt": null,
    "lastSyncAt": "2026-09-08T10:12:04.000Z",
    "lastSyncStatus": "success",
    "lastSyncError": null,
    "lastRunAbandoned": false
  }
}
```

### 3.3 `DELETE /integrations/zentrades/session`

Same as the other two — clears the stored password, preserves `username` and
`metadata` for a one-click reconnect (just re-enter the password).

### 3.4 `POST /integrations/zentrades/sync?full=true&stream=true&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD`

Same contract shape as the other two CRMs' sync trigger — always pass
`stream: true`, subscribe to the returned `streamUrl`. Custom range validation
(both dates or neither, ≤31 days apart, mutually exclusive with `full`) is
shared across all three CRMs.

One difference worth knowing about even though it doesn't change how the
frontend calls this: ZenTrades' underlying date filter takes full
timestamps (not calendar-only dates like InspectPoint's), so `startDate`/
`endDate` are converted to day-boundary instants server-side — nothing the
UI needs to do differently.

---

## 4. TypeScript Types

Extend `src/types/integration.ts`:

```typescript
export type CrmSlug = 'servicetrade' | 'inspectpoint' | 'zentrades';

export interface ZenTradesStatus extends IntegrationStatus {
  authStatus: 'ok' | 'invalid_credentials' | 'forbidden';
  authFailedAt: string | null;
  authMessage: string | null;
}
```

Raw row shapes (for the CRM Browser page, §5) go in a new `src/types/zentrades.ts`.
The raw-list endpoints are live now (§3.5), so this can be built — they follow
InspectPoint's "slim raw table" convention, not ServiceTrade's fully-typed one:
most fields live in `payload`, only a handful are promoted columns (see the
seven-table list in §5). **These are raw sync rows, distinct from platform
data** — normalize now populates real `jobs`/`appointments`/`customers`/etc.
rows too (see the status banner), which is what the dashboard/job list/chat
actually read; the raw tables exist purely for debugging/traceability back
to ZenTrades' own ids.

---

## 5. CRM Browser Page

The seven raw-list endpoints exist now (`GET /integrations/zentrades/{tickets,
appointments,customers,locations,technicians,contacts,recurrences}`, same
`page`/`perPage` pagination convention as the other two CRMs, envelope key
matches the plural entity name). Add ZenTrades as a **third provider group**
to the pattern in `integration-document.md` §6 / InspectPoint's §6 — seven
tabs for ZenTrades specifically (tickets, appointments, customers, locations,
technicians, contacts, recurrences), on top of the existing four (ServiceTrade)
and six (InspectPoint). This is a debug/traceability view over RAW sync
data, lower priority than §1/§2 — the actual product surfaces (dashboard,
job list, chat) read the normalized platform tables, not these.

---

## 6. Sync Progress

Same SSE contract as the other two CRMs (`integration-document.md` §7). Stage
names for ZenTrades, as actually emitted: `authenticating` → `fetching_tickets`
→ `fetching_recurrences` → `normalizing` → `done` | `failed`. Shorter than the
other two CRMs' fetch stages — ZenTrades' one ticket-search endpoint feeds six
entities in a single fetch, so there's no per-entity fetch stage the way
InspectPoint has `fetching_accounts`/`fetching_buildings`/etc. — but `emit`s
of type `entity_done` fire once per normalized entity
(customers/contacts/technicians/locations/jobs/appointments, in that order)
during the `normalizing` stage, same convention as the other two CRMs. Don't
render a progress bar that assumes six fetch stages; three fetch-phase
states plus normalize's own entity_done stream is correct.

---

## 7. Write-back — explicitly not happening yet

Confirming/rescheduling/cancelling an appointment on a ZenTrades-sourced job
updates **our own platform only** — nothing is pushed back to ZenTrades. This
is a deliberate, temporary product decision (fetch-and-normalize first, decide
on write-back once that's solid), not a bug. No frontend work is implied by
this — the confirm/reschedule/cancel UI behaves identically regardless of
which CRM a job came from; there's just no round-trip to ZenTrades happening
behind it yet.

---

## 8. Chat/voice behavior — LIVE now, no frontend code change needed

Normalize + a registered confirmation-chat workflow (`workflows/zentrades.js`)
both landed together, so a ZenTrades-sourced chat reports real data today —
this section is no longer a future plan, it's the actual current contract:

```jsonc
{
  "crm": "zentrades",
  "capabilities": {
    "service_link": false,      // no ZenTrades equivalent exists
    "slot_suggestion": false,   // no write-back yet — no point proposing a slot the agent can't act on
    "cancellation_reason": "required"  // no ZenTrades-specific override; same as ServiceTrade's default
  }
}
```

If your widget already implements InspectPoint's §4.11 contract generically
(reading whatever `capabilities` the bootstrap returns rather than hardcoding
per-CRM branches), **there is nothing to build here** — a ZenTrades chat just
works. The fallback rule (an absent `capabilities` object defaults to
ServiceTrade's shape) still applies unchanged for any older backend.

Remember §7: the conversation itself behaves identically to any other CRM
(confirm/reschedule/cancel all work), it just doesn't push the change back to
ZenTrades yet.

---

## 9. Frontend Checklist

**Do now — the backend for all of this is live:**
- [ ] Extend `CrmSlug` to include `'zentrades'` (§4)
- [ ] Generalize the Settings page's mutual-exclusivity logic to loop over N
      providers instead of a ServiceTrade/InspectPoint pair (§0)
- [ ] Design the `authStatus` card states (§2) — the one piece with no
      precedent in either existing CRM's UI
- [ ] Wire up `getZenTradesStatus()` / `connectZenTrades()` / `disconnectZenTrades()` (§3.1–§3.3)
- [ ] Add the ZenTrades tile to Settings (§1)
- [ ] Sync trigger + progress stream (§3.4, §6) — note the shorter fetch-stage list (§6)
- [ ] Confirm chat/voice needs no change if your capability handling is already generic (§8)

**Lower priority — a debug view, sequence after the above:**
- [ ] CRM Browser tabs (§5) — raw sync data only, separate from the platform data driving the actual product

**Known gap to track, not a frontend task:** ZenTrades' `doNotServe` flag isn't
enforced anywhere yet (see the status banner) — flag it if backend hasn't
closed this before any ZenTrades company goes live with real outreach.

**Do once normalize + chat integration land (Phase B — not started):**
- [ ] Chat bootstrap capability handling (§8) — likely no code change if §4.11's
      fallback-to-ServiceTrade-defaults logic already exists generically
- [ ] Anything reading `jobs`/`appointments`/`customers` for a ZenTrades company
      (dashboard, job list) — there is no data there until normalize ships
