# Clara Confirms Backend — Required Changes

This document lists all backend endpoints, scheduler logic, and DB changes required to support the current frontend.

> **Scheduler philosophy (matches collection_agent_backend):**  
> The scheduler is **batch-first**. A single button on the frontend ("Schedule calls") triggers `POST /scheduler/daily`, which scans **all existing jobs and quotations** for the company, applies eligibility rules, and queues calls for every eligible one automatically. Users never create individual scheduled calls — the scheduler does it en masse.

---

## 1. `GET /scheduled-calls` — List Queue ← **MISSING**

Frontend Scheduled Calls page calls `GET /scheduled-calls`.

### Query params

| Param | Type | Default |
|---|---|---|
| `status` | `pending\|in_progress\|completed\|failed\|cancelled` | — (all) |
| `call_type` | string | — |
| `is_test` | `true\|false` | `false` |
| `limit` | integer (max 200) | `50` |
| `offset` | integer | `0` |

### Response `200`

```json
{
  "scheduled_calls": [
    {
      "id": 3,
      "call_type": "customer_confirmation",
      "phone_number": "+919625694975",
      "job_id": "11",
      "job_date": null,
      "customer_name": "Shivam Koli",
      "technician_name": null,
      "customer_address": null,
      "status": "completed",
      "scheduled_at": "2026-05-25T12:03:32Z",
      "is_test": true,
      "attempt_number": 1,
      "max_attempts": 3,
      "failure_reason": null,
      "retell_call_id": "call_f8694dd4376323cf7837d65d816",
      "created_at": "2026-05-25T12:00:38Z",
      "updated_at": "2026-05-25T12:04:06Z",
      "job_title": "HVAC Inspection",
      "job_status": "scheduled"
    }
  ]
}
```

### SQL

```sql
SELECT sc.*,
       j.title  AS job_title,
       j.status AS job_status
FROM scheduled_calls sc
LEFT JOIN jobs j ON j.id::text = sc.job_id
WHERE sc.company_id = $1
  AND sc.is_test = $2
  -- optional: AND sc.status = $3
  -- optional: AND sc.call_type = $4
ORDER BY sc.scheduled_at ASC
LIMIT $n OFFSET $m
```

---

## 2. `DELETE /scheduled-calls/:id` — Cancel Pending Call ← **MISSING**

Frontend cancel (✕) button calls `DELETE /scheduled-calls/:id`.

### Logic
- Only allow cancel if `status IN ('pending', 'in_progress')`
- Set `status = 'cancelled'`, `updated_at = NOW()`

### Response `200`
```json
{ "message": "Scheduled call cancelled" }
```

### Response `404`
```json
{ "error": "Scheduled call not found or already completed/cancelled" }
```

---

## 3. `POST /scheduler/daily` — Batch Eligibility + Scheduling ← **NEEDS FULL IMPLEMENTATION**

This is the **core scheduler action**. The frontend "Schedule calls" button calls this endpoint.  
It must scan ALL jobs/quotations for the company, check eligibility, and queue calls.

Currently only ServiceTrade service requests are supported. Needs to be extended to support platform jobs, quotations, and the new trigger types.

### Current behaviour (ServiceTrade only)
```
For each company:
  For each enabled call_type_config (days_before):
    target_date = today + days_before
    jobs = servicetrade_service_requests WHERE window_start = target_date
    → INSERT INTO scheduled_calls ...
```

### Required behaviour (platform jobs + triggers)

The scheduler should read `call_trigger_configs` (not `call_type_configs`) to determine what conditions fire a call:

```
POST /scheduler/daily:

For each company:
  For each ENABLED call_trigger_config:

    ── scheduled_unconfirmed ──────────────────────────────────────────────
    target_date = today + trigger.days_before
    jobs = SELECT j.*
           FROM jobs j
           LEFT JOIN appointments a ON a.job_id = j.id
           WHERE j.company_id = company_id
             AND j.status = 'scheduled'
             AND j.scheduled_date = target_date
             AND (a.customer_confirmed IS NULL OR a.customer_confirmed = false)
             AND NOT EXISTS (
               SELECT 1 FROM scheduled_calls sc
               WHERE sc.job_id = j.id::text
                 AND sc.call_type = trigger.call_type
                 AND sc.status NOT IN ('failed', 'cancelled')
             )
    For each job:
      phone = job.customer_phone
      → INSERT INTO scheduled_calls (customer_name, phone, call_type, job_id, job_date,
                                     scheduled_at = snapToWindow(...), is_test=false)

    ── technician_unconfirmed ─────────────────────────────────────────────
    target_date = today + trigger.days_before
    jobs = SELECT j.*
           FROM jobs j
           LEFT JOIN appointments a ON a.job_id = j.id
           JOIN technicians t ON t.id = j.technician_id
           WHERE j.company_id = company_id
             AND j.status = 'scheduled'
             AND j.scheduled_date = target_date
             AND j.technician_id IS NOT NULL          -- must have assigned tech
             AND (a.technician_confirmed IS NULL OR a.technician_confirmed = false)
             AND NOT EXISTS (same dedup check as above)
    For each job:
      phone = technician.phone                        -- call TECHNICIAN not customer
      → INSERT INTO scheduled_calls (technician_name, phone, call_type='technician_confirmation', ...)

    ── quotation_pending ─────────────────────────────────────────────────
    quote_statuses = trigger.trigger_config.quote_statuses  (default: ['sent','viewed'])
    days_after_sent = trigger.trigger_config.days_after_sent (default: 3)
    cutoff = NOW() - days_after_sent days

    quotations = SELECT q.*, c.phone, c.full_name
                 FROM quotations q
                 JOIN customers c ON c.id = q.customer_id
                 WHERE q.company_id = company_id
                   AND q.status = ANY(quote_statuses)
                   AND q.created_at <= cutoff
                   AND NOT EXISTS (
                     SELECT 1 FROM scheduled_calls sc
                     WHERE sc.job_id = q.id::text           -- use quotation id as job_id
                       AND sc.call_type = trigger.call_type
                       AND sc.status NOT IN ('failed','cancelled')
                   )
    For each quotation:
      phone = customer.phone
      → INSERT INTO scheduled_calls (customer_name, phone, call_type='quotation_followup',
                                     job_id=quotation.id::text, ...)

    ── open_job_due_soon ─────────────────────────────────────────────────
    target_date = today + trigger.days_before
    only_if_tech = trigger.trigger_config.only_if_technician_assigned

    jobs = SELECT j.*
           FROM jobs j
           JOIN customers c ON c.id = j.customer_id
           WHERE j.company_id = company_id
             AND j.status = 'open'                   -- no appointment yet
             AND j.scheduled_date = target_date
             AND (only_if_tech = false OR j.technician_id IS NOT NULL)
             AND NOT EXISTS (same dedup check)
    For each job:
      phone = customer.phone
      → INSERT INTO scheduled_calls (customer_name, phone, call_type='customer_confirmation', ...)
```

### Response

```json
{ "ok": true, "created": 3, "skipped": 1 }
```

- `created`: new `scheduled_calls` rows inserted
- `skipped`: jobs/quotations already have a pending/completed call (dedup)

---

## 4. `call_trigger_configs` table — Seed 4th trigger type ← **MISSING**

Add `technician_unconfirmed` to the seed on company creation:

```sql
INSERT INTO call_trigger_configs (company_id, trigger_type, enabled, call_type, days_before, trigger_config)
VALUES
  (<id>, 'scheduled_unconfirmed',  false, 'customer_confirmation',  2, '{"retry_if_no_answer": true}'),
  (<id>, 'technician_unconfirmed', false, 'technician_confirmation', 1, '{}'),
  (<id>, 'quotation_pending',      false, 'quotation_followup',      3, '{"quote_statuses":["sent","viewed"],"days_after_sent":3}'),
  (<id>, 'open_job_due_soon',      false, 'customer_confirmation',   7, '{"only_if_technician_assigned": false}');
```

---

## 5. `call_type_configs` table — Seed `quotation_followup` ← **MISSING**

4th built-in call type must be seeded on company creation:

```sql
INSERT INTO call_type_configs
  (company_id, type, name, description, is_custom, enabled, begin_message, general_prompt)
VALUES (
  <company_id>,
  'quotation_followup',
  'Quotation Follow-up',
  'Follow up with the customer on a sent or viewed quotation that hasn''t been accepted yet.',
  false, false,
  'Hi {{customer_name}}, this is {{representative_name}} calling from {{company_name}}. I''m following up on the quote we recently sent you — do you have a moment to discuss it?',
  'You are {{representative_name}}, a friendly representative calling on behalf of {{company_name}}. Your goal is to follow up on a quotation that was sent but not yet accepted. Ask if they reviewed it and have questions. Do not make pricing decisions.'
);
```

