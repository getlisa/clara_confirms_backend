# Scheduling Architecture

Documentation for two scheduling changes that, together, make outbound calling fair across tenants, respect each tenant's office hours, and ride within the Retell concurrency cap.

- **Change 1 — Priority-Aware Per-Tenant Concurrency** (`migration 050`)
- **Change 2 — Business-Hours Enforcement at Dispatch Time** (`migration 051`)

Both changes live inside one function: `claimPending` in [`src/db/scheduled-calls.js`](src/db/scheduled-calls.js). Read the function alongside this doc for full context.

---

# 1 — Priority-Aware Per-Tenant Concurrency

## The Problem

Retell's standard tier caps us at **20 concurrent calls system-wide** across all tenants. Before this change:

- The dispatcher claimed rows globally by `scheduled_at ASC`. One tenant with 1,000 queued calls could grab all 20 slots and **starve** every other tenant for hours.
- Priority was a crude two-lane reservation: 5 slots for `retry`/`callback`, 15 for `normal`. It couldn't distinguish "today's appointment is in 3 hours" from "open job in 2 weeks."

## The Solution at a Glance

```
┌───────────────────────────────────────────────────────────┐
│  System cap: 20 concurrent (Retell)                       │
│                                                           │
│   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐    │
│   │  Tenant A    │  │  Tenant B    │  │  Tenant C    │    │
│   │  max=10      │  │  max=10      │  │  max=10      │    │
│   │  min=2 (code)│  │  min=2 (code)│  │  min=2 (code)│    │
│   └──────────────┘  └──────────────┘  └──────────────┘    │
│                                                           │
│  Inside each tenant: rows ranked by priority + sched time │
│  callback < high < retry < normal < low                   │
└───────────────────────────────────────────────────────────┘
```

Calculation done behind this solution:
=> Avg. duration of call = 3 min
=> Minimum Concurrent calls = 2
=> No. of calls handled in hour = (60/3)*2= 40 calls/hour/tenant (Thoeritically)
=> No. of calls handled per day = 40*8 = 320 calls/day/tenant (Theoritically)


Three rules together:

1. **System cap** — never more than 20 in-flight.
2. **Per-tenant cap** — never more than `call_settings.max_concurrent_calls` for one tenant (default 10, floor 2).
3. **Priority order inside the tenant** — `callback` wins over `high` wins over `normal` wins over `low`.

Result: tenant A with 1,000 HIGH-priority calls and tenant B with 50 LOW-priority calls — A claims 10 slots, B claims its 10 slots. **B never starves**, A's HIGH calls still beat A's LOW calls.

## Priority Ladder

| Value | When assigned | UX meaning |
|---|---|---|
| `callback` | Customer asked to be called at a specific time | Always highest — customer pre-committed |
| `high`     | (1) job/appt is **today**, (2) manual "Call now", (3) retry of a today-due call | Time-critical |
| `retry`    | **Legacy** — pre-migration rows. New retries no longer write this | Treated as below `high` but above `normal` |
| `normal`   | Default — tomorrow's appt, tech confirmations, due-soon w/ >0 days | Standard cron work |
| `low`      | Quotation follow-ups, open jobs ≥ 3 days out | Background |

Numeric rank: `callback=0 < high=1 < retry=2 < normal=3 < low=4`. Same rank function in JS (`priorityRank`) and SQL (`PRIORITY_RANK_SQL_CASE`) so claim ordering is consistent on both sides.

## Where Priority Gets Set

| Insertion site | Priority chosen | File |
|---|---|---|
| `processScheduledUnconfirmed` (cron) | `computeInitialPriority({triggerType, jobDate, tz})` | [`src/services/scheduler.js`](src/services/scheduler.js) |
| `processTechnicianUnconfirmed` (cron) | same helper | same |
| `processOpenJobDueSoon` (cron) | same helper | same |
| `processQuotationPending` (cron) | always `low` | same |
| `scheduledCallsDb.scheduleRetry(...)` | `computeRetryPriority(row, tz)` — `high` if `job_date == today`, else `normal` | [`src/db/scheduled-calls.js`](src/db/scheduled-calls.js) |
| `scheduledCallsDb.scheduleCallback(...)` | always `callback` | same |
| `manual-call.triggerManualCall(...)` | always `high` | [`src/services/manual-call.js`](src/services/manual-call.js) |

Helpers live in [`src/services/call-priority.js`](src/services/call-priority.js).

## Data Model (migration 050)

