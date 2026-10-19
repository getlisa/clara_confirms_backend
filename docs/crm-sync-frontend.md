# CRM sync — synced months, job refresh & auto-updates — Frontend Guide

> **For the frontend agent.** The sync UI is being rebuilt around three things:
> 1. a **Sync** button that opens a **Synced months** panel: which months are on the platform,
>    plus a **Sync** action for the months that aren't;
> 2. a **Refresh** button on **every job** that re-reads **everything connected to that job** from
>    the CRM right now: appointments, technicians, customer, location, contacts, deficiencies,
>    service lines and notes;
> 3. **automatic updates**: everything synced is checked every 5 minutes, and screens update
>    themselves.
>
> Full sync, custom range, the week/month/3-month selector and the word "incremental" are removed
> from the UI. Background: `docs/crm-sync-strategy.md`.
>
> Endpoints are **provider-agnostic** (ServiceTrade, InspectPoint, ZenTrades). The backend ships in
> phases. Each section is tagged **[Phase N]**, and §9 explains how to feature-flag.

Base URL: `VITE_API_URL` · Auth: `Authorization: Bearer <token>` · gate on `user.permissions`,
never on the role (`team-access-frontend.md`).

---

## 0. What to build NOW (updated 2026-10-19)

These four have a live backend. **Build only these.** Everything else in this guide (§3–§9) is
planned. Leave it alone until this section lists it.

| # | Build | Where | Backend | Spec |
|---|---|---|---|---|
| 1 | **↻ Refresh button on every job.** An icon on every job row, card and calendar item, plus a labelled "Refresh from {CRM}" button on the job detail and visit drawer. Shows "Up to date" or a one-line summary of what changed, then re-renders the job from the response. | jobs list, calendar, job detail, visit drawer | **live** | §2 |
| 2 | **Past inspections.** Hide past inspections from the main list. Add a "Past inspections (N)" button that opens a separate list, with a back link. | jobs page | **live** | §11 |
| 3 | **Visit card: separate "Services" and "Deficiencies" sections.** Each has its own small heading and is shown only when its array is non-empty. Deficiencies are grouped into "Repair offered on this visit" and "Open at this site". | visit card, visit drawer | **live once PR #83 is deployed** | §2a |
| 4 | **Job detail: "Deficiencies (N)" section.** Every open deficiency at the site, grouped by service line, with severity badges. Hidden when `deficiency_summary.open` is 0. | job detail | **live once PR #83 is deployed** | §2a |

**Check before shipping:**
- The ↻ button needs the `sync.run` permission. Hide it for users without it, and for jobs whose
  `source` is `csv` or `manual`.
- Use a client timeout of at least 30 s for Refresh. It usually answers in about 3 s.
- Handle the Refresh errors in §2: 404 removed from the CRM, 409 reconnect, 429 wait N
  seconds, 501 not supported, 502/504 CRM didn't respond. Keep showing the current data on any
  error.
- **Stop reading deficiencies out of `services`.** After PR #83, `services` holds only booked
  work. Any existing code that filtered `kind === "deficiency_repair"` out of `services` must
  read `visit.deficiencies` instead.
- A calendar or date-range view keeps receiving past jobs (an explicit date range returns
  everything in it). Only the default list hides them.

**Not yet. Don't build:** the status pill (§3), the Synced months panel (§4), Refresh all now
(§4.3), auto-updates (§5), and the removals in §7. Also don't build anything new on
`servicetrade-sync-range-frontend.md` (custom range). Synced months will replace it.

| Endpoint | Purpose | Permission | § | Phase |
|---|---|---|---|---|
| `POST /jobs/:id/refresh` | **Refresh** one job and everything tied to it | `sync.run` | 2 | live |
| `GET /jobs/:id` → `deficiencies` | structured deficiencies on the job and on each visit | `data.read` | 2a | live |
| `GET /integrations/sync/status` | status pill + change detection | `data.read` | 3 | 2 |
| `GET /integrations/sync/months` | Synced months panel | `data.read` | 4.1 | 2 |
| `POST /integrations/sync/months` | **Sync** one or more months | `sync.run` | 4.2 | 2 |
| `POST /integrations/sync/refresh` | **Refresh all now** (the 5-minute check, run now) | `sync.run` | 4.3 | 3 |
| `GET /integrations/sync/changes?since=` | what changed, for auto-updates | `data.read` | 5 | 3 |
| `GET /engines/:runId/stream?token=` | progress of a run (SSE) | token | 4.2 | available today |
| `GET /jobs?view=past` · `GET /jobs/views` | **Past inspections** list + count | `data.read` | 11 | any time |

