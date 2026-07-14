# Workflow Engine — Frontend Integration Guide

This doc explains how the frontend talks to the backend's workflow-engine
framework: starting runs, subscribing to live state, and rendering the
two engines we ship today (`crm_sync`, `scheduler_run`).

---

## 1. Concept

A **workflow engine** is a small state machine running in the backend whose
state transitions are streamed to the browser over Server-Sent Events. Each
execution creates one row in `engine_runs` (durable, audit-friendly) and one
SSE channel `/engines/:runId/stream` (live tail).

**Why SSE instead of polling**

- One-way push from server → client; no WebSocket overhead.
- Native browser support via `EventSource`.
- `Last-Event-ID` reconnect = automatic resume on flaky networks.

**Why DB-backed**

- Vercel function timeouts will drop the socket eventually. The frontend
  reconnects and the backend replays missed events from `state_history`.
- Closing the browser tab does not interrupt the run.
- "Recent runs" list works the next day, not just in-session.

---

## 2. Engines available today

| Kind | What it does | Where it's triggered |
|---|---|---|
| `crm_sync` | Pulls customers/jobs/appointments/technicians from ServiceTrade, normalizes into platform tables | Settings → ServiceTrade card "Sync now" / "Full re-sync" |
| `scheduler_run` | Iterates the company's enabled call-triggers and queues calls (or surfaces `MISSING_PHONE` todos) | Scheduler page "Run now" button |

More engines (`buildops_sync`, `service_titan_sync`, future automations) plug
in with the same routes — no frontend changes other than mapping the new
`kind` string.

---

## 3. HTTP API

All routes are mounted under `/engines`. The control plane (start, list,
snapshot) uses normal JWT auth. The SSE stream uses a **signed query-string
token** because browser `EventSource` cannot set headers.

### 3.1 Start a run

```http
POST /engines/:kind
Authorization: Bearer <jwt>
Content-Type: application/json

{ "full": true }   // engine-specific options, forwarded verbatim
```

Engine-specific bodies:

| Kind | Body |
|---|---|
| `crm_sync` | `{ provider?: "servicetrade", full?: boolean }` |
| `scheduler_run` | `{}` (always scoped to caller's company, always bypasses auto_schedule flag) |

**Response 201**

```json
{
  "runId": "1287",
  "kind": "crm_sync",
  "streamToken": "eyJydW5JZCI6IjEyODciLCJjb21wYW55SWQiOjQsImV4cCI6MTcyOTEyMzQ1Nn0.abc123…",
  "streamUrl": "/engines/1287/stream?token=eyJydW5JZCI6...",
  "snapshotUrl": "/engines/1287"
}
```

`streamToken` is a short-lived (30 min) HMAC, bound to `(runId, companyId)`.
Pass it on the SSE URL; do NOT send the JWT to `/stream`.

### 3.2 Snapshot

```http
GET /engines/:runId
Authorization: Bearer <jwt>
```

Returns the current `engine_runs` row including `state_history`. Use this:
- For poll-fallback when SSE is unavailable.
- For the "Recent runs" detail view (after a run is done).

```json
{
  "id": "1287",
  "kind": "crm_sync",
  "current_state": "normalizing",
  "status": "running",
  "last_event_seq": 42,
  "state_history": [
    {"seq":1,"ts":"2026-06-11T17:55:00.000Z","type":"started","state":"started","payload":{...}},
    {"seq":2,"ts":"...","type":"state","state":"authenticating","payload":{}},
    ...
  ],
  "result": null,
  "error": null,
  "started_at": "...",
  "finished_at": null
}
```

### 3.3 List recent runs

```http
GET /engines?kind=crm_sync&limit=20
Authorization: Bearer <jwt>
```

```json
{
  "runs": [
    { "id": "1287", "kind": "crm_sync", "status": "done", "started_at": "...", "finished_at": "...", "current_state": "done", "result": {"customers": 234, "jobs": 88, ...}, "last_event_seq": 64 },
    { "id": "1286", "kind": "crm_sync", "status": "failed", "error": "ServiceTrade not connected", ... }
  ]
}
```

### 3.4 SSE stream

```http
GET /engines/:runId/stream?token=<streamToken>
[Last-Event-ID: <seq>]   ← optional, sent automatically by EventSource on reconnect
```

Event protocol:

```
event: snapshot           ← always first; current_state + last_event_seq
id: 42
data: {"id":1287,"kind":"crm_sync","current_state":"normalizing","status":"running","last_event_seq":42,"started_at":"..."}

event: state              ← state transition
id: 43
data: {"state":"normalizing","ts":"..."}

event: warning            ← sub-event within current state
id: 44
data: {"state":"normalizing","ts":"...","entity":"customer","code":"missing_phone","subject_name":"Acme HQ","message":"…"}

event: done               ← terminal
id: 65
data: {"state":"done","ts":"...","result":{"customers":234,"jobs":88,...}}
```

After `done` or `failed`, the server closes the response. The client should
not reconnect.

The connection sends a comment heartbeat (`: ping`) every 15 seconds to keep
proxies from idling out.

### 3.5 Legacy blocking sync (back-compat)

The original `POST /integrations/servicetrade/sync` still works and still
returns the legacy `{success, counts}` shape (for old clients that haven't
migrated). It now also returns a `runId` so a user could inspect the run
afterwards via `GET /engines/:runId`.

To get the streaming behavior on the same endpoint, pass `?stream=true` —
the response becomes a `202` with `{runId, streamToken, streamUrl}` identical
to `POST /engines/crm_sync`.

Recommendation: new UI uses `POST /engines/crm_sync` directly.

---

## 4. Event types by engine

### 4.1 `crm_sync`

| `event:` | `state` | Payload | Meaning |
|---|---|---|---|
| `snapshot` | (any) | run snapshot | sent first; reflect current state into UI |
| `started` | `started` | `{kind, companyId, startedAt}` | run created |
| `state` | `authenticating` | `{provider}` | logging in to CRM |
| `state` | `fetching_customers` | `{full}` | pulling customer pages |
| `fetched` | (n/a) | `{entity, count}` | a fetch stage finished |
| `state` | `fetching_technicians` | `{}` | — |
| `state` | `fetching_jobs` | `{full}` | — |
| `state` | `normalizing` | `{}` | writing into platform tables |
| `entity_done` | (n/a) | `{entity, count}` | a normalize stage finished |
| `warning` | (n/a) | `{entity, code, subject_name, external_ref, message}` | row inserted with caveat (missing phone, unresolved FK, …) |
| `done` | `done` | `{result: {counts: {customers, jobs, appointments, technicians, normalized: {...}}}}` | success |
| `failed` | `failed` | `{error, partialResult?}` | error |

Warning codes from the CRM-sync normalizer:
`missing_phone`, `missing_name`, `no_customer`, `unresolved_customer`,
`no_job`, `unresolved_job`, `unresolved_technician`, `missing_scheduled_start`.

### 4.2 `scheduler_run`

| `event:` | `state` | Payload | Meaning |
|---|---|---|---|
| `snapshot` | (any) | run snapshot | initial |
| `started` | `started` | `{kind, companyId, startedAt}` | run created |
| `state` | `loading_triggers` | `{company_id}` | reading enabled call-triggers |
| `state` | `running_trigger` | `{trigger_type, company_id}` | starting a trigger pass |
| `trigger_done` | (n/a) | `{trigger_type, company_id, scheduled, skipped}` | trigger pass finished |
| `trigger_error` | (n/a) | `{trigger_type, company_id, error}` | one trigger threw — others continue |
| `done` | `done` | `{result: {totals: {created, skipped}}}` | run complete |
| `failed` | `failed` | `{error}` | unrecoverable failure |

Trigger types correspond to `call_trigger_configs.trigger_type`:
`scheduled_unconfirmed`, `quotation_pending`, `open_job_due_soon`,
`technician_unconfirmed`.

---

## 5. Suggested frontend abstraction

A single hook handles connect / replay / poll-fallback. Below is a sketch in
TypeScript-ish pseudocode — adapt to your stack (React Query, Zustand, etc).

```ts
// api/engines.ts ────────────────────────────────────────────────────────────
export type EngineKind = 'crm_sync' | 'scheduler_run';

export type EngineRun = {
  id: string;
  kind: EngineKind;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  current_state: string;
  last_event_seq: number;
  result?: any;
  error?: string | null;
  started_at: string;
  finished_at?: string | null;
  state_history?: EngineEvent[]; // present on snapshot endpoint only
};

export type EngineEvent = {
  seq: number;
  ts: string;
  type: string;     // 'state' | 'warning' | 'fetched' | 'entity_done' | 'trigger_done' | ...
  state: string;
  payload: Record<string, any>;
};

export async function startEngine(kind: EngineKind, body?: object): Promise<{
  runId: string; kind: EngineKind; streamToken: string; streamUrl: string; snapshotUrl: string;
}> {
  const r = await api.post(`/engines/${kind}`, body ?? {});
  return r.data;
}

export async function getEngineRun(runId: string): Promise<EngineRun> {
  return (await api.get(`/engines/${runId}`)).data;
}

export async function listEngineRuns(kind: EngineKind, limit = 20): Promise<EngineRun[]> {
  return (await api.get(`/engines`, { params: { kind, limit } })).data.runs;
}

// hooks/useEngineRun.ts ─────────────────────────────────────────────────────
export function useEngineRun(handle: { runId: string; streamUrl: string } | null) {
  const [run, setRun] = useState<EngineRun | null>(null);
  const [events, setEvents] = useState<EngineEvent[]>([]);
  const [isLive, setIsLive] = useState(false);

  useEffect(() => {
    if (!handle) return;
    const es = new EventSource(handle.streamUrl);
    setIsLive(true);

    es.addEventListener('snapshot', (e) => {
      const snap = JSON.parse((e as MessageEvent).data);
      setRun((r) => ({ ...(r ?? {}), ...snap }));
    });

    const onAny = (e: MessageEvent) => {
      const payload = JSON.parse(e.data);
      setEvents((evs) => [...evs, { seq: Number((e as any).lastEventId), type: e.type, ts: payload.ts, state: payload.state, payload }]);
      // Mirror current_state into the run for convenience
      if (payload.state) setRun((r) => r ? { ...r, current_state: payload.state, last_event_seq: Number((e as any).lastEventId) } : r);
    };
    ['state','started','fetched','entity_done','warning','trigger_done','trigger_error','done','failed']
      .forEach((t) => es.addEventListener(t, onAny as any));

    es.addEventListener('done',   () => { setIsLive(false); es.close(); });
    es.addEventListener('failed', () => { setIsLive(false); es.close(); });
    es.onerror = () => { setIsLive(false); /* EventSource auto-reconnects unless we close it */ };

    return () => { es.close(); setIsLive(false); };
  }, [handle?.runId]);

  return { run, events, isLive };
}
```

Important: `EventSource` automatically sends `Last-Event-ID` on reconnect.
The server replays from `state_history`, so the client doesn't need to
deduplicate by seq.

**Poll fallback** (when EventSource fails — corporate proxy, etc): if
`onerror` fires twice within ~10s, switch to polling `GET /engines/:runId`
every 2s and bail when `status !== "running"`. Optional for v1.

---

## 6. UI patterns

### 6.1 CRM Sync card (Settings page)

Today the "Sync now" button is a blocking action. Replace with:

1. User clicks **Sync now** or **Full re-sync** → call `startEngine('crm_sync', {full})`.
2. Replace the button row with a **progress stepper** keyed off `run.current_state`:
   - `authenticating` → "Signing in to ServiceTrade…"
   - `fetching_customers` / `fetching_jobs` / `fetching_appointments` / `fetching_technicians`
     → "Pulling {entity}…" (subscribe to `fetched` event for the count)
   - `normalizing` → progress bar across customers → technicians → jobs → appointments (subscribe to `entity_done`)
   - `done` → success banner with `result.counts`; "Last sync 2 minutes ago"
   - `failed` → red banner with `error`; **Retry** button (starts a fresh run)
3. A **warnings drawer** lists every `warning` event live. Group by `entity`,
   show a count badge on the entity tab in the CRM Browser.
4. After `done`, invalidate the platform queries (`customers`, `jobs`, etc.)
   so the rest of the UI reflects the new data.

### 6.2 Scheduler "Run now" (Scheduler page)

1. User clicks **Run scheduler now** → `startEngine('scheduler_run')`.
2. A live drawer/panel shows:
   - One row per trigger appearing as `running_trigger` events arrive.
   - On `trigger_done`, the row collapses to a one-liner: `scheduled_unconfirmed → 5 queued · 2 skipped`.
   - On `trigger_error`, the row shows the error in red but the run continues.
3. On `done`, show a totals chip: `Run complete · 12 calls queued · 4 todos created · 3 skipped`.
4. Invalidate the dashboard "todos" + "scheduled-calls" queries.

### 6.3 "Recent activity" list (anywhere)

`GET /engines?kind=crm_sync` or `/engines?kind=scheduler_run`.

| Started | Kind | Status | Duration | Detail |
|---|---|---|---|---|
| 17:42 today | CRM Sync | done | 12 s | 234 customers · 88 jobs · 156 appointments · 22 technicians |
| 17:30 today | Scheduler | done | 4 s | 12 queued · 4 todos · 3 skipped |
| 11:08 today | CRM Sync | failed | 2 s | ServiceTrade not connected |

Clicking a row opens a detail drawer that **replays** the run by fetching
`/engines/:runId` and rendering `state_history` (no SSE needed for finished
runs — the snapshot has everything).

---

## 7. Auth flow recap

```
Browser                Backend
  │                      │
  │  POST /engines/...   │  ← JWT in Authorization header
  ├─────────────────────▶│
  │                      │
  │   201 + streamToken  │
  │◀─────────────────────┤
  │                      │
  │  new EventSource(    │
  │    "/engines/X/      │  ← token in query string
  │     stream?token=…") │  ← EventSource cannot set headers
  ├─────────────────────▶│
  │                      │
  │  event: snapshot     │
  │  event: state ...    │
  │◀═════════════════════│
  │  ...                 │
  │  event: done         │
  │  (server closes)     │
  │                      │
```

**Token lifetime**: 30 minutes. Long enough for any run we ship. If a run
exceeds that and the SSE connection drops mid-run, calling `POST /engines/:kind`
again is wrong (starts a new run). Instead, the client should call
`/engines/:runId/stream` with a freshly minted token. We don't expose a
"mint token" endpoint yet — if needed later, add `POST /engines/:runId/token`.
For v1, runs are short enough.

---

## 8. Backwards compatibility

| Old contract | Still works? | Notes |
|---|---|---|
| `POST /integrations/servicetrade/sync` (blocking) | yes | Now internally goes through `crm_sync` engine. Response shape unchanged. Add `?stream=true` to opt into streaming. |
| `POST /scheduler/daily/manual` (blocking) | yes | Same — `?stream=true` opts in. |
| `GET /scheduler/run`, `/scheduler/daily`, `/admin/crm-sync` (cron) | yes | Untouched, no engine wrapping in the cron path. |

---

## 9. Frontend checklist

- [ ] Types in `src/types/engines.ts`: `EngineKind`, `EngineRun`, `EngineEvent`.
- [ ] API wrappers: `startEngine`, `getEngineRun`, `listEngineRuns`.
- [ ] `useEngineRun({runId, streamUrl})` hook with EventSource + reconnect.
- [ ] Settings → ServiceTrade card: replace blocking sync with engine UX
      (stepper + warnings drawer).
- [ ] Scheduler page: "Run now" → engine UX (live trigger feed + totals).
- [ ] Recent activity list (optional, can ship later).
- [ ] After `done`/`failed`, invalidate dependent queries:
      - `crm_sync` → `customers`, `jobs`, `appointments`, `technicians`.
      - `scheduler_run` → `scheduled-calls`, `todos`.

---

## 10. Future-proofing

- New engines (BuildOps, ServiceTitan, automation flows) appear via the same
  routes — only need to map the new `kind` string. Same hook works.
- Pause/resume/cancel is not in v1. When added, it will be
  `POST /engines/:runId/pause|resume|cancel` returning the updated snapshot;
  the SSE feed will emit a new `state` event for the transition.
- Multi-instance fan-out is not in v1. If we hit it, replace the in-memory
  broker with Postgres LISTEN/NOTIFY — no frontend change.

---

# Manual Call Trigger (`POST /calls/manual`)

This is a separate, non-SSE endpoint — not part of the workflow-engine
framework — but it lives in the same FE surface (the new "Call now" button
on customer/appointment/quotation rows). Documented here so the FE has one
source of truth.

## What it does

The Service Manager clicks "Call now" on a row in the UI. The backend
hydrates exactly what the scheduler would have hydrated for that call type,
queues a `scheduled_calls` row, and (by default) pokes the dispatcher to
fire it inside the same HTTP request. The UI does NOT need to know about
dynamic variables, addresses, office hours, or phone numbers.

**Manual phone override (new):** the caller may pass an optional `phone_number`
to dial a specific number. When present it **always wins over the target's
on-file number** — whether or not one exists. So it serves two purposes:
override the number even when the customer/technician already has one on file,
and rescue targets that have no number at all (which would otherwise return
`422 missing_phone`). The target (appointment/job/quotation) is still required —
it supplies the call context.

## Request

```http
POST /calls/manual
Authorization: Bearer <jwt>
Content-Type: application/json
```

```jsonc
{
  "trigger_type":   "scheduled_unconfirmed",
  // Exactly one of the following, matched to trigger_type:
  "appointment_id": 123,        // for scheduled_unconfirmed | technician_unconfirmed
  "job_id":         "456",      // for open_job_due_soon
  "quotation_id":   789,        // for quotation_pending

  "phone_number":   "(415) 520-1480", // optional — dial this number instead of the target's on-file number; normalized to E.164 server-side

  "immediate":      true,       // default true — dial now (poke dispatcher in-request)
  "force":          false,      // default false — bypass active-call dedup
  "scheduled_at":   "2026-06-12T15:00:00Z" // ignored when immediate=true
}
```

### trigger_type → target_id

| trigger_type | Required target field | Notes |
|---|---|---|
| `scheduled_unconfirmed` | `appointment_id` | confirms a customer for a scheduled appointment |
| `technician_unconfirmed` | `appointment_id` | confirms the assigned technician |
| `open_job_due_soon` | `job_id` | nudges a customer when a job has no appointment yet |
| `quotation_pending` | `quotation_id` | follows up on an unaccepted quote |

The actual `call_type` written to `scheduled_calls` (e.g. `customer_confirmation`) is looked up from the company's `call_trigger_configs` row for the given `trigger_type`. If the company has not configured that trigger (row missing), the request returns `400`.

### Optional `phone_number` override

| Field | Type | Notes |
|---|---|---|
| `phone_number` | `string` | Optional. When present, this number is dialed **instead of** the target's on-file number — it always takes precedence, even if a number already exists on file. Accepts US 10-digit, formatted (e.g. `(415) 520-1480`), or `+E.164` — the server normalizes via `toE164`. If it can't be normalized to a valid number, the request returns `400`. When omitted, the on-file number is used as before. |

## Responses

**201 Created** — call queued (and dialed if `immediate=true`)

```jsonc
{
  "ok": true,
  "status": 201,
  "scheduledCall": { /* full scheduled_calls row */ },
  "dialed": true,                   // present when immediate=true
  "retellCallId": "call_abc123..."  // present when dialed=true
}
```

When `immediate=true` and the dispatcher failed to claim the row in time
(rare), the response is still 201 with `dialed: false` and `retellCallId:
null` — the next 2-minute cron tick will pick it up.

**Error responses**

| Status | Shape | When |
|---|---|---|
| 400 | `{ok:false, status:400, error:"trigger_type 'open_job_due_soon' requires job_id"}` | missing/invalid trigger_type, missing target_id, or trigger not configured for company |
| 400 | `{ok:false, status:400, error:"Invalid phone_number — could not normalize to a valid E.164 number."}` | `phone_number` was provided but isn't a recognizable number |
| 404 | `{ok:false, status:404, error:"Appointment not found"}` | target_id doesn't exist for caller's company |
| 409 | `{ok:false, status:409, error:"A scheduled call already exists for this target. Pass force:true to override."}` | dedup hit; retry with `force:true` |
| 422 | `{ok:false, status:422, code:"...", error:"..."}` | found but cannot dial — see codes below |

### 422 codes

| code | When | UI suggestion |
|---|---|---|
| `appointment_cancelled` | appointment.status = 'cancelled' | Show "This appointment was cancelled" with link to reschedule |
| `appointment_in_past` | appointment.scheduled_start < now | Show "This appointment has already passed"; offer to reschedule |
| `job_closed` | job.status ∈ ('cancelled', 'completed') | Disable Call button on closed jobs |
| `job_in_past` | job.scheduled_date < today | Disable Call button on overdue jobs |
| `no_technician` | appointment.technician_id is null | Prompt user to assign a technician first |
| `missing_phone` | no number on file **and** no `phone_number` override was passed. Includes `subject:"customer"\|"technician"` so the UI can deep-link to the right edit screen | Toast with "Edit customer/technician" action — **or** offer a "Call a different number" input that re-sends the request with `phone_number` (see below) |

## UI patterns

### "Call now" button

Shown on rows in:

- **Appointments list** → `scheduled_unconfirmed` (and `technician_unconfirmed` if a tech is assigned). Show two buttons or a dropdown.
- **Jobs list** (status=open) → `open_job_due_soon`.
- **Quotations list** (status=sent/viewed) → `quotation_pending`.

Wire the click:

```ts
async function callNow(triggerType: TriggerType, target: {appointmentId?, jobId?, quotationId?}) {
  try {
    const r = await api.post('/calls/manual', { trigger_type: triggerType, ...target, immediate: true });
    if (r.data.dialed) {
      toast.success(`Calling ${customerName}…`);
    } else {
      toast.info('Call queued; will be placed shortly.');
    }
    queryClient.invalidateQueries(['scheduled-calls']);
  } catch (err) {
    handleManualCallError(err);
  }
}

function handleManualCallError(err) {
  const status = err.response?.status;
  const body = err.response?.data;
  if (status === 409) {
    confirmRetry(body.error, () => api.post('/calls/manual', { ...lastArgs, force: true }));
  } else if (status === 422 && body.subject === 'customer') {
    toast.error(body.error, { action: { label: 'Edit customer', onClick: () => goToCustomer() } });
  } else if (status === 422 && body.subject === 'technician') {
    toast.error(body.error, { action: { label: 'Edit technician', onClick: () => goToTechnician() } });
  } else {
    toast.error(body?.error || 'Failed to place call');
  }
}
```

### "Call a different number" (override)

Offer this as a general affordance on the "Call now" control — e.g. a "Call a
different number…" menu item next to "Call now", or a small phone input in the
call confirmation popover. It applies in two situations:

- **Proactively**, when the user wants to reach the customer/technician on a
  number other than the one on file (a cell instead of the office line, etc.).
- **Reactively**, after a `422 missing_phone` — prompt for a number and re-send.

Wire it by adding `phone_number` to the same request:

```ts
async function callNowWithNumber(
  triggerType: TriggerType,
  target: { appointmentId?: number; jobId?: string; quotationId?: number },
  phoneNumber: string,
) {
  const r = await api.post('/calls/manual', {
    trigger_type: triggerType, ...target, phone_number: phoneNumber, immediate: true,
  });
  // 400 => invalid number (show inline validation); otherwise same handling as callNow.
}
```

The number can be entered loosely (US 10-digit, `(415) 520-1480`, or `+E.164`) —
the server normalizes it. On a `400` (`Invalid phone_number …`), surface inline
validation on the input rather than a generic toast.

### "Schedule for later" variant (optional)

Same endpoint, pass `immediate: false` plus `scheduled_at` to queue for a
specific time. Used by a "Schedule call…" menu item that opens a datetime
picker. The backend snaps to the next office-hours window if the requested
time falls outside business hours.

### Polling for outcome

The endpoint does not stream — it returns once Retell has been dialed (or
when the dispatcher poke times out). To show post-call status (answered /
voicemail / no-answer + analysis), poll the corresponding call row by
`retell_call_id`:

- `GET /scheduled-calls?status=in_progress|completed` (newest first), OR
- `GET /calls?retell_call_id=...` (the calls history endpoint).

When the call analysis completes, any resulting todo is created via the
existing `call_analysis_configs` flow — no special handling needed here.

## Differences from the cron path

| Behavior | Cron | Manual |
|---|---|---|
| Office hours | Snap to next window | Bypassed when `immediate=true` |
| Missing phone | Creates `MISSING_PHONE` todo (high priority) | Returns 422 to the caller |
| Dedup hit | Silently skipped | Returns 409 (or override with `force:true`) |
| `is_test` | `true` in dev, `false` in prod | Always `false` (manual is always a real call) |