---

## 6. New route file: `src/routes/scheduled-calls.js`

```javascript
const express = require('express');
const db = require('../db');
const { authenticate, getCompanyId } = require('../auth');
const logger = require('../utils/logger');

const router = express.Router();
router.use(authenticate);

// GET /scheduled-calls
router.get('/', async (req, res) => {
  const companyId = getCompanyId(req);
  const { status, call_type, is_test = 'false', limit = 50, offset = 0 } = req.query;

  const conditions = ['sc.company_id = $1', 'sc.is_test = $2'];
  const values = [companyId, is_test === 'true'];
  let i = 3;

  if (status)    { conditions.push(`sc.status = $${i++}`);    values.push(status); }
  if (call_type) { conditions.push(`sc.call_type = $${i++}`); values.push(call_type); }
  values.push(Math.min(Number(limit), 200), Number(offset));

  const { rows } = await db.query(
    `SELECT sc.*,
            j.title  AS job_title,
            j.status AS job_status
     FROM scheduled_calls sc
     LEFT JOIN jobs j ON j.id::text = sc.job_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY sc.scheduled_at ASC
     LIMIT $${i++} OFFSET $${i}`,
    values
  );
  return res.json({ scheduled_calls: rows });
});

// DELETE /scheduled-calls/:id
router.delete('/:id', async (req, res) => {
  const companyId = getCompanyId(req);
  const { rows } = await db.query(
    `UPDATE scheduled_calls
     SET status = 'cancelled', updated_at = NOW()
     WHERE id = $1 AND company_id = $2
       AND status IN ('pending', 'in_progress')
     RETURNING id`,
    [req.params.id, companyId]
  );
  if (rows.length === 0)
    return res.status(404).json({ error: 'Scheduled call not found or already completed/cancelled' });
  return res.json({ message: 'Scheduled call cancelled' });
});

module.exports = router;
```

Mount in `src/server.js`:
```javascript
const scheduledCallsRoutes = require('./routes/scheduled-calls');
app.use('/scheduled-calls', scheduledCallsRoutes);
```

---

## 7. Summary — Priority Order

| # | Change | Priority | Status |
|---|---|---|---|
| 1 | `GET /scheduled-calls` + route file | 🔴 High | ❌ Missing |
| 2 | `DELETE /scheduled-calls/:id` | 🔴 High | ❌ Missing |
| 3 | `POST /scheduler/daily` — platform jobs + all 4 trigger types | 🔴 High | ⚠️ Partial (ServiceTrade only) |
| 4 | `call_trigger_configs` seed — add `technician_unconfirmed` | 🟡 Medium | ❌ Missing |
| 5 | `call_type_configs` seed — add `quotation_followup` | 🟡 Medium | ❌ Missing |
| 6 | Mount `/scheduled-calls` in server.js | 🔴 High | ❌ Missing |

---

## 8. Dashboard Stats — `GET /dashboard/stats` ← **NEW**

A single endpoint that returns all metrics needed by the dashboard in one request.

---

### 8.1 Metric Groups & Definitions

#### Group 1 — Calls Performance

| Metric | Definition | Why it matters |
|---|---|---|
| `total_calls` | COUNT of calls in the period (excl. test) | Volume of outreach |
| `confirmation_rate` | calls where `appointment_confirmed='yes'` / total analyzed calls (%) | Primary KPI — are customers confirming? |
| `outcome_breakdown` | Count per outcome: `confirmed`, `not_confirmed`, `unclear`, `voicemail`, `no_answer` | Diagnose why confirmation rate is low |
| `avg_duration_ms` | AVG `duration_ms` of analyzed calls | Shorter = efficient; too short = incomplete |
| `sentiment_breakdown` | Count per sentiment: `Positive`, `Neutral`, `Negative`, `Unknown` | Gauge customer reception |
| `calls_by_type` | Count per `call_type` (customer_confirmation, quotation_followup, etc.) | Which call type drives the most volume |

#### Group 2 — Jobs Overview

