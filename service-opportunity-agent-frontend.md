# Service Opportunity Follow Up (calling agent) — Frontend Integration Guide

> Companion to `service-opportunity-frontend.md` (which covers the read APIs:
> `GET /locations`, `GET /service-opportunities`, etc.). **This doc covers the
> new outbound-calling feature only.** Everything here is additive — no existing
> endpoint changed shape.

## 0. What shipped

A new voice agent, **"Service Opportunity Follow Up"**, that calls a customer
about their open (unbooked) service opportunities to get them scheduled. The
flow the frontend drives:

1. User browses service opportunities (existing `GET /service-opportunities`).
2. User **selects** one or more and hits "Schedule calls".
3. Frontend `POST`s the selected IDs to the new endpoint (§2).
4. Backend **groups** them, queues one call per group (dialing the customer),
   and the agent works through each opportunity on the call, booking the ones
   the customer agrees to.

There is **no per-opportunity "call now" button contract** here — the single
entry point is the batch `schedule-calls` endpoint; grouping is decided
server-side (§3).

---

## 1. New settings surfaces (existing pages, new rows)

### 1.1 Call Types page — `GET /call-type-configs`

A new row appears:

```json
{
  "type": "service_opportunity_followup",
  "name": "Service Opportunity Follow Up",
  "description": "Call the customer about open, unbooked service opportunities at one of their locations to get them booked.",
  "is_custom": false,
  "enabled": false,
  "begin_message": "Hi, this is {{representative_name}} calling from {{company_name}} for {{customer_name}}. I'm following up on some recommended service work at {{location_name}} — is now an okay time?",
  "general_prompt": "...",
  "voicemail_message": "..."
}
```

Editable via the existing `PATCH /call-type-configs/service_opportunity_followup`
contract (`enabled`, `begin_message`, `general_prompt`, `voicemail_message`).
**Ships disabled** — the company must enable it before calls can go out.

**This agent is deliberately different from the confirmation/quotation agents.**
It's a **consultative, multi-item** call, not a single-appointment confirmation,
so its prompt and variables are location/customer-centric — **not** the
job-centric `{{job_name}}`/`{{job_id}}`/`{{appointment_id}}`/`{{job_date}}`/
`{{total_amount}}` set the other agents use (there is no job or appointment).

Its opening/routing variables are `{{customer_name}}`, `{{location_name}}`,
`{{location_address}}`, `{{primary_contact_name}}`, `{{general_manager_name}}`,
and `{{service_opportunity_count}}`. The **detailed list of opportunities is
fetched by the agent at call time via a custom tool**,
`get_service_opportunities` (returns each item's id, work, *why it's
recommended* / inspection deficiency, estimated price, recurring-service flag,
and requested window) — not passed as a giant variable, exactly like the other
agents call `get_job` / `get_quotation`. The agent then books accepted items
with the `book_service_opportunity` write tool. All of this is server-side; the
frontend just posts the selected IDs (§2).

**If the Call Types UI hardcodes the known types**, add `service_opportunity_followup` so the new row renders.

### 1.2 Call Triggers page — `GET /call-trigger-configs`

A new row appears:

```json
{
  "trigger_type": "booking_service_opportunity",
  "enabled": false,
  "call_type": "service_opportunity_followup",
  "days_before": 0,
  "trigger_config": {},
  "description": "Call the customer about selected open service opportunities to get them booked. User-initiated from the UI — there is no automatic cron sweep for this trigger."
}
```

**This trigger is user-initiated only.** Unlike other triggers, there is no
daily cron sweep — calls are created solely by the `schedule-calls` endpoint
(§2). The row exists for settings visibility, the call-type mapping, and the
enable flag. `PATCH /call-trigger-configs/booking_service_opportunity` works as
for other triggers.

### 1.3 "Agent can make changes" gating

Whether the agent can **book during the call** is governed by the existing
`agent_can_make_changes` call setting (Call Settings page):

- **ON** → the agent books each accepted opportunity live (platform status → `booked`).
- **OFF** → the agent can't book; it captures the customer's intent, and the
  backend raises a follow-up todo for a human (see §5). No frontend change
  needed — this is the same toggle that already gates other write actions.

---

## 2. New endpoint — `POST /service-opportunities/schedule-calls`

Standard JWT auth. Schedules outbound calls for the selected opportunities.

### Request

```json
{
  "service_opportunity_ids": [3, 4, 5, 6],
  "immediate": false
}
```

