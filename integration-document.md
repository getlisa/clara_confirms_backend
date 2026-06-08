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
7. [Sync Triggers & Status](#7-sync-triggers--status)
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

Check the current connection state. Returns whether credentials exist and whether the cookie is still valid.

```json
// Response — connected
{
  "connected": true,
  "hasCredentials": true,
  "username": "ops@acme.com",
  "user": { "id": 9123, "firstName": "Ops", "lastName": "Manager", "email": "ops@acme.com" },
  "lastSyncAt": "2026-06-05T11:00:00.000Z",
  "lastSyncStatus": "success"
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

Use the `lastSyncStatus` / `lastSyncAt` fields to render a "Last synced …" caption next to the connection status.

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

UX: show a spinner on the "Sync now" button; on success, surface the count toast (`Synced 24 customers, 56 jobs, …`) and refetch any open lists.

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

### Manual sync UX

The **"Sync now"** button on the CRM card calls `POST /integrations/servicetrade/sync` (incremental). The **"Full re-sync"** button passes `?full=true`.

```tsx
async function handleSync(full: boolean) {
  setSyncing(true);
  const token = getStoredToken();
  const result = await runServiceTradeSync(token!, { full });
  setSyncing(false);
  if (result?.success) {
    const c = result.counts ?? {};
    toast.success(
      `Synced ${c.customers ?? 0} customers, ${c.jobs ?? 0} jobs, ` +
      `${c.appointments ?? 0} appointments, ${c.technicians ?? 0} technicians.`
    );
    refetchStatus();
  } else {
    toast.error(result?.error ?? 'Sync failed');
  }
}
```

### Automatic sync (no frontend action)

A backend cron (`POST /admin/crm-sync` every 6 hours) runs the same sync for every connected company. Users don't need to click anything — the data stays fresh on its own. The status card always shows the most recent sync regardless of source (manual or cron).

---

## 8. Frontend Checklist

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