---

## 1. Words to use

| Say | Never say |
|---|---|
| Synced months · Sync · Refresh · Up to date · Checked 2 min ago · Updated from ServiceTrade | incremental · full sync · custom range · cursor · webhook · normalize |

Use the connected CRM's name everywhere (`provider_label`, e.g. "ServiceTrade").

---

## 2. Refresh on every job — `POST /jobs/:id/refresh` — [Phase 1]

**Where:**
- a ↻ icon button on **every** job row, card and calendar item;
- a labelled **Refresh from {provider_label}** button on the job detail and the appointment drawer.

It re-reads **everything connected to this job** from the CRM, whatever its status. It's
synchronous and usually takes 2–6 s.

| `entity` in `changes` | What it is | Panel to update |
|---|---|---|
| `job` | the job itself (status, type, description, due date, owner…) | job header |
| `appointment` | each visit: time, status, created/removed | visits list, calendar |
| `technician` | who is assigned to a visit | visit row |
| `customer` | name, phone, email, address | customer card |
| `location` | address, primary contact, access notes/instructions | location card |
| `contact` | every contact at the customer/location: new, edited, unlinked, deactivated | contacts card, recipients picker |
| `deficiency` | open/resolved deficiencies at the location / on the inspection | deficiencies tab |
| `service_line` | services booked on the job/visits | services list |
| `service_request` | ServiceTrade service requests on the job | service opportunities |
| `note` | job / visit notes and comments from the CRM | notes / activity |

Platform-only data (confirmation status, call/chat history, Clara notes, recipient choices) is
never changed by a refresh.

```json
// 200
{
  "job": { "...": "exactly what GET /jobs/:id returns — appointments, customer, contacts, and deficiencies (§2a)" },
  "changed": true,
  "changes": [
    { "entity": "appointment", "id": 88121, "action": "updated", "field": "scheduled_start",
      "from": "2026-10-20T09:00:00-05:00", "to": "2026-10-20T13:00:00-05:00" },
    { "entity": "job", "id": 5123, "action": "updated", "field": "status", "from": "scheduled", "to": "completed" },
    { "entity": "appointment", "id": 88004, "action": "removed" },
    { "entity": "contact", "id": 991, "action": "created", "label": "Dana Lee" },
    { "entity": "contact", "id": 640, "action": "removed", "label": "Old Contact" },
    { "entity": "location", "id": 77, "action": "updated", "field": "phone", "from": "+14155550100", "to": "+14155550199" },
    { "entity": "deficiency", "id": 3012, "action": "updated", "field": "status", "from": "open", "to": "resolved" },
    { "entity": "note", "id": 55102, "action": "created" }
  ],
  "refreshed_at": "2026-10-17T14:05:02Z"
}
```

| Response | UI |
|---|---|
| `200`, `changed: false` | small inline "Up to date · just now" next to the button, fades after 3 s |
| `200`, `changed: true` | replace the job in your cache with `job` and **invalidate every related query** (customer, location, contacts, deficiencies, notes, service lines for this job). Flash the changed fields. Toast a one-line summary built from `changes` ("Visit moved 9:00 → 13:00 · new contact Dana Lee · 1 deficiency resolved"), at most 3 items then "+N more". |
| `404 not_in_crm` | "This job no longer exists in {provider_label}." Then refetch the list. The job shows as removed. |
| `409 reconnect_required` | "Reconnect {provider_label} to refresh." Link to the integration page. |
| `429 too_soon` | `{ retry_after_s }`. Keep the icon disabled for that long (limit: one refresh per job every 10 s). |
| `504 crm_timeout` | "{provider_label} didn't respond. Try again." Keep showing the current data. |