```sql
ALTER TABLE call_settings ADD COLUMN max_concurrent_calls INTEGER NOT NULL DEFAULT 10;

ALTER TABLE scheduled_calls DROP CONSTRAINT scheduled_calls_call_priority_check;
ALTER TABLE scheduled_calls ADD  CONSTRAINT scheduled_calls_call_priority_check
  CHECK (call_priority IN ('callback','high','retry','normal','low'));
```

No new tables. The system cap (20) is a code constant `MAX_CONCURRENT_CALLS` in [`src/db/scheduled-calls.js`](src/db/scheduled-calls.js); the per-tenant minimum (2) is `PER_TENANT_MIN_CONCURRENT` in the same file.

## The Claim Algorithm (CTE)

`claimPending` runs a **single atomic SQL statement** with four CTEs:

```
        ┌──────────────────────────────────────────────────────┐
        │  per_tenant_inflight   how many each tenant has now  │
        └──────────────────────────────────────────────────────┘
        ┌──────────────────────────────────────────────────────┐
        │  tenant_caps   GREATEST(max_concurrent_calls, 2)     │
        └──────────────────────────────────────────────────────┘
        ┌──────────────────────────────────────────────────────┐
        │  system_inflight   total in_progress across all      │
        └──────────────────────────────────────────────────────┘
        ┌──────────────────────────────────────────────────────┐
        │  due   ranked within each tenant by priority+time    │
        └──────────────────────────────────────────────────────┘
                                  │
                                  ▼
               eligible = rows whose tenant_rank ≤
                          (cap - in_flight) for their tenant
                                  │
                                  ▼
                UPDATE … LIMIT min(batchSize, 20 - sys_in_flight)
                          FOR UPDATE SKIP LOCKED
                          ORDER BY priority, scheduled_at
```

**Walk-through** for a moment when:
- Tenant A: cap=10, currently 3 in-flight, 50 pending (mix of priorities)
- Tenant B: cap=10, currently 0 in-flight, 50 pending NORMAL
- system in-flight: 3

| Step | Result |
|---|---|
| `per_tenant_inflight` | `{A: 3, B: 0}` |
| `tenant_caps` | `{A: 10, B: 10}` |
| `due` ranks rows 1..50 within each tenant by `(priority, scheduled_at)` |
| `eligible` keeps A's rows with `tenant_rank ≤ 7` (= 10-3), B's with `tenant_rank ≤ 10` (= 10-0) | A: 7 rows, B: 10 rows |
| Outer LIMIT: `min(batchSize, 20 - 3) = min(batchSize, 17)` | ≤17 claimed total |
| Final ORDER BY priority, scheduled_at | A's HIGH first, then B's NORMAL by time |

If batchSize = 100, the claim returns 17 rows. If 50, returns 17. Manual single-call poke calls with `batchSize=1` and gets 1.

## Same-Phone Dedup

Two safeguards keep us from dialing the same person twice in parallel:

1. **SQL-side**: `due` excludes any row whose `phone_number` is already in an `in_progress` row.
2. **JS-side post-claim**: even after the SQL claim, if two rows with the same phone are claimed in the same batch, only one wins; the rest go back to `pending` for the next tick.

## Dispatcher Pokes (Manual)

The manual API (`POST /calls/manual`) sets `call_priority='high'` on insert, then calls:

```js
runDispatcher(1, { companyId, respectAutoFlag: false })
```

This invokes `claimPending(1, {companyId})` — scoped to the one tenant. Per-tenant cap still applies; if they're saturated, the row sits in `pending` and the next 2-min cron tick picks it up.

---

# 2 — Business-Hours Enforcement at Dispatch Time

## The Problem

The dispatcher only checked `scheduled_at <= NOW()`. So:

- A row queued for 4:55 PM but not claimed until 5:01 PM **would still dial after hours**.
- A retry inserted at 4:58 PM with `scheduled_at = NOW() + 5 min` = 5:03 PM **would dial after hours**.
- The cron kept draining the queue at 6, 7, 8 PM — bad for customers, bad for compliance.

Service Manager requirement: **no calls after business hours**. Overflow rows must reschedule to the next window, preserving priority.

## The Solution at a Glance

```
            ┌────────────────────────────────────┐
            │  Reaper: free orphaned in_progress │
            └────────────────────────────────────┘
                            │
                            ▼
   Step A — find tenants with due rows + their (tz, business_hours)
                            │
                            ▼
   Step B — for each OUT-of-window tenant:
            UPDATE scheduled_calls.scheduled_at = next_window
            WHERE bypass_office_hours = false
                            │
                            ▼
   Step C — claim CTE with extra filter:
            AND (company_id = ANY(in_window) OR bypass_office_hours = true)
```

Three steps inserted between the reaper and the existing concurrency CTE. The concurrency CTE itself is unchanged — it just sees a smaller candidate set.