| Field | Type | Notes |
|---|---|---|
| `service_opportunity_ids` | `number[]` | **Required**, non-empty. IDs from `GET /service-opportunities`. IDs not belonging to the company are silently ignored. |
| `immediate` | `boolean` | Optional, default `false`. `false` → queue for the next office-hours window. `true` → dial right away, bypassing office hours (use for a "call now" affordance). |

### Response `201`

```json
{
  "summary": { "groups": 3, "scheduled": 2, "skipped_missing_phone": 1, "duplicate": 0 },
  "results": [
    { "service_opportunity_ids": [3, 4], "status": "scheduled", "scheduled_call_id": 419 },
    { "service_opportunity_ids": [5, 6], "status": "scheduled", "scheduled_call_id": 420 },
    { "service_opportunity_ids": [7],    "status": "skipped_missing_phone" }
  ]
}
```

- `results` has **one entry per group** (not per selected ID). `service_opportunity_ids` lists the IDs that grouped into that call.
- `status` per group:
  - `scheduled` — a call was queued (`scheduled_call_id` included).
  - `skipped_missing_phone` — the customer had no usable phone; a todo was raised instead (§5), no call queued.
  - `duplicate` — an active (pending/in-progress) call already exists for exactly this group; nothing new queued.

### Errors
- `400` — `service_opportunity_ids` missing/empty.
- `404` — none of the IDs matched this company.
- `403` — no company context.

### Suggested UI
Show the `summary` back to the user ("2 calls scheduled, 1 skipped — missing
phone"). For `skipped_missing_phone`, link to the customer so they can add a
number. Grouping means the number of calls is usually **fewer** than the number
of selected items — surface that so it isn't surprising.

---

## 3. How grouping works (so the UI can set expectations)

Selected opportunities are merged into a **single call** when they share **all** of:
- same **location**
- same **customer**
- same **primary contact**
- same **service window** (exact `window_start` **and** `window_end`)

(`service_recurrence` may differ — it is not part of the key.) Anything not
sharing all four with another selected item gets its own call. Each grouped
call dials the **customer's** phone, and the agent is given every opportunity in
that group to work through on the one call.

Example: selecting 6 items where two pairs each share those four fields →
**4 calls** (2 grouped + 2 singles).

---

## 4. Call-outcome variables (call history / detail views)

If you render post-call extracted variables per `call_type`, a
`service_opportunity_followup` call carries:

| Field | Type | When present |
|---|---|---|
| `booking_outcome` | enum: `booked`, `partially_booked`, `declined`, `callback_requested`, `no_answer`, `needs_to_check` | always |
| `preferred_date` | string | when the customer agreed to book something |
| `callback_time` | string | when `booking_outcome = callback_requested` |
| `notes` | string | optional |

A booked opportunity's platform record (`GET /service-opportunities/:id`) will
show `status: "booked"` and a `booking` object under `additional_information`
(`booked_at`, `preferred_date`, `notes`, `retell_call_id`, `source: "agent"`).

---

## 5. Todos raised by this feature — `GET /todos`

Two todo types can surface from this flow (if the Todos UI switches on `type`
or `metadata.subject_kind`, add branches):

- **`MISSING_PHONE`** with `metadata.subject_kind = "service_opportunity"` —
  raised at schedule time when the selected group's customer has no usable
  phone. `metadata.service_opportunity_ids` lists the affected IDs.
- **`SERVICE_OPPORTUNITY`** (new type) — raised **post-call** when the customer
  wanted to book but the agent wasn't allowed to make changes
  (`agent_can_make_changes = false`), so a human must complete the booking.
  Metadata carries `booking_outcome`, `preferred_date`, `notes`,
  `retell_call_id`, and `call_summary`.

---

## 6. Enablement / rollout notes (coordinate with backend)

- The new call type, trigger, tool, and dynamic variables are **seeded
  automatically for new companies**. **Existing companies need a one-time
  backfill** (re-seed configs + re-register the Retell flow) before the agent
  works for them — ask backend to run it per company.
- After backfill, the company must **enable** the call type (and set
  `agent_can_make_changes` as desired) on the settings pages before any call
  is placed.

---

## 7. Not in this build
- No automatic/scheduled sweep — calls happen only from the `schedule-calls`
  endpoint.
- No ServiceTrade write-back yet — "booked" is recorded in our platform only;
  the CRM sync-back is a later phase.
- Per-opportunity (vs per-call) outcomes are not captured separately — the
  call carries one overall `booking_outcome`; individual bookings happen live
  via the in-call tool.