- Spin the icon while the request is in flight and disable it. Use a client timeout of **≥ 30 s**.
- Row-level ↻ must not open the job: stop the click from bubbling up to the row.
- Hide it for jobs with `source === "csv"` or `"manual"` (nothing to refresh from), and for users
  without `sync.run`.
- If the job is open **with unsaved edits**, don't overwrite the form. Show a banner: "This job
  changed in {provider_label}." with **Load latest** / **Keep editing**.

---

## 2a. Deficiencies on a job — `GET /jobs/:id` and the Refresh response — [live]

The job detail, and the `job` in a Refresh response, return deficiencies as structured objects
in two places.

**Services and deficiencies are separate entities.** A visit has both, either, or neither:

| field on each visit | contains | empty when |
|---|---|---|
| `services` | **booked work only**: what the visit is for ("DOLE Ripening Room", "Annual Sprinkler Inspection"). Every item has `kind: "service"`. | nothing is booked on the visit |
| `deficiencies` | faults at the site that concern this visit (below) | there are none |

Both are **always arrays**, `[]` when there's nothing, never `null`, so `visit.services.map(...)`
can't crash. **An empty array means: don't render that section at all.** No heading, no
"None", no empty box. Deficiencies no longer appear inside `services`. The old
`kind: "deficiency_repair"` rows are gone from this response and are now `deficiencies` items
with `relation: "repair_offered"`.

### `job.deficiencies` — every open deficiency at the job's site

```json
"deficiency_summary": { "open": 3 },
"deficiencies": [
  {
    "id": 100824,
    "name": "Deficient - CaptiveAire Piranha 4.5 gal Kitchen",
    "description": "Nozzle caps missing on two appliance nozzles",
    "status": "verified",
    "severity": "deficient",
    "service_line": "Kitchen Suppression",
    "service_line_id": 412,
    "is_resolved": false,
    "opened_at": "2026-10-14T14:38:18.000Z",
    "resolved_at": null,
    "source": "servicetrade",
    "external_ref": "2776594249976321",
    "asset_type": null,
    "resolution_status": null,
    "inspection_ref": null,
    "detail": {},
    "visit_ids": [1251138]
  }
]
```

| field | notes |
|---|---|
| `name` | the label to show. Already the best one available. |
| `severity` | **ServiceTrade only:** `inoperable` (worst), `deficient`, `suggested`. `null` for InspectPoint. |
| `status` | ServiceTrade: `new` / `verified`. InspectPoint: usually `null`. Don't build UI on it. |
| `service_line` | the trade or system it belongs to ("Kitchen Suppression", "Sprinkler"). Use it as a group heading. |
| `asset_type`, `detail` | **InspectPoint only.** `detail.asset_details` has six different shapes. Render it as described in `deficiencies-frontend.md` §4 (Question + Answer first). Empty `{}` for ServiceTrade. |
| `visit_ids` | the visits of this job that list it (see below). Empty means it's at the site but no upcoming visit covers it. |

Only **open** deficiencies are returned, at most 200, newest first. Resolved ones are
left out. The full history per site stays at `GET /locations/:id/deficiencies`.

### `appointments[].deficiencies` — the deficiencies that concern this visit

Every visit has a `deficiencies` array, usually empty. Each item is the same object as
above, without `visit_ids`, plus a `relation`:

| `relation` | meaning | show as |
|---|---|---|
| `repair_offered` | Clara will offer to repair it on this visit (InspectPoint) | **"Repair offered on this visit"** |
| `open_at_site` | it's open at the site, and this is the job's **next upcoming visit** | **"Open at this site"** |

- Only the **next upcoming visit** gets `open_at_site` items. Past and later visits don't
  repeat the whole list.
- ServiceTrade deficiencies have no visit-level link in the CRM, so they always arrive as
  `open_at_site` on the next visit.
- A deficiency appears at most once per visit, and `repair_offered` wins.

### Suggested layout

**Job detail → "Deficiencies (3)" section** (hide it when `deficiency_summary.open === 0`):
- Group by `service_line`.
- Sort each group by severity, `inoperable` first.
- Each row shows: a severity badge (red `inoperable`, orange `deficient`, grey `suggested`; none
  for InspectPoint), `name`, a one-line `description`, and "Opened {relative opened_at}".