| Metric | Definition | Why it matters |
|---|---|---|
| `jobs_due_soon` | Jobs with `scheduled_date` within next 7 days AND `status != 'completed'` AND `status != 'cancelled'` | Immediate action window |
| `jobs_unconfirmed` | Jobs with `status='scheduled'` AND no appointment where `customer_confirmed=true` | Jobs that still need a call |
| `jobs_by_status` | Count per job status: `open`, `scheduled`, `confirmed`, `in_progress`, `completed`, `cancelled` | Portfolio health |
| `job_confirmation_rate` | Jobs with `status IN ('confirmed','completed')` / total non-cancelled jobs (%) | How many jobs are confirmed end-to-end |

#### Group 3 — Action Items (Todos)

| Metric | Definition | Why it matters |
|---|---|---|
| `open_todos` | COUNT todos with `status='open'` (production only, `is_test=false`) | Immediate follow-up backlog |
| `high_priority_open` | COUNT todos with `status='open'` AND `priority='high'` | Urgent items needing attention today |
| `todos_by_type` | Count per `type`: NOT_PICKED, VOICEMAIL, ASKED_FOR_RESCHEDULE, ASKED_FOR_CANCELLATION, UNCONFIRMED | Which outcome type generates the most work |
| `resolution_rate` | todos with `status IN ('resolved','dismissed')` / total todos in period (%) | Team follow-up effectiveness |

#### Group 4 — Scheduled Call Queue

| Metric | Definition | Why it matters |
|---|---|---|
| `queue_pending` | COUNT scheduled_calls with `status='pending'` AND `is_test=false` | How many calls are waiting to fire |
| `queue_failed` | COUNT scheduled_calls with `status='failed'` AND `is_test=false` | Calls that exhausted retries, need manual action |
| `dispatch_success_rate` | completed / (completed + failed) for `is_test=false` in period (%) | Scheduler reliability |
| `queue_by_call_type` | COUNT pending per `call_type` | Which call types are building up |

#### Group 5 — Quotations

| Metric | Definition | Why it matters |
|---|---|---|
| `quotations_pending` | COUNT quotations with `status IN ('sent','viewed')` | Revenue pipeline not yet closed |
| `quotation_acceptance_rate` | accepted / (accepted + rejected + expired) in period (%) | Sales conversion rate |
| `quotations_by_status` | Count per status: draft, sent, viewed, accepted, rejected, expired | Full funnel view |

#### Group 6 — Customers

| Metric | Definition | Why it matters |
|---|---|---|
| `total_active_customers` | COUNT customers with `is_active=true` | Company's active portfolio size |
| `customers_with_upcoming_jobs` | DISTINCT customer_ids with a job `scheduled_date` in next 7 days | Customers in the immediate action window |
| `customers_with_open_todos` | DISTINCT customer_ids linked to open todos | Customers needing follow-up |

---

### 8.2 Endpoint Specification

#### `GET /dashboard/stats` 🔒

**Query params:**

| Param | Values | Default | Notes |
|---|---|---|---|
| `period` | `today` \| `week` \| `month` \| `all` | `week` | Applies to time-bounded metrics (calls, todos, scheduled_calls) |

**Period definitions:**

| Period | Window |
|---|---|
| `today` | `DATE_TRUNC('day', NOW())` to `NOW()` |
| `week` | Last 7 days rolling (`NOW() - INTERVAL '7 days'` to `NOW()`) |
| `month` | Last 30 days rolling |
| `all` | All time (no date filter) |

> Non-time-bounded metrics (active customers, pending queue, open todos) always return current state regardless of `period`.

**Response `200`:**