## Where Office Hours Live

| Column / field | Source |
|---|---|
| `business_hours_start` (HH:MM string) | `call_settings` |
| `business_hours_end` (HH:MM string) | `call_settings` |
| `include_weekends` (bool) | `call_settings` |
| Timezone | `companies.default_timezone` (e.g. `America/New_York`) |

`isWithinActiveHours(settings, tz, date)` — the predicate that drives the gate — lives in [`src/services/office-hours.js`](src/services/office-hours.js). Same helpers also used by `scheduler.js` for insert-time snapping.

## Data Model (migration 051)

```sql
ALTER TABLE scheduled_calls
  ADD COLUMN bypass_office_hours BOOLEAN NOT NULL DEFAULT false;
```

One column. No new tables. Default `false` means cron-scheduled rows respect office hours.

## Override Semantics

| Caller | `bypass_office_hours` set to | Reason |
|---|---|---|
| Cron processors (`process*`) | `false` (default) | Respect office hours always |
| `scheduleRetry` | `false` (default) | Retries respect office hours |
| `scheduleCallback` | `false` (default) | Callback time is already snapped to office hours |
| `POST /calls/manual` with `immediate: true` | **`true`** | Service Manager explicitly clicked Call Now |
| `POST /calls/manual` with `immediate: false` | `false` | "Schedule for later" — honor office hours |

This decision lives **on the row, not in dispatcher arguments**. If the inline dispatcher poke after a manual insert fails, the next 2-min cron tick will still pick it up because the bypass flag is durable.

## The Three Steps in Detail

### Step A — Compute the in-window set

```js
const { rows: candidates } = await db.query(`
  SELECT DISTINCT sc.company_id, c.default_timezone AS tz,
         cs.business_hours_start, cs.business_hours_end,
         COALESCE(cs.include_weekends, false) AS include_weekends
    FROM scheduled_calls sc
    JOIN companies c ON c.id = sc.company_id
    LEFT JOIN call_settings cs ON cs.company_id = sc.company_id
   WHERE sc.status = 'pending' AND sc.scheduled_at <= NOW()
     AND sc.bypass_office_hours = false
`);

const inWindow = candidates
  .filter(co => co.business_hours_start && isWithinActiveHours(co, co.tz, new Date()))
  .map(co => co.company_id);
```