- Expanding a row shows the full description and, for InspectPoint, the `detail.asset_details`
  card.

**Visit card / drawer: two separate sections, each with a small heading, each shown only when
non-empty:**

```
┌ Tue Oct 21 · 4:30–10:30 PM · Ultimate Fire ───────────────┐
│ SERVICES                                                    │
│   DOLE Ripening Room — Weekly inspection (about 6 hours)    │
│ DEFICIENCIES (29)                                           │
│   Repair offered on this visit (9)                          │
│     Bulb Gaskets — Fail                                     │
│     Caulking — Fail                    … show all           │
│   Open at this site (20)                                    │
└─────────────────────────────────────────────────────────────┘
```

- **Services:** one line per item: `service_line`, then `description`. Skip the
  description when it repeats the service line.
- **Deficiencies:** grouped by `relation`, "Repair offered on this visit" first, then "Open at
  this site". Show the first 3 per group, then "show all". Same row style as the job-level list
  (severity badge, `name`).
- Visit with services only: just the Services section. Deficiencies only: just the
  Deficiencies section. Neither: no section at all.

**After a Refresh:** a `changes` entry with `entity: "deficiency"` means the job's
`deficiencies` changed. Re-render from the returned `job`. Don't patch the list.

## 3. `GET /integrations/sync/status` — the pill — [Phase 2]

Poll every **20 s while the tab is visible** and every 60 s when it's hidden. The endpoint is cached
server-side.

```json
{
  "provider": "servicetrade",
  "provider_label": "ServiceTrade",
  "connected": true,
  "state": "up_to_date",
  "last_checked_at": "2026-10-17T14:02:11Z",
  "next_check_at": "2026-10-17T14:07:11Z",
  "check_interval_s": 300,
  "live_updates": true,
  "running": null,
  "data_version": 48213,
  "error": null
}
```

| `state` | Pill |
|---|---|
| `up_to_date` | 🟢 **Up to date** · checked *2 min ago* |
| `checking` | 🔄 **Checking {provider_label}…** (`running.step`, e.g. "Updating 4 jobs") |
| `importing` | 🔄 **Syncing Dec 2026…** (a month import is running) |
| `behind` | 🟠 **Last checked 25 min ago** · retrying |
| `needs_attention` | 🔴 **Reconnect {provider_label}** → integration page, show `error.message` |
| `disconnected` | hide the pill and show the existing "Connect a CRM" state |

- `live_updates: true` (ServiceTrade with webhooks) → tooltip "Changes in {provider_label} usually
  appear within a minute." Otherwise: "Checked every 5 minutes."
- Re-render relative times every 10 s on the client. Don't refetch just to update the text.
- The **Sync** button sits next to the pill and opens the panel (§4).
- `data_version` drives auto-updates (§5).

---

## 4. Synced months panel — [Phase 2]

### 4.1 `GET /integrations/sync/months`

```json
{
  "provider_label": "ServiceTrade",
  "timezone": "America/Chicago",
  "selectable": { "from": "2025-10", "to": "2027-10" },
  "months": [
    { "month": "2026-09", "status": "synced",  "job_count": 212, "synced_at": "2026-09-01T06:00:00Z", "last_checked_at": "2026-10-17T14:02:11Z", "auto": false },
    { "month": "2026-10", "status": "synced",  "job_count": 340, "synced_at": "2026-10-01T06:00:00Z", "last_checked_at": "2026-10-17T14:02:11Z", "auto": true },
    { "month": "2026-11", "status": "synced",  "job_count": 298, "synced_at": "2026-10-01T06:00:00Z", "last_checked_at": "2026-10-17T14:02:11Z", "auto": true },
    { "month": "2026-12", "status": "syncing", "progress": 0.64, "run_id": "915", "auto": true },
    { "month": "2027-01", "status": "failed",  "error": "ServiceTrade didn't respond. Retry.", "auto": false }
  ]
}
```

- `months` only lists months that are synced, syncing or failed. Every other month inside
  `selectable` is **Not synced**. Render the strip yourself: from `selectable.from` to
  `selectable.to`, scrolled so the current month is in view.
