# CRM sync — product decision & engineering design (v2)

_Revised 2026-10-17 after product review · covers ServiceTrade, InspectPoint, ZenTrades (CSV is an
import, not a sync — out of scope)._

## The decision

Replace today's three vague sync modes (incremental / full / custom range) with **three things a
user can understand**:

1. **Synced months.** The **Sync** button opens a month strip showing exactly which months are on
   the platform — *"Oct 2026 ✓ · Nov 2026 ✓ · Dec 2026 ✓ · Jan 2027 — Sync"*. A month that isn't
   synced has a **Sync** action; pressing it brings that month in. That is the only way data
   enters the platform (besides the automatic defaults below).
2. **Everything synced stays up to date — checked every 5 minutes.** Every job already on the
   platform, in every synced month, is checked against the CRM every 5 minutes; any change to a
   job or its appointments (time, status, technician, contact, cancellation, completion, removal)
   lands within 5 minutes. Where the CRM pushes changes (ServiceTrade webhooks), it's ~1 minute.
3. **A Refresh button on every job.** On every job row, card and detail view. Pressing it re-reads
   **everything connected to that job** from the CRM right now — the job, its appointments,
   technicians, customer, location, contacts, deficiencies, service lines and notes — and shows
   what changed.

What goes away: the *full sync* toggle, the *custom range* date picker, the *week/month/3-month*
selector, and the word *incremental* anywhere a user can see it.

