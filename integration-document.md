# CRM Integration Layer — Frontend Guide

> **For the frontend agent.** This document covers the new CRM integration layer (ServiceTrade now, BuildOps / ServiceTitan later) and every endpoint, type, and UI component the frontend needs to wire it up.

Base URL: `VITE_API_URL` (e.g. `http://localhost:3000`)
Auth header: `Authorization: Bearer <token>` on every endpoint below.

---

## Table of Contents

1. [Architecture & Concepts](#1-architecture--concepts)
2. [TypeScript Types](#2-typescript-types)
3. [API Functions to Add](#3-api-functions-to-add)
4. [Endpoint Reference](#4-endpoint-reference)
5. [Settings Page — CRM Integrations Section](#5-settings-page--crm-integrations-section)
6. [Customers / Jobs / Appointments / Technicians Browser Pages](#6-customers--jobs--appointments--technicians-browser-pages)
7. [Sync Triggers, Live Progress & Status](#7-sync-triggers--status)
   - 7.1 [Manual sync UX — replace the blocking call](#71-manual-sync-ux--replace-the-blocking-call)
   - 7.2 [Live progress — the SSE event stream](#72-live-progress--the-sse-event-stream)
   - 7.3 [Showing rows live, mid-sync](#73-showing-rows-live-while-the-sync-is-still-running)
   - 7.4 [Automatic sync](#74-automatic-sync-no-frontend-action)
8. [Frontend Checklist](#8-frontend-checklist)

---

## 1. Architecture & Concepts

**One backend abstraction, many CRMs.** Every CRM (ServiceTrade today, BuildOps / ServiceTitan later) implements the same `CrmProvider` interface on the backend. The frontend talks to a uniform set of endpoints, namespaced by provider slug:

```
/integrations/servicetrade/*
/integrations/buildops/*       ← future
/integrations/servicetitan/*   ← future
```

**Two-layer data model.**
- **Raw tables** (`servicetrade_customers`, `servicetrade_jobs`, `servicetrade_appointments`, `servicetrade_technicians`) hold lossless ServiceTrade payloads. The frontend can list these to give admins a "what we synced" view.
- **Platform tables** (`customers`, `jobs`, `appointments`, `technicians`) are the normalized rows used by the call scheduler and dashboard. ServiceTrade-sourced rows have `source: 'servicetrade'` and `external_ref: <serviceTradeId>`.

**Sync runs in two steps:**
1. `POST /integrations/servicetrade/sync` pulls from the API and writes to the raw tables.
2. The same call also normalizes the raw rows into the platform tables.

Both happen in one HTTP call from the user's perspective. A scheduled cron runs the same sync every 6 hours so admins don't need to manually refresh.

**Credentials are per-company.** The connect form accepts the company's ServiceTrade username + password. The backend logs in, captures the `PHPSESSID` cookie, and stores **only the cookie** (never the password). The cookie persists indefinitely until ServiceTrade invalidates it — no periodic re-auth needed.

---

## 2. TypeScript Types

Create `src/types/integration.ts`:

```typescript
export type CrmSlug = 'servicetrade' | 'buildops' | 'servicetitan';

export interface IntegrationStatus {
  connected: boolean;
  hasCredentials: boolean;
  username?: string | null;
  user?: {                 // when connected
    id: number;
    firstName: string;
    lastName: string;
    email: string;
  };
  lastSyncAt?: string | null;
  lastSyncStatus?: 'success' | 'failed' | null;
  lastSyncError?: string | null;
  message?: string;
}

export interface SyncResult {
  success: boolean;
  counts?: {
    customers?: number;
    jobs?: number;
    appointments?: number;
    technicians?: number;
    normalized?: {
      customers?: number;
      jobs?: number;
      appointments?: number;
      technicians?: number;
    };
  };
  error?: string;
}
```

Create `src/types/servicetrade.ts` for the raw shapes returned by the list endpoints:

```typescript
export interface STCustomer {
  id: number;
  company_id: number;
  servicetrade_id: number;
  full_name: string | null;
  email: string | null;
  phone: string | null;
  address_line1: string | null;
  city: string | null;
  state: string | null;
  zipcode: string | null;
  country: string;
  is_active: boolean;
  payload: Record<string, unknown>;   // lossless raw payload
  created_at: string;
  updated_at: string;
}

export interface STJob {
  id: number;
  company_id: number;
  servicetrade_id: number;
  servicetrade_customer_id: number | null;
  title: string | null;
  description: string | null;
  job_type: string | null;
  status: string | null;
  scheduled_date: string | null;
  scheduled_window_start: string | null;
  scheduled_window_end: string | null;
  is_active: boolean;
  payload: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface STAppointment {
  id: number;
  company_id: number;
  servicetrade_id: number;
  servicetrade_job_id: number | null;
  servicetrade_technician_id: number | null;
  status: string | null;
  scheduled_start: string | null;
  scheduled_end: string | null;
  payload: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface STTechnician {
  id: number;
  company_id: number;
  servicetrade_id: number;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  is_active: boolean;
  payload: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface PaginatedList<T> {
  customers?: T[];
  jobs?: T[];
  appointments?: T[];
  technicians?: T[];
  pagination?: {
    page: number;
    perPage: number;
    total: number;
    totalPages: number;
  };
}
```

---

## 3. API Functions to Add

Add to `src/lib/auth-api.ts`:

```typescript
// ── ServiceTrade — credentials & session ─────────────────────────────────────

export async function connectServiceTrade(
  token: string,
  body: { username: string; password: string; metadata?: Record<string, unknown> }
): Promise<{ connected: boolean; user?: object; error?: string }>;

export async function getServiceTradeStatus(token: string): Promise<IntegrationStatus | null>;

export async function disconnectServiceTrade(token: string): Promise<{ ok: boolean; error?: string }>;

// ── ServiceTrade — sync ──────────────────────────────────────────────────────

export async function runServiceTradeSync(
  token: string,
  opts?: { full?: boolean }
): Promise<SyncResult | null>;

// ── ServiceTrade — list raw rows ─────────────────────────────────────────────

export async function getSTCustomers(
  token: string,
  params?: { includeInactive?: boolean; page?: number; perPage?: number }
): Promise<{ customers: STCustomer[]; pagination: PaginatedList<STCustomer>['pagination'] } | null>;

export async function getSTJobs(
  token: string,
  params?: { customerId?: number; page?: number; perPage?: number }
): Promise<{ jobs: STJob[] } | null>;

export async function getSTAppointments(
  token: string,
  params?: { jobId?: number; page?: number; perPage?: number }
): Promise<{ appointments: STAppointment[] } | null>;

export async function getSTTechnicians(
  token: string,
  params?: { includeInactive?: boolean }
): Promise<{ technicians: STTechnician[] } | null>;
```

All functions follow the existing `auth-api.ts` patterns — JWT in `Authorization` header, JSON body for POST, return `null` on non-2xx.

---

## 4. Endpoint Reference

All endpoints below are mounted under `/integrations/servicetrade/*` and require app authentication (JWT).

### 4.1 `POST /integrations/servicetrade/credentials`

Log into ServiceTrade with username + password. The password is **never stored** — only the resulting session cookie (`PHPSESSID=…`) is persisted.

```json
// Request
{
  "username": "ops@acme.com",
  "password": "********",
  "metadata": { "primary_office": "Atlanta" }   // optional — merged into stored metadata
}

// Response 200
{
  "connected": true,
  "user": { "id": 9123, "firstName": "Ops", "lastName": "Manager", "email": "ops@acme.com" },
  "message": "Connected to ServiceTrade"
}

// Response 400
{ "error": "username and password are required" }

// Response 403
{ "connected": false, "error": "Invalid ServiceTrade credentials" }
```

### 4.2 `GET /integrations/servicetrade/status`

Check the current connection state. Returns whether credentials exist, whether the cookie is still valid, **and whether a sync is in flight right now**.

> **Corrected 2026-08-10.** An earlier version of this section showed
> `username` and top-level `lastSyncAt` / `lastSyncStatus`. The endpoint does
> not return those. Sync fields live under a nested `sync` object, shown below.
> If your code reads `status.lastSyncAt`, it has been reading `undefined`.

```json
// Response — connected
{
  "connected": true,
  "hasCredentials": true,
  "user": { "id": 9123, "firstName": "Ops", "lastName": "Manager", "email": "ops@acme.com" },
  "sync": {
    "syncing": true,                       // a run is in flight NOW
    "currentState": "normalizing",         // null unless syncing
    "runId": "1287",                       // null unless syncing — subscribe to this
    "startedAt": "2026-08-10T11:47:37.000Z",
    "lastSyncAt": "2026-08-10T10:12:04.000Z",
    "lastSyncStatus": "success",           // "success" | "failed" | null
    "lastSyncError": null
  }
}

// Response — has credentials but session expired
{
  "connected": false,
  "hasCredentials": true,
  "username": "ops@acme.com",
  "message": "ServiceTrade session invalid. Reconnect with username and password."
}

// Response — never connected
{
  "connected": false,
  "hasCredentials": false,
  "message": "No ServiceTrade connection. Connect with username and password."
}
```

Use `sync.lastSyncStatus` / `sync.lastSyncAt` to render a "Last synced …" caption next to the connection status.

**`sync.syncing` is the single most important field for the live view.** It is derived from `engine_runs`, not from the saved cursor, so it is true for a run started by *anything* — this browser tab, another admin, or the hourly cron. Poll `/status` on page load and use it to decide whether to show the "importing" state described in §7.2. Without it, a user who reloads mid-sync sees a half-empty account with no explanation.

### 4.3 `DELETE /integrations/servicetrade/session`

Disconnect — clears the stored cookie. Metadata (username, custom fields) is preserved so the user can reconnect with one click.

```json
// Response 200
{ "ok": true, "message": "ServiceTrade session closed" }
```

### 4.4 `POST /integrations/servicetrade/sync?full=true`

Run a sync. `full=true` ignores cursors and re-pulls every record; without it the backend pulls only what changed since `last_sync_at`.

The same call also **normalizes** raw rows into the platform tables (`customers`, `jobs`, `appointments`, `technicians`), so triggering this is the only way a user needs to refresh data.

```json
// Response 200
{
  "success": true,
  "counts": {
    "customers": 24,
    "technicians": 8,
    "jobs": 56,
    "appointments": 73,
    "normalized": { "customers": 24, "technicians": 8, "jobs": 56, "appointments": 73 }
  }
}

// Response 400 — no credentials
{ "error": "ServiceTrade not connected" }
```

#### ⚠️ Do not use this blocking form for a full sync

The response above only arrives when the run *finishes*. The backend waits at most **4 minutes** (`waitForRun`, `src/routes/servicetrade.js`) and then returns an error — but the sync itself **keeps running in the background and normally succeeds**.

A cold company's first full sync was measured at **~9–10 minutes**. So on exactly the accounts that matter most, the current blocking flow shows the user **"Sync failed"** while the data is, in fact, loading correctly. Reloading then shows a half-populated account, which reads as data loss. This is the main reason frontend changes are needed.

**Use `?stream=true` instead** — it returns immediately with a run id and an SSE URL:

```json
// POST /integrations/servicetrade/sync?full=true&stream=true  → 202 Accepted
{
  "runId": "1287",
  "kind": "crm_sync",
  "streamToken": "eyJhbGciOi…",
  "streamUrl": "/engines/1287/stream?token=eyJhbGciOi…",
  "snapshotUrl": "/engines/1287"
}
```

Query params: `full=true` (ignore cursors), `stream=true` (recommended), `range=week|month|3month` (default `month`, scopes the service-request window).

The blocking form is kept only for back-compat with the existing button. Keep it *only* for incremental syncs on already-populated accounts, where runs are short.

UX: see §7 — the "Sync now" button should now open a live progress view rather than a spinner that can time out.

### 4.5 `GET /integrations/servicetrade/customers`

List synced customers (from the `servicetrade_customers` raw table). Use this on the CRM browser page to show what's actually in the platform.

| Query | Type | Default |
|---|---|---|
| `includeInactive` | `true` \| `false` | `false` |
| `page` | int | `1` |
| `perPage` | int (max 200) | `50` |

```json
{
  "customers": [
    {
      "id": 1, "company_id": 4, "servicetrade_id": 70123,
      "full_name": "Acme HVAC", "email": "...", "phone": "+14045550100",
      "address_line1": "...", "city": "Atlanta", "state": "GA", "zipcode": "30301",
      "country": "US", "is_active": true,
      "payload": { ...raw ST company payload... },
      "created_at": "...", "updated_at": "..."
    }
  ],
  "pagination": { "page": 1, "perPage": 50, "total": 24, "totalPages": 1 }
}
```

### 4.6 `GET /integrations/servicetrade/jobs?customerId=70123`

| Query | Type | Default |
|---|---|---|
| `customerId` | int (ServiceTrade customer id) | — (all) |
| `page` / `perPage` | — | `1` / `50` |

```json
{
  "jobs": [
    {
      "id": 1, "company_id": 4, "servicetrade_id": 880001,
      "servicetrade_customer_id": 70123,
      "title": "Annual HVAC inspection",
      "description": "...",
      "job_type": "inspection",
      "status": "scheduled",
      "scheduled_date": "2026-06-10",
      "scheduled_window_start": "2026-06-10T13:00:00.000Z",
      "scheduled_window_end":   "2026-06-10T15:00:00.000Z",
      "is_active": true,
      "payload": { ... }
    }
  ]
}
```

### 4.7 `GET /integrations/servicetrade/appointments?jobId=880001`

| Query | Type | Default |
|---|---|---|
| `jobId` | int (ServiceTrade job id) | — (all) |
| `page` / `perPage` | — | `1` / `50` |

```json
{
  "appointments": [
    {
      "id": 1, "company_id": 4, "servicetrade_id": 910001,
      "servicetrade_job_id": 880001,
      "servicetrade_technician_id": 5021,
      "status": "scheduled",
      "scheduled_start": "2026-06-10T13:00:00.000Z",
      "scheduled_end":   "2026-06-10T15:00:00.000Z",
      "payload": { ... }
    }
  ]
}
```

### 4.8 `GET /integrations/servicetrade/technicians?includeInactive=false`

```json
{
  "technicians": [
    {
      "id": 1, "company_id": 4, "servicetrade_id": 5021,
      "first_name": "Ryan", "last_name": "Brooks",
      "email": "ryan@acme.com", "phone": "+14045552001",
      "is_active": true,
      "payload": { ... }
    }
  ]
}
```

---

## 5. Settings Page — CRM Integrations Section

Add a new **"CRM Integrations"** section to `SettingsPage.tsx` (after Retell Setup, before Call Settings):

```
CRM Integrations
─────────────────────────────────────────────────────────────────
  Connect your field-service CRM so Clara can automatically pull
  customers, jobs, appointments, and technicians.

  ┌──────────────────────────────────────────────────────────┐
  │  🔌  ServiceTrade                          ✅ Connected   │
  │  ops@acme.com                                              │
  │  Last synced: 2 minutes ago (success)                      │
  │                                                            │
  │  [ Sync now ]  [ Full re-sync ]  [ Disconnect ]            │
  └──────────────────────────────────────────────────────────┘

  ┌──────────────────────────────────────────────────────────┐
  │  🔌  BuildOps                              ⚪ Coming soon │
  └──────────────────────────────────────────────────────────┘

  ┌──────────────────────────────────────────────────────────┐
  │  🔌  ServiceTitan                          ⚪ Coming soon │
  └──────────────────────────────────────────────────────────┘
─────────────────────────────────────────────────────────────────
```

**State machine for the ServiceTrade card:**

| State | Trigger | UI |
|---|---|---|
| **Disconnected, no credentials** | `getServiceTradeStatus().hasCredentials === false` | Show "Connect" button → opens modal with username / password fields |
| **Disconnected, session expired** | `connected === false && hasCredentials === true` | Show "Reconnect" + warning banner; clicking opens same modal (prefilled username) |
| **Connected, no sync yet** | `connected === true && lastSyncAt === null` | Show "Sync now" button prominently |
| **Connected, last sync succeeded** | `lastSyncStatus === 'success'` | Show ✅ status, sync timestamps, both sync buttons |
| **Connected, last sync failed** | `lastSyncStatus === 'failed'` | Show ⚠ banner with `lastSyncError`, "Retry sync" button |

**Connect modal:**

```tsx
function ServiceTradeConnectModal({ open, onClose, onSuccess }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleConnect() {
    setSubmitting(true);
    const token = getStoredToken();
    const result = await connectServiceTrade(token!, { username, password });
    setSubmitting(false);
    if (result?.connected) {
      toast.success(`Connected to ServiceTrade as ${result.user?.firstName ?? username}`);
      onSuccess();
      onClose();
    } else {
      toast.error(result?.error ?? 'Failed to connect');
    }
  }
  // ... render form
}
```

**Disconnect confirmation:** Show a `confirm()` dialog warning that disconnecting won't delete already-synced data but new syncs will stop until reconnected.

---

## 6. Customers / Jobs / Appointments / Technicians Browser Pages

Optional but recommended: a dedicated **"CRM Browser"** page at `/crm/servicetrade` that lets admins inspect the raw synced data. Useful for debugging when a customer asks "why isn't this job in Clara?".

**Layout:** four tabs — Customers, Jobs, Appointments, Technicians — each rendering a paginated table from the matching list endpoint.

```
CRM Browser — ServiceTrade
────────────────────────────────────────────────────────────────
[ Customers (24) ] [ Jobs (56) ] [ Appointments (73) ] [ Technicians (8) ]

┌──────────────────────────────────────────────────────────────┐
│  Acme HVAC                              ID: 70123              │
│  +14045550100 · ops@acme.com                                   │
│  Atlanta, GA 30301                                             │
│  [ View jobs (12) ]                                            │
└──────────────────────────────────────────────────────────────┘
...
```

**Routing:**
```tsx
<Route path="/crm/servicetrade" element={<CRMBrowserPage provider="servicetrade" />} />
```

**Filter linkage:**
- Clicking a customer row → switches to the Jobs tab with `customerId` filter applied (`getSTJobs({ customerId: 70123 })`)
- Clicking a job row → switches to the Appointments tab with `jobId` filter applied

This is a **read-only** debug view — no edit/delete from this page. All mutations go through the user's actual platform pages (`/inspections`, `/customers`).

---

## 7. Sync Triggers & Status

### 7.1 Manual sync UX — replace the blocking call

The old flow below **is the thing to change**. It blocks on a request that gives up after 4 minutes while a full sync takes ~9–10, so it reports failure on a successful sync (see §4.4).

```tsx
// ❌ OLD — times out and shows "Sync failed" on any cold/full sync
async function handleSync(full: boolean) {
  setSyncing(true);
  const result = await runServiceTradeSync(token!, { full }); // blocks up to 4 min
  setSyncing(false);
  if (result?.success) { toast.success(`Synced ${result.counts.customers} customers, …`); }
  else { toast.error(result?.error ?? 'Sync failed'); }     // ← fires while sync is fine
}
```

```tsx
// ✅ NEW — start, then watch. Never blocks, never false-fails.
async function handleSync(full: boolean) {
  const { runId, streamUrl } = await runServiceTradeSync(token!, { full, stream: true });
  setActiveRunId(runId);        // render the live panel in §7.2
  subscribeToRun(streamUrl);    // EventSource
}
```

Keep the button enabled-but-labelled rather than disabled-with-spinner: a sync can be started by the cron or another admin, so "syncing" is a *server* state you observe (`status.sync.syncing`), not a local boolean you own.

### 7.2 Live progress — the SSE event stream

`GET /engines/:runId/stream?token=…` is a standard `EventSource` feed. The token comes from the sync response; **it is a query param, not a header**, because `EventSource` cannot set headers.

```ts
const es = new EventSource(`${API_URL}${streamUrl}`);   // streamUrl already contains ?token=
es.addEventListener('snapshot',    e => applySnapshot(JSON.parse(e.data)));
es.addEventListener('state',       e => setStage(JSON.parse(e.data).state));
es.addEventListener('fetched',     e => bumpFetched(JSON.parse(e.data)));      // {entity, count}
es.addEventListener('entity_done', e => bumpNormalized(JSON.parse(e.data)));   // {entity, count}
es.addEventListener('done',   e => { es.close(); refetchEverything(); });
es.addEventListener('failed', e => { es.close(); toast.error(JSON.parse(e.data).error); });
```

`snapshot` is always sent first and reflects current state, so a client that connects late (or reconnects) is immediately correct — you do not need to replay.

**Stages, in the order they actually fire.** Render these as a checklist; the two `fetching_job_*` stages are the long ones on a cold account.

| `state` | What's happening |
|---|---|
| `authenticating` | logging in to ServiceTrade |
| `fetching_jobs` | paged job pull — also brings customers, locations, contacts, users, projects |
| `fetching_job_details` | one request per job (the slowest stage) |
| `fetching_appointments` | one request per job |
| `fetching_job_comments` | one request per job — feeds confirmation inference |
| `fetching_service_requests` | service-request window (`range`) |
| `normalizing` | raw → platform tables |
| `done` / `failed` | terminal |

There is **no** `fetching_customers` or `fetching_technicians` state, despite what older docs said — those entities are pulled inside `fetching_jobs` and report via `fetched` only.

`fetched` entities (raw layer): `jobs`, `customers`, `locations`, `contacts`, `users`, `projects`, `appointments`, `technicians`, `appointment_service_requests`, `job_comments`.

`entity_done` entities (platform layer), emitted in this order:
`customers`, `contacts`, `offices`, `tags`, `locations`, `technicians`, `crm_users`, `projects`, `jobs`, `appointments`, `service_lines`, `deficiencies`, `change_orders`, `contracts`, `service_recurrences`, `service_requests`, `appointment_services`.

> Two event types you may see referenced elsewhere — `progress` and `warning` — are **not emitted** by this engine. Don't build UI that waits for them.

### 7.3 Showing rows live, while the sync is still running

Nothing wraps the sync in a transaction, so **every batch commits as it completes** and the platform tables fill up progressively. The frontend gets a live view for free: re-fetch your normal list endpoints while `syncing` is true.

Recommended: re-fetch open lists on each `entity_done` for an entity that list depends on, or simply poll every ~3–5s while syncing. Don't poll faster — these are multi-MB reads over a pooled connection.

Because `entity_done` fires in the order above, **jobs land before appointments**. A job can briefly exist with zero visits. Render that as *loading*, not as "no appointments scheduled".

**The one rule that matters:** while `sync.syncing` is true, an empty or short list means *not finished yet*, not *nothing there*. Every empty state must be suppressed in favour of "Importing…". Getting this wrong is what makes a working sync look like data loss.

```tsx
if (sync?.syncing) return <ImportingState stage={sync.currentState} startedAt={sync.startedAt} />;
if (!rows.length)  return <EmptyState />;   // only trustworthy when NOT syncing
```

### 7.4 Automatic sync (no frontend action)

A backend cron (`/admin/crm-sync`, **hourly**) runs the same sync for every connected company, so data stays fresh with no clicks. The status card shows the most recent sync regardless of source.

Consequence for the UI: a sync can begin without any user action. Treat `status.sync.syncing` as the source of truth on every page load — and if it is true but you have no `runId` subscription (because *you* didn't start it), you can still subscribe using `sync.runId` via `GET /engines/:runId/stream`, or just poll `/status`.

Incremental syncs are now much cheaper than they used to be (the normalize phase only reprocesses rows changed since the last run — measured 32.0s → 16.5s on a mid-size account), so the hourly cron is mostly invisible. Full re-syncs are still minutes long.

---

## 8. Frontend Checklist

### Live data view — the changes required by this revision
- [ ] **Fix `getServiceTradeStatus()` types** — sync fields are nested under `sync`, not top-level. Any `status.lastSyncAt` read today is `undefined` (§4.2).
- [ ] **Pass `stream: true`** from `runServiceTradeSync()` and handle the `202` shape (`runId`, `streamUrl`) instead of awaiting `{success, counts}` (§4.4).
- [ ] **Stop treating a full sync as a blocking call** — this is the bug: it false-fails after 4 min on a ~10 min sync (§4.4).
- [ ] **Add an `EventSource` subscription** keyed on `streamUrl`; handle `snapshot`, `state`, `fetched`, `entity_done`, `done`, `failed`. Token goes in the query string (§7.2).
- [ ] **Render the stage checklist** from the §7.2 table; drop any reference to `fetching_customers` / `fetching_technicians` (§7.2).
- [ ] **Suppress empty states while `sync.syncing`** — show "Importing…" instead. Highest-value item: this is what makes a working sync look like data loss (§7.3).
- [ ] **Poll `/status` on page load** and subscribe via `sync.runId` if a cron- or other-admin-started run is already in flight (§7.4).
- [ ] **Re-fetch open lists on relevant `entity_done`** (or poll 3–5s) so rows appear progressively (§7.3).
- [ ] **Treat a job with zero appointments as loading, not empty**, while syncing — jobs normalize before appointments (§7.3).

### Types
- [ ] Create `src/types/integration.ts` — `CrmSlug`, `IntegrationStatus`, `SyncResult`
- [ ] Create `src/types/servicetrade.ts` — `STCustomer`, `STJob`, `STAppointment`, `STTechnician`, `PaginatedList<T>`

### API layer
- [ ] Add `connectServiceTrade()`, `getServiceTradeStatus()`, `disconnectServiceTrade()` to `src/lib/auth-api.ts`
- [ ] Add `runServiceTradeSync()`
- [ ] Add `getSTCustomers()`, `getSTJobs()`, `getSTAppointments()`, `getSTTechnicians()`

### Settings page
- [ ] Create `src/components/settings/CRMIntegrationsCard.tsx`
- [ ] Add it to `SettingsPage.tsx` after the Retell Setup section
- [ ] Implement the 5 connection states (disconnected, expired, connected-no-sync, connected-ok, connected-failed)
- [ ] Create `src/components/settings/ServiceTradeConnectModal.tsx` (username + password form)
- [ ] Show last-synced timestamp using `formatRelative(lastSyncAt, companyTz)` from the existing timezone helpers
- [ ] BuildOps + ServiceTitan tiles in a disabled "Coming soon" state
- [ ] "Disconnect" confirmation dialog explaining what happens

### CRM Browser page (recommended)
- [ ] Add `/crm/servicetrade` route in `App.tsx`
- [ ] Create `src/pages/CRMBrowserPage.tsx` with 4 tabs
- [ ] Create `src/components/crm/STCustomersTable.tsx`
- [ ] Create `src/components/crm/STJobsTable.tsx` with `customerId` filter pill
- [ ] Create `src/components/crm/STAppointmentsTable.tsx` with `jobId` filter pill
- [ ] Create `src/components/crm/STTechniciansTable.tsx`
- [ ] Click-through linkage: customer → jobs tab, job → appointments tab

### Polish
- [ ] After a successful sync, invalidate the existing `customers`, `jobs`, `appointments`, `technicians` queries (the platform-side TanStack queries) so the regular pages refresh too
- [ ] If a sync fails with auth error, redirect the user to the CRM Integrations card with the reconnect modal pre-opened
- [ ] Use the existing `formatRelative` / `formatDateTime` helpers (`src/lib/timezone.ts`) for all timestamp displays — never `toLocaleString()` directly

### Future-proofing for BuildOps / ServiceTitan
- [ ] When designing components, parameterize on `CrmSlug` where reasonable (e.g. `CRMBrowserPage<{ provider: CrmSlug }>`) so adding BuildOps later is a 30-minute job, not a rewrite
- [ ] Keep the connection logic generic — `connectCRM(slug, credentials)` style — so the same modal can serve all providers once they're added