- `auto: true` means the month was added automatically: the current month, the next 2, and the
  monthly auto-roll. Show a small "Auto" tag in its tooltip.
- `month` is `YYYY-MM` in the company's `timezone`. Display it as "Oct 2026".

| `status` | Chip | Action |
|---|---|---|
| `synced` | ✓ **Oct 2026** · 340 jobs · tooltip "Kept up to date · checked 2 min ago" | none |
| `syncing` | ⟳ **Dec 2026** · progress bar (`progress` 0–1) | none (disabled) |
| `failed` | ⚠ **Jan 2027** · `error` | **Retry** |
| *(absent)* | ○ **Feb 2027** | **Sync**, or multi-select checkbox |

Panel copy: header **"Synced with {provider_label}"**, sub-line *"Synced months are kept up to date
automatically: every job is checked every 5 minutes."* The footer has **Sync N months** when a
selection is made, and **Refresh all now** (§4.3) at the top right.

### 4.2 `POST /integrations/sync/months` — Sync / Retry

```json
{ "months": ["2027-01", "2027-02"] }
```

```json
// 202
{ "queued": [
    { "month": "2027-01", "run_id": "916" },
    { "month": "2027-02", "run_id": null, "position": 2 }
] }
```

- Months import one after another. The first gets a `run_id` right away; the rest show "Queued".
- Track progress by re-polling §4.1 every 3 s while anything is `syncing` or queued (simplest), or
  by subscribing to the engine stream for `run_id`.
- When a month flips to `synced`, toast "Dec 2026 synced · 211 jobs" and refetch the job lists.
- Errors:
  - `400 invalid_month`: the month is outside `selectable`.
  - `409 already_synced`: refresh §4.1.
  - `409 reconnect_required`: as in §2.
  - Sending more than 6 months in one request also returns `400 invalid_month`.

### 4.3 `POST /integrations/sync/refresh` — Refresh all now — [Phase 3]

Runs the 5-minute check immediately for every synced month.

```json
// 202
{ "run_id": "917", "already_running": false }
```

- `429 too_soon { retry_after_s }`: once per 30 s per company. Show a countdown on the button.
- While it runs the pill shows *Checking…*. When it finishes, §5 picks up the changes. Toast "Up to
  date" or "6 jobs updated from {provider_label}".

---

## 5. Auto-updates — `GET /integrations/sync/changes?since=<data_version>` — [Phase 3]

```
on each status poll (§3):
  if status.data_version > lastSeenVersion:
    r = GET /integrations/sync/changes?since=lastSeenVersion
    lastSeenVersion = r.data_version
    apply r.changes (below)
```

```json
{
  "data_version": 48219,
  "truncated": false,
  "changes": [
    { "entity": "job", "id": 5123, "action": "updated", "fields": ["status"], "at": "2026-10-17T14:04:58Z" },
    { "entity": "appointment", "id": 88121, "job_id": 5123, "action": "updated", "fields": ["scheduled_start", "scheduled_end"], "at": "2026-10-17T14:04:58Z" },
    { "entity": "appointment", "id": 88004, "job_id": 4980, "action": "removed", "at": "2026-10-17T14:04:58Z" },
    { "entity": "job", "id": 6011, "action": "created", "at": "2026-10-17T14:04:57Z" }
  ]
}
```

- `id`s are **our** ids (`jobs.id`, `appointments.id`, `contacts.id`).
- `entity` uses the same values as §2 (`job`, `appointment`, `technician`, `customer`, `location`,
  `contact`, `deficiency`, `service_line`, `service_request`, `note`). Non-job entities carry
  `job_ids` (the synced jobs they affect).
- `job` / `appointment` change → invalidate job list queries and that job's detail. Any other
  entity → invalidate the detail of every job in `job_ids` and that entity's own queries
  (customer page, contacts list, deficiencies tab).
- Changed rows flash for 4 s with the badge *"Updated from {provider_label}"*. Removed
  appointments fade out. Batch toasts into one per poll ("8 jobs updated from ServiceTrade").
- `truncated: true` (more than 500 changes, or `since` older than 24 h): refetch the open screen
  instead of patching row by row.