```json
{
  "period": "week",
  "generated_at": "2026-05-28T10:00:00Z",

  "calls": {
    "total": 37,
    "analyzed": 31,
    "confirmation_rate": 61.3,
    "avg_duration_ms": 42000,
    "outcome_breakdown": {
      "confirmed": 19,
      "not_confirmed": 8,
      "unclear": 10,
      "voicemail": 4,
      "no_answer": 2
    },
    "sentiment_breakdown": {
      "Positive": 22,
      "Neutral": 8,
      "Negative": 1,
      "Unknown": 6
    },
    "by_call_type": {
      "customer_confirmation": 27,
      "quotation_followup": 10
    }
  },

  "jobs": {
    "total": 9,
    "due_soon": 2,
    "unconfirmed": 3,
    "confirmation_rate": 44.4,
    "by_status": {
      "open": 1,
      "scheduled": 2,
      "confirmed": 3,
      "in_progress": 0,
      "completed": 1,
      "cancelled": 2
    }
  },

  "todos": {
    "open": 13,
    "high_priority_open": 5,
    "resolution_rate": 26.3,
    "by_type": {
      "NOT_PICKED": 4,
      "VOICEMAIL": 3,
      "ASKED_FOR_RESCHEDULE": 2,
      "ASKED_FOR_CANCELLATION": 1,
      "UNCONFIRMED": 3
    }
  },

  "queue": {
    "pending": 0,
    "failed": 0,
    "dispatch_success_rate": 100.0,
    "by_call_type": {
      "customer_confirmation": 0,
      "quotation_followup": 0
    }
  },

  "quotations": {
    "pending": 1,
    "acceptance_rate": null,
    "by_status": {
      "draft": 0,
      "sent": 1,
      "viewed": 0,
      "accepted": 0,
      "rejected": 0,
      "expired": 0
    }
  },

  "customers": {
    "total_active": 3,
    "with_upcoming_jobs": 2,
    "with_open_todos": 4
  }
}
```

---

### 8.3 SQL Sketches

**Confirmation rate:**
```sql
SELECT
  COUNT(*) FILTER (WHERE appointment_confirmed = 'yes')::float /
  NULLIF(COUNT(*) FILTER (WHERE status = 'analyzed'), 0) * 100 AS confirmation_rate
FROM calls
WHERE company_id = $1 AND is_test = false AND created_at >= $period_start;
```

**Jobs unconfirmed (scheduled but no customer confirmation):**
```sql
SELECT COUNT(DISTINCT j.id)
FROM jobs j
WHERE j.company_id = $1
  AND j.status = 'scheduled'
  AND NOT EXISTS (
    SELECT 1 FROM appointments a
    WHERE a.job_id = j.id AND a.customer_confirmed = true
  );
```

**Queue success rate:**
```sql
SELECT
  COUNT(*) FILTER (WHERE status = 'completed')::float /
  NULLIF(COUNT(*) FILTER (WHERE status IN ('completed', 'failed')), 0) * 100
FROM scheduled_calls
WHERE company_id = $1 AND is_test = false AND created_at >= $period_start;
```

---

### 8.4 Route file

```javascript
// src/routes/dashboard.js
const express = require('express');
const db = require('../db');
const { authenticate, getCompanyId } = require('../auth');
const router = express.Router();
router.use(authenticate);

router.get('/stats', async (req, res) => {
  const companyId = getCompanyId(req);
  const period = req.query.period || 'week';
  // ...aggregate queries...
  return res.json({ period, generated_at: new Date().toISOString(), calls: {}, jobs: {}, todos: {}, queue: {}, quotations: {}, customers: {} });
});

module.exports = router;
```

Mount in `server.js`:
```javascript
const dashboardRoutes = require('./routes/dashboard');
app.use('/dashboard', dashboardRoutes);
```

---

### 8.5 Frontend TypeScript type (for reference)

```typescript
export interface DashboardStats {
  period: 'today' | 'week' | 'month' | 'all';
  generated_at: string;
  calls: {
    total: number;
    analyzed: number;
    confirmation_rate: number;        // 0–100
    avg_duration_ms: number | null;
    outcome_breakdown: { confirmed: number; not_confirmed: number; unclear: number; voicemail: number; no_answer: number };
    sentiment_breakdown: { Positive: number; Neutral: number; Negative: number; Unknown: number };
    by_call_type: Record<string, number>;
  };
  jobs: {
    total: number;
    due_soon: number;
    unconfirmed: number;
    confirmation_rate: number;
    by_status: Record<string, number>;
  };
  todos: {
    open: number;
    high_priority_open: number;
    resolution_rate: number;
    by_type: Record<string, number>;
  };
  queue: {
    pending: number;
    failed: number;
    dispatch_success_rate: number | null;
    by_call_type: Record<string, number>;
  };
  quotations: {
    pending: number;
    acceptance_rate: number | null;
    by_status: Record<string, number>;
  };
  customers: {
    total_active: number;
    with_upcoming_jobs: number;
    with_open_todos: number;
  };
}
```