| Promise | Mechanism |
|---|---|
| A job's Refresh button shows the CRM's current data for **every entity** tied to the job | re-read of the job's whole graph (§4.3a), < 6 s |
| Any change to any synced job appears within **5 min** | per-company change check every 5 min across all synced months |
| ServiceTrade changes appear within **~1 min** | webhooks (auto-registered since PR #77) |
| Deleted/vanished records are removed within **24 h** | nightly reconciliation of synced months |
| Clara never calls/texts on stale data | the same per-job refresh runs right before every outreach |

---

## 1. Why today's sync is vague (and partly wrong)

Verified in code and production on 2026-10-17:

1. **"Full", "incremental" and "custom range" mean different things per CRM** (drop the cursor in
   ServiceTrade, widest window in ZenTrades, every entity in InspectPoint). No user can predict
   what a button will do.
2. **Nobody knows which months are synced.** There is no record of coverage. ServiceTrade's
   regular sync only covers *now → end of the current month*, so on Oct 30 it looks one day
   ahead; next month only appears via custom range. InspectPoint/ZenTrades silently use
   −7 → +60 days.
3. **Completed or cancelled jobs are never re-read.** ServiceTrade's regular sync lists
   `status=scheduled` jobs only — once a job is completed/cancelled in the CRM it drops out of the
   list, and the platform keeps showing it as scheduled (unless a webhook happened to deliver it).
4. **Appointment changes are only seen through their job.** Appointments are fetched only for jobs
   whose own record changed; the appointment cursor is written but never read. A visit moved
   without touching the job record can be missed.
5. **The regular sync runs every 2 hours**, all companies one after another in a single
   invocation (19–212 s each), and those runs aren't recorded — there's no answer to "when was
   this company last refreshed?"
6. **There is no per-job refresh.** The only fix for one stale job is a company-wide sync.
7. **Nothing re-checks a job before Clara acts on it.**

## 2. How other B2B platforms do it (short)

Merge, Fivetran and Nango all converge on: an initial import, continuous change-only updates on
a schedule, push where the source supports it with polling as the safety net, and a heavy
"re-sync" kept as a rarely used repair tool. Mode is never a user choice; **what's covered and
how fresh it is** is what they show
([Merge sync frequency](https://docs.merge.dev/basics/sync-frequency/),
[Merge force resync](https://docs.merge.dev/hris/force-resync/),
[Fivetran sync overview](https://fivetran.com/docs/getting-started/syncoverview),
[Fivetran connection status](https://fivetran.com/docs/getting-started/fivetran-dashboard/connectors/status),
[Nango syncs](https://docs.nango.dev/guides/syncs/overview),
[Nango detecting deletes](https://docs.nango.dev/guides/syncs/detecting-deletes)).
Our month strip is the field-service-native version of "coverage": dispatchers think in months.

## 3. Product design

### 3.1 Sync button → "Synced months" panel

Header shows a status pill (*"Up to date · checked 2 min ago"*). The **Sync** button next to it
opens a panel:

```
 Synced with ServiceTrade                         Checked 2 min ago · [Refresh all now]

  Aug 2026    Sep 2026    Oct 2026    Nov 2026    Dec 2026    Jan 2027    Feb 2027
  ○ Sync      ✓ 212 jobs  ✓ 340 jobs  ✓ 298 jobs  ⟳ 64%      ○ Sync      ○ Sync

  ✓ Synced months are kept up to date automatically (checked every 5 minutes).
  Select months to add →  [ Sync 2 months ]
```

Month states: **Synced** (job count, "kept up to date") · **Syncing** (progress) · **Not synced**
(Sync) · **Failed** (Retry, with reason).

- **Defaults:** on connect, the current month and the next 2 months are synced automatically.
- **Auto-roll:** on the 1st of every month, the month that becomes "2 months ahead" is added
  automatically, so upcoming work never falls outside coverage. (Decision 2.)
- Users can add any month from 12 months back to 12 months ahead; multiple months queue and run
  one after another, each showing progress.
- **Refresh all now** runs the 5-minute check immediately for all synced months.
- A month is "synced" **only after its import completed**; a failed or partial import stays
  Failed with Retry — never shown as synced.

### 3.2 Refresh on every job — refreshes *everything* about the job

- ↻ icon on every job row/card (list, calendar, board) and a labelled **Refresh from ServiceTrade**
  button on the job detail.
- Re-reads, in one action, **the job's whole graph — every entity the platform holds that is
  connected to the job**, not just the job and its appointments:
  the job itself (any status, incl. completed/cancelled), every appointment (new, moved,
  cancelled, removed), assigned technicians, the **customer** (name, phone, address, status),
  the **location** (address, primary contact, notes/instructions), **all contacts** at that
  customer and location (new, edited, unlinked, deactivated), **deficiencies** at the location,
  **service lines / service requests** on the job, job and appointment **notes/comments**, and the
  owner/salesperson, office and tags. Full per-CRM list in §4.3a.
- Shows the result inline: *"Up to date"* or a one-line summary across entities — *"Visit moved
  9:00 → 13:00 · new contact Dana Lee · location phone changed · 1 deficiency resolved"*. Every
  affected panel on the page (contacts card, location card, deficiencies tab, notes) updates in
  place, no reload.
- If the job no longer exists in the CRM: *"Removed in ServiceTrade"* and the job is marked removed.
- The same refresh runs automatically right before Clara calls/texts/emails about the job, so the
  agent's context (contacts, location instructions, deficiencies) is always the CRM's current one.

### 3.3 Automatic updates, every 5 minutes

- Every company's synced months are checked every **5 minutes**. Changed jobs/appointments are
  re-read and appear on open screens automatically (rows flash *"Updated from ServiceTrade"*).
- The pill reflects it: *Up to date · checked 3 min ago* / *Checking…* / *Behind — retrying* /
  *Reconnect ServiceTrade*.
- ServiceTrade accounts with webhooks also get changes within ~1 minute; the 5-minute check is
  the guarantee, webhooks are the accelerator.

### 3.4 Demo script

1. Open **Sync** → *"These are the months Clara has from ServiceTrade; all kept up to date every
   5 minutes."* Click **Sync** on next-next month → watch it fill.
2. In ServiceTrade, move a visit's time. Back in Clara, press **↻** on that job → updated in
   seconds, with *"visit moved 9:00 → 13:00"*.
3. Change another job in ServiceTrade and don't touch Clara — it updates on its own within
   minutes (~1 min on ServiceTrade).

## 4. Engineering design

### 4.1 Coverage table (the source of truth for "synced months")

```
crm_sync_months
  company_id, provider, month (date, 1st of month, company-local),
  status ('syncing'|'synced'|'failed'),
  job_count, synced_at, last_checked_at, error, requested_by, created_at
  UNIQUE (company_id, month)
```

A job belongs to a month by its **first outstanding visit** (or **due date** when it has no
visit), in company-local time. Migration: back-fill rows from the months that already have
jobs on the platform, so the panel is truthful on day one.

### 4.2 Three operations, one code path

```js
provider.refreshJobs(companyId, jobRefs)          // Refresh button, pre-outreach check, webhooks
provider.checkForChanges(companyId, months, since) // the 5-minute check
provider.importMonth(companyId, month)            // "Sync" on a month, auto-roll, reconcile
```

| | Refresh job(s) | 5-minute check | Import / reconcile a month |
|---|---|---|---|
| Reads | the whole job graph (§4.3a), any status | **only records changed since the last check**, across all synced months | every job in the month, no cursor |
| Writes | those jobs; removes appointments no longer in the CRM | changed jobs + their appointments | the month; reconcile also removes records the CRM no longer has |
| Typical cost | 2–14 API calls/job depending on CRM | 2–4 list calls + details for what changed | 1 list pass + details |

The current `runSync` flags (`full`, `range`, `scheduleDateFrom/To`, `jobIds`) map onto these and
are retired from routes in the cleanup phase.

### 4.3a What "refresh a job" reads — the job graph, per CRM

Rule: **every platform table that has a row connected to the job is re-read from the CRM and
reconciled** (updated, added, or removed). Fetches run in parallel; targets: ServiceTrade
~10–14 calls / < 6 s, InspectPoint ~6–8 calls / < 5 s, ZenTrades ~2–3 calls / < 3 s.

| Platform entity | ServiceTrade | InspectPoint | ZenTrades |
|---|---|---|---|
| job | `GET /job/{id}` (any status) | inspection `GET /v1/inspections/{id}` | ticket `GET /api/ticket/{id}` |
| appointments (+ removals) | `GET /appointment?jobId=` — appointments missing from the response are removed | visits `GET /v2/inspection_visits?inspection_id=` | ticket's visits (embedded) |
| appointment technicians | `techs[]` on each appointment | visit technicians | visit assignees |
| appointment services / service lines | `serviceRequests[]` on each appointment | job type (service line rule) | ticket services |
| service requests (job) | `GET /servicerequest?jobId=` | — | — |
| customer | `GET /company/{id}` | account `GET /v1/accounts/{id}` | ticket customer (embedded) |
| location | from the job detail + `GET /location/{id}` when needed | building `GET /v1/buildings/{id}` | service address (embedded) |
| contacts (+ links, deactivations) | `GET /contact?companyId=` + `GET /contact?locationId=` + `status=inactive` for known ids at that customer/location | `GET /v1/contacts?account_id=` / building contacts | customer / service-address / additional contacts (embedded) |
| deficiencies | `GET /deficiency?locationId=` | `GET /v1/deficiencies?inspection_id=` (+ building) | — |
| change orders / contracts / recurrences | embedded on `/servicerequest?jobId=`; `GET /contract?jobId=` | — | — |
| job notes / comments | job `notes[]` + `GET /comment?entityType=3&entityId=` | inspection notes / technician instructions | ticket notes |
| appointment notes | appointment `notes[]` | visit notes | — |
| owner / salesperson, office, tags | embedded on the job detail | — | — |

Two gaps this closes that exist today: ServiceTrade **service requests, deficiencies, change
orders and contracts are not refreshed at all right now** (their sync stage is disabled in
`servicetrade-sync.js`), and a contact deactivated/unlinked in the CRM is only caught by the
company-wide pass. The per-job refresh reads all of them directly.

Platform-only data is never touched by a refresh: confirmation status, call/chat history,
Clara's notes, job-type instructions, recipient choices.

The **5-minute check** (§4.3) covers the same entities, not only jobs/appointments: for each
entity type it asks the CRM for records changed since the last check (ServiceTrade:
`/job`, `/appointment`, `/contact`, `/company`, `/location`, `/deficiency`, `/servicerequest`
with `updatedAfter`; InspectPoint: inspections/accounts/buildings/contacts with
`updated_at_start`, deficiencies where filterable), then refreshes the graph of every synced job
those changes touch (a changed contact → the jobs at its customer/location). Entities a CRM can't
filter by update time are re-read during the job graph refresh and the nightly reconcile.

### 4.3 How "check every synced job every 5 min" stays cheap

Re-reading every job every 5 minutes is not feasible (company 10 alone has ~1,900 jobs → ~3,800
calls per check). Instead each check asks the CRM **"what changed since my last check?"** for the
synced date range, then re-reads only those jobs. The cost scales with the number of *changes*,
not the number of synced jobs or months — which is why "all synced data" is affordable at a
5-minute cadence.

| CRM | Change detection per check | Gaps it closes |
|---|---|---|
| **ServiceTrade** | `GET /job?updatedAfter=…` with **all statuses** (not just scheduled) + `GET /appointment?updatedAfter=…`, both bounded to synced months → `/job/{id}` for the union of changed job ids | completed/cancelled jobs (§1.3), appointment-only changes (§1.4) |
| **InspectPoint** | `/v2/inspections?updated_at_start=…` (supported) + accounts/buildings (already cursor-based); visits have no updated filter → re-read visits only for changed inspections; plus a 30-min visit sweep for the current/next month as safety net | — |
| **ZenTrades** | no webhooks and no updated-since filter → re-pull synced months in 7-day slices. Every 5 min for the current + next month; other synced months every 30 min (cost). | — |

Webhooks (ServiceTrade today, InspectPoint later — its API has inspection/deficiency/contact/
account/building events) feed `refreshJobs` directly and make most changes appear in ~1 min.

**Nightly reconcile** re-imports each synced month without a cursor (spread across the night)
to catch deletions and anything a change query can't express.

### 4.4 Scheduler

- `crm_sync_schedules` (company_id, lane, interval, next_run_at, lease_until, cursor, last_success_at,
  last_error, consecutive_failures). Lanes: `check` (5 min), `reconcile` (nightly), plus a queue of
  month imports.
- **Dispatcher cron every minute** claims due companies (`FOR UPDATE SKIP LOCKED`) and starts **one
  function invocation per company**, so companies run in parallel (today: one serial loop every
  2 h). Never stacks runs; backs off on errors; pauses on auth failure and shows *Reconnect*.
- One per-company lock shared by the check, month imports, webhook drains and Refresh clicks so two
  writers never normalize the same company at once. A Refresh click never waits behind a long
  import — it takes a short read-only path for the fetch and queues only its normalize.
- Every run (including cron) is an `engine_runs` row with trigger + lane → status pill and history.

### 4.5 Speed: normalize only what changed

Fetching is cheap; normalizing is the cost today (~24 s for a single webhook event, because it
re-reads company-wide sets). Required before the 5-minute check ships:
- pass the touched raw ids into normalize and rebuild only those jobs' appointments/junctions;
- skip normalize entirely when a check found no changes (most checks);
- targets: no-change check < 3 s; Refresh button end-to-end < 5 s.

### 4.6 Telling screens what changed

`companies.data_version` bumps with every normalize that changed rows; a 24-hour `sync_changes`
log lists `(entity, id, action, fields)`. Clients poll status every 20 s and fetch the change list
only when the version moves, then refetch/flash the affected rows (see the frontend guide).

### 4.7 Before every outreach

The scheduler calls `refreshJobs([job])` (10 s timeout) immediately before a call/SMS/email and
re-checks eligibility; on CRM timeout it proceeds only if the job was refreshed < 15 min ago,
otherwise defers one slot.

## 5. Rollout

| Phase | Ships | Done when |
|---|---|---|
| **1 — Refresh button** | `POST /jobs/:id/refresh` for all three CRMs refreshing the **whole job graph** (§4.3a — job, appointments, technicians, customer, location, contacts, deficiencies, service requests/lines, notes; removals included); scoped normalize for it; pre-outreach refresh | a change to **any** of those entities in the CRM shows after pressing ↻, < 6 s |
| **2 — Synced months** | `crm_sync_months` + back-fill, month import (queue, progress), defaults + auto-roll, coverage API; ServiceTrade regular window replaced by coverage | the panel matches what's on the platform; custom range no longer needed |
| **3 — 5-minute check** | scheduler + dispatcher, change detection per CRM (§4.3), no-op normalize skip, `data_version`/changes feed, cron runs recorded | p95 change-to-platform ≤ 5 min on every connected account for a week |
| **4 — cleanup** | nightly reconcile with removals; old `full`/`range`/`startDate` sync routes removed; InspectPoint webhooks | no stale "scheduled" jobs that are completed in the CRM; old sync UI gone |

## 6. Decisions needed

1. **Month assignment** — a job counts in the month of its first outstanding visit, else its due
   date. OK?
2. **Defaults & auto-roll** — current + next 2 months on connect, auto-add the month 2-ahead on the
   1st. Or a different horizon?
3. **How far users can add** — 12 months back / 12 months ahead proposed.
4. **ZenTrades cost** — current + next month every 5 min, other synced months every 30 min
   (no change filter in its API). Acceptable, or every 5 min for all at higher API cost?
5. **Removing a month** — not in v1 (synced months stay synced). Needed?
6. **Refresh rate limit** — one press per job per 10 s per user, to protect the CRM API.

---

## 7. Hide past inspections

**Decision:** past inspections are hidden from the main jobs/inspections list. A **Past
inspections** button opens a separate list of them. Nothing is deleted.

- **Past** = every visit of the job is before today, in the company's timezone. A job with no
  visit uses its due date.
- **Main list** (default): everything that isn't past. This is unchanged otherwise, with the same
  filters and sort.
- **Past inspections** (button at the top of the list, with a count): the past jobs, most recent
  first, with the same search and filters. Opening a job works as usual. Past jobs keep their
  history, calls and chats, and ↻ Refresh still works.
- It's automatic both ways. A job becomes past the day after its last visit. If a past job is
  rescheduled into the future (picked up by Refresh or the 5-minute check), it moves back to the
  main list.
- It's the same pattern Jobber (auto-archive when visits are done), Zendesk (solved → closed →
  archived) and Linear (auto-archive completed issues) use. Records leave the working list by
  time, but stay findable
  ([Jobber](https://help.getjobber.com/hc/en-us/articles/360040986713),
  [Zendesk](https://support.zendesk.com/hc/en-us/articles/4408883475354-Why-do-solved-tickets-change-to-a-closed-status),
  [Linear](https://linear.app/docs/archive-issues)).

**Engineering:** `GET /jobs?view=past` returns past jobs. Without `view`, or with `view=current`,
the list excludes them. `GET /jobs/views` returns `{ current, past }` counts. "Past" is computed
in the list query from the latest visit date in company timezone, so no data is moved and
there's no migration. Past jobs older than 30 days drop out of the 5-minute check. Refresh and
the nightly check still cover them.

Ships independently of the sync phases. It's a list-query change plus a button, so it can go
first.