A tenant with no `business_hours_start` is treated as out-of-window (**fail closed** — no hours configured ⇒ don't dial).

### Step B — Bulk reschedule out-of-window rows

```js
for (const co of outOfWindow) {
  if (!co.business_hours_start) continue;             // can't compute next window
  const nextAt = getNextWindowStart(co, co.tz, now);
  await db.query(`
    UPDATE scheduled_calls
       SET scheduled_at = $2, updated_at = NOW()
     WHERE company_id = $1
       AND status = 'pending'
       AND scheduled_at <= NOW()
       AND bypass_office_hours = false
  `, [co.company_id, nextAt]);
}
```

Why **active reschedule** (not just filter):

- `/scheduled-calls` listings show accurate "next dial" timestamps.
- Subsequent cron ticks short-circuit (`scheduled_at > NOW()`) — no repeated work.
- Priority is preserved on the row; ordering when the window opens picks HIGH first.

### Step C — Add the in-window clause to the claim CTE

The existing concurrency CTE gets **one new WHERE clause** inside `due`:

```sql
AND (sc.company_id = ANY($2::int[])   -- in-window tenants
     OR sc.bypass_office_hours = true) -- manual-override rows always claimable
```

Everything else (per-tenant cap, system cap, priority ranking, same-phone dedup) **carries through unchanged**.

## Concrete Walk-Through

Scenario: it's **6:30 PM** in `America/New_York`. Tenant 4 has business hours 09:00–17:00. Tenant 1 has hours 18:00–22:00 (evening service).

1. Step A query finds both tenants with due rows.
2. `isWithinActiveHours` says: tenant 4 → out, tenant 1 → in.
3. Step B updates tenant 4's pending rows: `scheduled_at = tomorrow 09:00 ET`. Tenant 1's rows untouched.
4. Step C runs the claim CTE with `inWindow = [1]`. Only tenant 1's rows are eligible (plus any `bypass_office_hours=true` row from any tenant).
5. Result: tenant 4's rows sit until 09:00 tomorrow. Tenant 1 dials normally.

If a Service Manager for tenant 4 clicks **Call now** at 6:35 PM:
- Manual API inserts with `bypass_office_hours=true`.
- Inline dispatcher poke calls `claimPending(1, {companyId:4})`.
- Step A still treats tenant 4 as out-of-window — but Step C's clause `OR bypass_office_hours = true` lets *just this row* through.
- Step B does **not** reschedule it (it's protected by the `bypass_office_hours = false` filter).
- The call dials.

## Edge Cases

| Case | Behavior |
|---|---|
| Tenant has no `call_settings` row | Treated as out-of-window. Pending rows are NOT rescheduled (we don't know what window to use). Admin must set hours. |
| `business_hours_start = NULL` | Same — out-of-window, no auto-reschedule. |
| Weekend, `include_weekends = false` | `isWithinActiveHours` returns false → reschedule to Monday's window. |
| Row's `scheduled_at` is far future (e.g. tomorrow 10:00) | Excluded by Step A's `scheduled_at <= NOW()` — not considered. No-op. |
| Row's `job_date` already passed | Currently NOT auto-expired. Bumped to tomorrow morning, dials too late. Stale-row reconciliation is a separate plan. |

## Logging

Two log lines surface queue health:

```
Dispatcher: rescheduled out-of-window rows {companyId, count, nextAt}
Dispatcher: tenant has no business_hours — pending rows will not dispatch {companyId}
```

Operators can answer "why isn't my queue draining?" from logs alone.

---

# Putting It All Together

```
                       ┌─────────────────────────┐
                       │     Cron every 2 min    │
                       │     /scheduler/run      │
                       └────────────┬────────────┘
                                    │ runDispatcher(10)
                                    ▼
                       ┌─────────────────────────┐
                       │      claimPending       │
                       └────────────┬────────────┘
                                    │
                ┌───────────────────┼──────────────────┐
                ▼                   ▼                  ▼
        ╔═════════════╗   ╔════════════════╗  ╔════════════════╗
        ║   Reaper    ║   ║ Office-Hours   ║  ║  Concurrency   ║
        ║ orphaned    ║   ║  Step A/B/C    ║  ║  CTE: per-     ║
        ║ in_progress ║   ║ (Change 2)     ║  ║  tenant cap +  ║
        ║ → pending   ║   ║                ║  ║  priority +    ║
        ║             ║   ║                ║  ║  system cap    ║
        ║             ║   ║                ║  ║  (Change 1)    ║
        ╚═════════════╝   ╚════════════════╝  ╚════════════════╝
                                    │
                                    ▼
                       ┌─────────────────────────┐
                       │  Same-phone post-dedup  │
                       └────────────┬────────────┘
                                    │
                                    ▼
                       ┌─────────────────────────┐
                       │   Returned claimed rows │
                       │   → Retell dial         │
                       └─────────────────────────┘
```

Order of gates a row must pass to dial:

1. `status = 'pending'`
2. `scheduled_at <= NOW()`
3. `auto_dispatch_enabled = true` (cron path) **or** explicit `respectAutoFlag=false` (manual)
4. Tenant is in business hours **or** `bypass_office_hours = true`
5. Tenant has at least one free concurrency slot (`max_concurrent_calls - in_flight > 0`)
6. System has a free concurrency slot (`20 - sum(in_flight) > 0`)
7. No other `in_progress` row has the same phone number
8. Wins priority ordering against competing rows for the same slot

Fail any one, the row sits and tries again next tick.

---

# File Map

| File | Role |
|---|---|
| [`migrations/050_per_tenant_call_concurrency.sql`](migrations/050_per_tenant_call_concurrency.sql) | Concurrency schema |
| [`migrations/051_scheduled_calls_bypass_office_hours.sql`](migrations/051_scheduled_calls_bypass_office_hours.sql) | Bypass flag schema |
| [`src/db/scheduled-calls.js`](src/db/scheduled-calls.js) | `claimPending`, `insertScheduledCall`, `scheduleRetry`, `scheduleCallback` |
| [`src/services/call-priority.js`](src/services/call-priority.js) | `priorityRank`, `PRIORITY_RANK_SQL_CASE`, `computeInitialPriority`, `computeRetryPriority`, `daysUntilInTz` |
| [`src/services/office-hours.js`](src/services/office-hours.js) | `isWithinActiveHours`, `getNextWindowStart`, `snapToWindowStart` |
| [`src/services/scheduler.js`](src/services/scheduler.js) | `runDispatcher`, `runDailyJob`, the four `process*` functions |
| [`src/services/manual-call.js`](src/services/manual-call.js) | `triggerManualCall` (sets `call_priority='high'`, `bypass_office_hours=immediate`) |
| [`src/routes/manual-calls.js`](src/routes/manual-calls.js) | `POST /calls/manual` handler |
| [`src/routes/scheduler.js`](src/routes/scheduler.js) | `/scheduler/run`, `/scheduler/daily`, manual variants |