- Only call `/changes` when `data_version` moved. Never poll it on its own.

---

## 6. Where things go on screen

| Element | Placement |
|---|---|
| Status pill + **Sync** button | top of the Jobs page (and the integration page) |
| Synced months panel | opens from **Sync** as a popover or side sheet. On the integration page show it inline. |
| ↻ Refresh | every job row/card/calendar item. Labelled button on job detail and appointment drawer. |
| "Updated from {provider}" flash | on the row/card/field that changed |

---

## 7. What to remove

| Today | Replaced by | When |
|---|---|---|
| "Full sync" toggle/button | nothing user-facing (nightly reconcile is automatic) | hide now |
| Custom range date picker (`servicetrade-sync-range-frontend.md`) | **Sync** on a month | Phase 2 |
| `range=week/month/3month` selector | Synced months | Phase 2 |
| Page-level "Sync now" / "Sync inspections" buttons | **Refresh all now** in the panel + ↻ on each job | Phase 2–3 |
| ServiceTrade webhook "refresh" (`/webhook/drain`) | ↻ on the job / **Refresh all now** | Phase 3 |
| `POST /integrations/{provider}/sync` | `POST /integrations/sync/months` / `POST /integrations/sync/refresh` | old route works for one release after Phase 3 |
| `GET /integrations/{provider}/status` → `sync` block | `GET /integrations/sync/status` | Phase 2. Keep the old route for connect/disconnect. |

Webhook enable/disable UI can stay on the integration page under "Advanced". Webhooks now register
automatically.

---

## 8. Permissions

| Permission | Can |
|---|---|
| `data.read` | see the pill, the months panel (read-only), the change flashes |
| `sync.run` | ↻ Refresh a job, **Sync** months, **Refresh all now** |

Without `sync.run`, show the panel without its actions, and hide ↻.

## 9. Feature flags & rollout

- **Phase 1:** ship the ↻ button on its own. Hide it if `POST /jobs/:id/refresh` returns `404`
  (backend not deployed yet).
- **Phases 2–3:** gate the panel, pill and auto-updates behind `VITE_SYNC_V2`. With the flag on,
  if `GET /integrations/sync/status` returns `404`, fall back silently to today's sync UI.

## 10. Don'ts

- Don't trigger a sync or refresh automatically on page load. The 5-minute check handles freshness.
- Don't refresh many jobs in a loop from the client. Use **Refresh all now** instead.
- Don't show a month as synced from client-side guesses. Only `status: "synced"` from §4.1 counts.
- Don't block the UI during a sync. Data stays readable the whole time.

---

## 11. Past inspections — hidden from the main list — [available after PR merge]

Past inspections no longer appear in the main jobs/inspections list. A **Past inspections**
button opens them. Nothing is deleted.

**Past** = every visit of the job is before today (company timezone). A job with no visit uses
its due date. The backend decides. Don't compute it on the client.

### 11.1 API

| Call | Returns |
|---|---|
| `GET /jobs` (or `?view=current`) | the main list. **Past jobs are excluded.** All existing params work as before. |
| `GET /jobs?scheduled_date_from=…&scheduled_date_to=…` | a date range (calendar) returns **every** job in the range, past included, unless you also pass `view`. |
| `GET /jobs?view=past` | only past jobs, newest visit first. Same params (`search`, `status`, `customerId`, `limit`, `offset`, …). |
| `GET /jobs/views` | `{ "current": 115, "past": 80 }` |

Each job also carries `"is_past": true|false` and `"last_visit_at"`.

### 11.2 UI

- Main list: add a **Past inspections (80)** button at the top right of the list, using the
  count from `/jobs/views`.
- Clicking it opens the past list (a separate route, e.g. `/jobs/past`, so it can be bookmarked)
  with a **← Back to inspections** link. It uses the same table, search and filters, sorted by
  most recent visit first.
- Opening a past job shows the normal job detail (history, calls, chats). Hide actions that don't
  apply to a past visit (Send confirmation, Call now). **↻ Refresh stays.**
- When §5 reports changes, refetch the open list and `/jobs/views`. A job can move between the
  lists, for example a past job rescheduled to next week returns to the main list.
- Empty past list: "No past inspections yet."
