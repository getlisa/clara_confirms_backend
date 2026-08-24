# ServiceTrade Sync — Custom Date Range — Frontend Guide

> **For the frontend agent.** One existing endpoint gains two optional query
> params. Nothing else changes; omit them and the endpoint behaves exactly as it
> does today. Same conventions as `chat-link-status-frontend.md`.

Base URL: `VITE_API_URL` · Auth: `Authorization: Bearer <token>` (the company is
read from the token — never send a company id).

---

## 0. What shipped, and why you'd use it

Until now every sync pulled **the current calendar month only** — jobs scheduled
from "now" through the last day of this month. There was no way to pull last
month's jobs, or jobs scheduled past the end of this month, short of `full=true`
(which re-pulls the entire account, ignoring dates — slow and heavy).

`POST /integrations/servicetrade/sync` now accepts `startDate` and `endDate`.
Give it a window and it syncs every job scheduled inside that window — a
backfill of July, a look-ahead into next month, whatever the user picks.

**The window is capped at 31 inclusive days.** 31 rather than 30 so that *any*
calendar month is a legal range (`2026-07-01 → 2026-07-31` is fine;
`2026-07-01 → 2026-08-01` is 32 days and rejected).

---

## 1. `POST /integrations/servicetrade/sync` 🔒

**Query params** — all optional:

| param | type | notes |
|---|---|---|
| `startDate` | `YYYY-MM-DD` | **New.** First day of the window, inclusive. Interpreted in the **company's timezone**, not UTC or the browser's. |
| `endDate` | `YYYY-MM-DD` | **New.** Last day of the window, inclusive — the whole day, through 23:59:59 local. |
| `full` | `"true"` | Full re-sync of every scheduled job, ignoring dates. **Mutually exclusive with `startDate`/`endDate`.** |
| `stream` | `"true"` | Return `202` immediately with an SSE token instead of blocking. See §3. |
| `range` | `week` \| `month` \| `3month` | Pre-existing, unrelated to the new params — it scopes the *service-request* fetch, not jobs. Defaults to `month`; an unrecognised value silently falls back. |

`startDate` and `endDate` are **both-or-neither**. Sending one without the other
is a `400`.

### Behaviour

| you send | you get |
|---|---|
| neither date | Unchanged: incremental sync of the **current calendar month**, only what changed since the last sync. This is what the cron does every 2 hours. |
| both dates | Every job scheduled in that window, re-pulled in full — the "only what changed since last sync" filter is deliberately **not** applied, otherwise a backfill of a past month would return nothing. |
| `full=true` | Every scheduled job regardless of date. |

One consequence worth surfacing in the UI: a **custom-range sync does not update
"Last synced at."** It covered one window, not "everything up to now", so
claiming the whole account is current would be a lie — and it deliberately leaves
the incremental cursor alone so the next regular sync still catches everything
else that changed. If you show a "Last synced" timestamp, expect it to stay put
after a range sync. Consider a distinct confirmation like *"Synced 1–31 July —
142 jobs"* rather than reusing the normal "Sync complete" toast.

### Responses

**`200`** — blocking mode (no `stream`):
```json
{ "success": true, "runId": "42", "counts": { "jobs": 142, "appointments": 310, "normalized": { "jobs": 142 } } }
```

**`202`** — with `stream=true`:
```json
{
  "runId": "42",
  "kind": "crm_sync",
  "streamToken": "<jwt>",
  "streamUrl": "/engines/42/stream?token=<jwt>",
  "snapshotUrl": "/engines/42"
}
```

**`400`** — validation. The `error` string is safe to show verbatim; these are
the only five:

| condition | `error` |
|---|---|
| only one of the two dates sent | `startDate and endDate must be provided together` |
| not `YYYY-MM-DD`, or not a real date (`2026-02-30`) | `Invalid date: expected YYYY-MM-DD` |
| `endDate` before `startDate` | `endDate must be on or after startDate` |
| window wider than 31 days | `Date range cannot exceed 31 days` |
| `full=true` sent alongside a range | `full=true cannot be combined with a custom date range` |

**`400`** is also returned when the sync itself fails: `{ "error": "<reason>" }`.
**`500`**: `{ "error": "Sync failed", "detail": "<dev only>" }`.

---

## 2. UI guidance

- **Default the picker to the current month.** That matches what the endpoint
  does with no params, so the default view stays honest.
- **Mirror the 31-day cap client-side.** Once `startDate` is chosen, disable any
  `endDate` more than 30 days after it (and vice versa). The `400`s are a
  backstop, not the primary UX.
- **Dates are the company's local days**, not the browser's. Send the raw
  `YYYY-MM-DD` the user picked — do **not** convert to UTC or to an ISO
  timestamp first. The backend resolves them against the company timezone
  (DST-correct: 1 July midnight EDT and 1 January midnight EST resolve to
  different UTC offsets, and that is handled for you).
- **Use `stream=true` for range syncs.** The blocking path times out after
  4 minutes and a month-wide backfill can exceed that. With `stream=true` you get
  a run id immediately and follow progress over SSE.
- **Disable the `full` toggle while a range is selected** (and vice versa) rather
  than letting the user submit a combination that 400s.
- A range sync is **additive** — it never deletes jobs outside the window.
  Re-running the same range is safe and idempotent.

---

## 3. Progress (`stream=true`)

Identical to a normal sync — the range changes what's fetched, not how progress
is reported. Subscribe to `GET /engines/:runId/stream?token=<streamToken>` (SSE),
or poll `GET /engines/:runId` for a snapshot.

States, in order:

```
started → authenticating → fetching_jobs → fetching_job_details
        → fetching_appointments → fetching_job_comments
        → normalizing → done | failed
```

Sub-events within a state:

| event | payload | meaning |
|---|---|---|
| `fetched` | `{ entity, count }` | a raw-pull stage finished for that entity |
| `entity_done` | `{ entity, count }` | a normalize stage finished for that entity |

Customers, locations, contacts, users and projects arrive *inside* the
`fetching_jobs` stage, so they have no state of their own — they report via
`fetched`.

---

## 4. Examples

Blocking, backfill July 2026:
```bash
curl -X POST "$VITE_API_URL/integrations/servicetrade/sync?startDate=2026-07-01&endDate=2026-07-31" \
  -H "Authorization: Bearer $TOKEN"
```

Streaming, the recommended path for a range sync:
```js
const params = new URLSearchParams({
  startDate: "2026-07-01",   // raw YYYY-MM-DD from the picker — no tz conversion
  endDate:   "2026-07-31",
  stream:    "true",
});

const res  = await fetch(`${API}/integrations/servicetrade/sync?${params}`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}` },
});

if (res.status === 400) {
  const { error } = await res.json();
  return showError(error);            // safe to display verbatim
}

const { runId, streamUrl } = await res.json();
const es = new EventSource(`${API}${streamUrl}`);
es.onmessage = (e) => {
  const evt = JSON.parse(e.data);
  if (evt.state === "done" || evt.state === "failed") es.close();
  updateProgress(evt);
};
```

Unchanged default sync (what the "Sync now" button does today):
```bash
curl -X POST "$VITE_API_URL/integrations/servicetrade/sync" -H "Authorization: Bearer $TOKEN"
```
