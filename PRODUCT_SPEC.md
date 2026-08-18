# Clara Confirms — Product Specification

**Status:** Living document · reflects the system as built on `feat/confirmation-chat`
**Owner:** Product / Engineering
**Last updated:** 2026-08-04

---

## 1. Overview

### 1.1 What Clara Confirms is

Clara Confirms is a multi-tenant AI communication layer for commercial field-service
contractors. It sits on top of the contractor's existing CRM/FSM system (ServiceTrade
today; BuildOps and ServiceTitan are planned) and autonomously runs the outbound
customer and technician conversations that office staff would otherwise make by hand:
appointment confirmations, technician availability checks, quotation follow-ups, and
follow-ups on unbooked service opportunities.

Every conversation is executed either by a voice AI agent (Retell) or by a link-based
web chat widget running Clara's own in-house agent. Every outcome is written back — into the platform's own
records, into a human work queue ("todos"), and, where enabled, back into the CRM as
comments, appointment changes, and emailed service links.

### 1.2 The problem

Commercial field-service contractors lose measurable revenue and technician hours to
unconfirmed work:

- **No-shows and wasted truck rolls.** A technician drives to a site where nobody is
  expecting them, or the site is inaccessible. The cost is a full labor hour plus fuel,
  and the job still has to be rescheduled.
- **Manual confirmation is unbounded work.** Confirming tomorrow's jobs is a phone-call
  treadmill that scales linearly with job volume. It is the first thing dropped when the
  office is busy — exactly when job volume is highest.
- **Quotes and service opportunities go stale.** Inspection deficiencies and sent quotes
  sit unbooked because nobody has time to chase them. This is unrealized revenue already
  sitting in the CRM.
- **The CRM is not the source of truth about intent.** ServiceTrade knows a job is
  scheduled. It does not know the customer asked to move it to Thursday, or that the site
  contact changed, unless a human types that in.

### 1.3 The solution

Clara Confirms syncs the contractor's CRM into a normalized platform data model, applies
per-tenant **trigger rules** to decide who should be contacted and when, queues the
contact, dispatches it over the right **channel**, lets an AI agent hold a real
conversation with tools that can actually change records, and then closes the loop:
updates the appointment, writes back to the CRM, and raises a human todo for anything the
agent could not resolve.

### 1.4 Who it is for

| Persona | Role | What they need |
|---|---|---|
| **Office manager / dispatcher** | Primary daily user | Confirmed jobs by tomorrow morning; a short list of exceptions to handle personally |
| **Operations lead / owner** | Buyer | Fewer no-shows, more booked opportunities, no added headcount |
| **Service manager** | Configurator | Control over which conversations run, what the agent may change, and business hours |
| **Field technician** | Contact target | A 30-second call or text to confirm tomorrow's assignment |
| **End customer** | Contact target | A non-annoying confirmation they can answer in any channel they prefer |

### 1.5 Product principles

1. **The CRM stays the system of record.** Clara reads from it and writes back to it. It
   never asks the contractor to abandon ServiceTrade.
2. **Autonomy with a human floor.** Anything the agent cannot resolve becomes a todo. The
   system never silently drops a customer intent.
3. **Everything is per-tenant configurable and off by default.** New capabilities
   (write-back, service links, SMS, agent write tools) ship disabled and are opted into.
4. **Every action is auditable.** Calls, transcripts, todo state changes, sync runs, and
   message sends all persist with full history.

---

## 2. Goals and non-goals

### 2.1 Goals

- **G1** — Automate outbound confirmation of scheduled work without human initiation.
- **G2** — Reach the contact on whatever channel actually works: a voice call, or a web
  chat link delivered by email, SMS, or both.
- **G3** — Let the agent *resolve* the conversation (confirm, reschedule, cancel, book),
  not just record it.
- **G4** — Push every resolution back to the CRM so office staff never re-key anything.
- **G5** — Surface a bounded exception queue so staff know exactly what still needs a human.
- **G6** — Convert unbooked service opportunities and pending quotes into scheduled work.
- **G7** — Give operators a settings surface and an in-app AI copilot to run the system
  without engineering involvement.

### 2.2 Non-goals

- **Not a CRM or FSM replacement.** No invoicing, dispatch board, inventory, or payroll.
- **Not inbound call handling.** All flows are outbound-initiated (the link-based web chat
  is customer-initiated but still originates from a link Clara sent).
- **Not a general marketing/campaign tool.** Conversations are transactional and tied to a
  specific job, appointment, quote, or opportunity.
- **Not a technician mobile app.** Technicians are contact targets, not app users.

---

## 3. Concepts and domain model

### 3.1 Two-layer data model

Clara maintains a strict separation between raw CRM payloads and its own normalized model.

```
ServiceTrade API
      │  full lossless payloads
      ▼
servicetrade_* raw mirror tables      ← "what we synced", auditable, never lossy
      │  normalize
      ▼
Platform tables (customers, locations, jobs, appointments,
technicians, contacts, service_requests, service_opportunities)
      │
      ▼
Triggers → scheduled_calls → agent conversation → calls / todos / CRM write-back
```

Every platform row carries `source` (e.g. `'servicetrade'`), `external_ref` (the source
system's id), and an `additional_information` JSONB overflow column. This is what makes
the model CRM-agnostic: a second provider writes into the same platform tables with a
different `source`.

### 3.2 Core entities

| Entity | Meaning |
|---|---|
| **Company** | The tenant. Owns all data, credentials, settings, and its own Retell agents. |
| **User** | A staff member of a company. JWT-authenticated, role-scoped. |
| **Customer** | The account/entity being served. Unique per `(company, phone)`. |
| **Location** | A physical site, with its own contacts, offices, and tags. |
| **Contact** | A person at a location or job, with a role (management, billing, on-site). |
| **Job** | A unit of work. Has status, type, location, primary contact, and a due date. |
| **Appointment** | A scheduled visit against a job. Owns the hard time window, technician assignment, and the `customer_confirmed` / `technician_confirmed` flags. |
| **Technician** | A field resource who can be assigned and asked to confirm. |
| **Service request** | A ServiceTrade service request, job-linked or not. |
| **Service opportunity** | A *jobless* service request — unbooked, revenue-bearing work, typically an inspection deficiency. |
| **Scheduled call** | A queued outbound contact: who, why, when, which channel, which attempt. |
| **Call** | An executed conversation with transcript, analysis, sentiment, and outcome. |
| **Todo** | A human work item created when the agent could not fully resolve something. |
| **Engine run** | A long-running background operation (CRM sync, scheduler run) streamed live over SSE. |

### 3.3 Job and appointment lifecycle

Job status: `open → scheduled → confirmed → in_progress → completed`, plus `rescheduled`
and `cancelled`.
Appointment status: `scheduled → confirmed → completed`, plus `rescheduled`, `cancelled`,
`no_show`.

Confirmation is tracked on the **appointment**, not the job — a job with three visits can
be confirmed for one and not the others.

---

## 4. Feature specification

### 4.1 CRM integration (ServiceTrade)

**Purpose:** get the contractor's operational data into Clara with zero manual entry.

**Requirements**

- **F1.1** Per-company credentials. The connect form takes a ServiceTrade username and
  password; the backend authenticates, captures the session cookie, and stores **only the
  cookie**. The password is never persisted.
- **F1.2** Two-step sync in one operation: pull raw payloads into `servicetrade_*` mirror
  tables, then normalize into platform tables.
- **F1.3** Job-centric sync: list jobs, fetch full job detail, fetch that job's
  appointments. Captures service requests, notes, scheduling comments, tags, project,
  contract, external ids, owner, sales office, and full technician/office assignments.
- **F1.4** Incremental sync — only changed records after the first full pull.
- **F1.5** Automatic sync every 2 hours via cron, plus an on-demand manual trigger from
  the UI.
- **F1.6** Sync progress streams live to the UI via SSE (the `crm-sync` engine), with
  state history persisted so a reconnecting client replays from the correct sequence.
- **F1.7** Sync status, last-run time, and last error are readable per company.
- **F1.8** Configurable entity types — a tenant chooses which ServiceTrade entity types
  are in scope.
- **F1.9** Provider abstraction: every CRM implements the same `CrmProvider` interface and
  is exposed at `/integrations/{slug}/*`. Adding BuildOps or ServiceTitan must not change
  any downstream consumer.

**Acceptance criteria**
- A new tenant connects and sees customers, locations, jobs, appointments, and technicians
  populated within one sync run.
- Re-running sync is idempotent — no duplicate platform rows (enforced by unique indexes
  on `(company_id, external_ref, source)`).
- A ServiceTrade outage fails the run with a recorded error and does not corrupt platform
  data.

### 4.2 Trigger engine — deciding who to contact

**Purpose:** turn "state of the business" into a queue of outbound conversations, with no
human deciding each one.

Five built-in triggers, each independently enabled and configured per tenant. **All ship
disabled.**

| Trigger | Fires when | Default call type |
|---|---|---|
| `scheduled_unconfirmed` | A job is scheduled and the customer has not confirmed | `customer_confirmation` |
| `technician_unconfirmed` | An appointment has an assigned technician who has not confirmed availability | `technician_confirmation` |
| `open_job_due_soon` | A job is still open (unscheduled) and its expected date is approaching | `customer_confirmation` |
| `quotation_pending` | A quote is sent/viewed but not accepted after N days | `quotation_followup` |
| `booking_service_opportunity` | **User-initiated** from the UI against selected open opportunities — no cron sweep | `service_opportunity_followup` |

**Requirements**

- **F2.1** Each trigger has: `enabled`, target `call_type`, `days_before` lead time, and a
  JSONB `trigger_config` for trigger-specific options (e.g. `retry_if_no_answer`,
  `quote_statuses`, `days_after_sent`, `only_if_technician_assigned`).
- **F2.2** Triggers are seeded idempotently on company registration.
- **F2.3** A cron sweep evaluates enabled triggers and enqueues `scheduled_calls`. This
  sweep is gated by `auto_schedule_enabled`.
- **F2.4** Deduplication — an in-flight or already-completed contact for the same
  job/appointment and call type must not be enqueued twice (enforced by a DB dedup index).
- **F2.5** A missing phone number produces a `MISSING_PHONE` todo instead of a failed
  call; a missing email in a web-chat-only tenant produces `MISSING_EMAIL`.

**Acceptance criteria**
- Enabling `scheduled_unconfirmed` with `days_before: 2` results in exactly one queued
  call per unconfirmed appointment two days out.
- Disabling a trigger stops new enqueues but does not cancel already-queued calls.

### 4.3 Channel resolution

**Purpose:** reach the contact where they will actually respond, and degrade safely.

A single choke point resolves every outbound contact to a `{channel, linkDelivery}`
pair — `channel` is `voice` or `web_chat`; `linkDelivery` (`email` | `sms` | `both` |
`null`) says how a `web_chat` send is delivered. All trigger, retry, and callback
paths go through it — the logic is never re-derived.

**Per-customer channel flags** (`customers.is_voice` / `is_sms` / `is_email`,
independent booleans, at least one required) replaced the old single-valued
`preferred_channel` — a customer can now want more than one channel (e.g. sms +
email together), which a single enum couldn't express. Combination rule:

- `is_voice = true` → **voice only**, until every voice retry is exhausted; `is_sms`/
  `is_email` are then used as a one-time fallback — never simultaneous with a live
  voice attempt.
- `is_voice = false` → `is_sms` and `is_email` fire **simultaneously** (both are just
  delivery methods for the one chat-link confirmation).

**Resolution order**

1. `channel_strategy = web_chat_only` → **web_chat** (this path has no SMS/A2P dependency,
   so it is evaluated first) — only consulted when no customer flags are resolvable
   (e.g. a call type with no linked customer row); flags are authoritative otherwise.
2. If the company's `sms_status` is not `live` → the `is_sms` flag is dropped from
   consideration (never the `is_email` flag). Hard safety net; never relies on the UI
   having blocked an invalid state.
3. Customer-requested callback → always **voice** — a callback is only ever requested
   during a live voice conversation, so there is no link-delivery variant of it.
4. Otherwise: `is_voice` and not yet exhausted → voice; else the flag-derived
   `linkDelivery` (sms/email/both) → web_chat; else voice as the last resort (e.g. an
   sms-only customer at a company whose SMS isn't live).
5. No customer flags resolvable → falls back to the company `channel_strategy`:
   `sms_only` → web_chat/sms; `voice_then_sms_fallback` → voice on attempt 1, web_chat/sms
   on retries; `voice_only` → voice.

**Requirements**

- **F3.1** SMS requires an ops-tracked rollout state per company
  (`not_configured → pending_approval → live`), because carrier A2P approval is not
  queryable from the provider API.
- **F3.2** `web_chat` dispatch delivers a tokenized chat link by email, SMS, or both,
  per the resolved `linkDelivery` (per-customer flags take priority; `chat_link_delivery_method`
  is the company-level fallback for rows queued before a customer's flags were resolvable).
- **F3.3** Channel is recorded on both the queued call (`scheduled_calls.channel` +
  `link_delivery`) and the executed call, so analytics can compare channel performance.
- **F3.4** Voice retries exhausted (no answer through `max_attempts`) with an sms/email
  flag on file → one chat-link send instead of going silently terminal. Never triggers
  from a row that is itself already a link send (no fallback-of-a-fallback).
- **F3.5** Chat links expire 24h after creation (`chat_links.expires_at`); an unopened
  link at that point is treated as the link equivalent of a voice no-answer and
  automatically re-queues (voice if `is_voice`, else a fresh link), capped at the same
  `max_attempts` as any other retry chain.

### 4.4 Scheduling and dispatch

**Purpose:** fire the queued contact at a legal, sensible time, with retries.

**Requirements**

- **F4.1** Office-hours enforcement. Calls outside `business_hours_start`–
  `business_hours_end` in the company's timezone are advanced to the next window start,
  not dropped. Weekends excluded unless `include_weekends` is on.
- **F4.2** Per-row `bypass_office_hours` for explicitly urgent contacts.
- **F4.3** Retries up to `max_attempts` (default 3), with priority classes
  `normal | retry | callback`.
- **F4.4** Voicemail behavior is configurable (`leave` / skip) with a templated voicemail
  message supporting `{{representative_name}}` and `{{company_name}}`.
- **F4.5** Per-tenant concurrency cap so one large tenant cannot starve others.
- **F4.6** Two independent kill switches: `auto_schedule_enabled` (stop enqueuing) and
  `auto_dispatch_enabled` (stop firing). A manual UI run may fire regardless of the auto
  flag; the system cron may not.
- **F4.7** Callback scheduling — when a contact asks to be called back at a specific time,
  a new queued call is created at that time.
- **F4.8** Staff can view the pending queue and cancel individual entries.
- **F4.9** Manual "Call now" for any call type against any target.
- **F4.10** Every dispatch decision is logged with an explicit reason (due / not due /
  outside hours / skipped), so operators can answer "why didn't this call go out?"
- **F4.11** Manual, per-job confirmation selection: with `auto_schedule_enabled=false`,
  staff select specific jobs on the Inspections page and bulk-queue confirmations
  (`POST /jobs/bulk-send-confirmation`) through the identical per-job enqueue logic the
  automatic sweep uses (same channel resolution, contact-completeness gating, and
  dedupe) — so the manual and automatic paths never silently disagree about whether a
  given job is eligible. Still queues through the normal dispatcher (office hours,
  concurrency caps apply), it does not send inline. `GET /jobs` supports multi-value
  `status`/`job_type`/`customer_id`/`location_id` filters and a `confirmed` filter to
  make that selection practical.

**Acceptance criteria**
- A call queued for 8:00 PM in a 9–5 tenant fires at 9:00 AM the next business day.
- Killing `auto_dispatch_enabled` mid-day stops all system-initiated calls within one
  cron cycle while leaving the queue intact.

### 4.5 The conversational agent

**Purpose:** hold a real conversation that ends in a resolved record, not a transcript.

Each call type maps to a configured agent with its own greeting (`begin_message`), system
prompt (`general_prompt`), and voice. Agents are provisioned per company into Retell, and
prompts sync from Clara's configuration.

**Agent tools** (each individually enableable; write tools additionally gated by the
tenant-level `agent_can_make_changes` flag):

*Read*
- `get_appointments` — every appointment on the job: how many are upcoming, which is
  next, and each one's date, technician, service line and confirmation status. The only
  source of appointment data — the job's own details are injected into the prompt
  instead, since they don't change mid-conversation while appointments do
- `get_quotation` — title, total, status, line items, validity
- `get_service_opportunities` — open opportunities for this call, with the deficiency
  rationale, estimated price, recurrence, and requested window
- `search_contact` — find an existing CRM contact before creating a duplicate

*Write*
- `confirm_appointment` — mark customer or technician confirmed
- `reschedule_appointment` — move an existing appointment to a new time
- `reschedule_job` — move the whole job to a different day
- `create_appointment` — book a slot when none exists
- `cancel_appointment` — requires the agent to first ask (a) appointment-only vs. entire
  job, and (b) the reason
- `create_contact` — record who should receive the emailed service link, reusing an
  existing contact when one was confirmed

**Requirements**

- **F5.1** Dynamic variables (customer name, job details, appointment time, company name,
  representative name) are hydrated into the agent context at dispatch.
- **F5.2** Tool definitions are data, not code — stored per company, versioned, and
  editable without a deploy.
- **F5.3** A tool may be gated on a specific setting; a disabled setting removes the tool
  from the agent entirely rather than letting it fail at call time.
- **F5.4** Webhook signature verification on all inbound provider events; tool webhooks
  are protected by a shared secret.
- **F5.5** Post-call analysis captures: confirmation outcome (`yes`/`no`/`unclear`),
  reschedule requested, cancellation requested, sentiment, voicemail detection,
  disconnection reason, and duration.
- **F5.6** Configurable call-analysis priority rules per tenant.

**Acceptance criteria**
- A customer saying "can we do Thursday instead?" results in a rescheduled appointment in
  both Clara and ServiceTrade, with no todo raised.
- With `agent_can_make_changes = false`, the same conversation results in an
  `ASKED_FOR_RESCHEDULE` todo and no record mutation.

### 4.6 Web chat links

**Purpose:** the non-voice channel — and the one that sidesteps SMS/A2P approval entirely
when the link is delivered by email.

**Requirements**

- **F6.1** An opaque, unguessable token resolves to a specific job or appointment's
  conversation context.
- **F6.2** Links expire 24h after creation and track `last_opened_at`, delivery status,
  origin, and per-send events.
- **F6.3** The public resolve endpoint is token-authed only — no login, no tenant leakage.
- **F6.4** The chat widget runs Clara's own in-house agent (LangGraph over the platform
  data model), not the provider-hosted voice flow. Its toolset is **phase-gated**: the
  conversation's phase is computed in code (`confirming` / `all_confirmed` /
  `no_appointment`) and only the tools valid for that phase are bound to the model — so an
  already-confirmed conversation structurally *cannot* call `confirm_appointment`. Tools:
  `confirm_appointment`, `confirm_job_appointments`, `list_upcoming_appointments`,
  `reschedule_appointment`, `cancel_appointment`, `create_appointment`,
  `resolve_service_link_contact`, `get_service_link`, `report_customer_intent`, and
  `end_conversation` (always available).
- **F6.5** Chat state persists across page loads so a customer can return to an
  in-progress conversation.
- **F6.6** Links are generated by staff on demand *and* dispatched automatically by the
  scheduler for `web_chat_only` tenants.

### 4.7 Todos — the human exception queue

**Purpose:** guarantee no customer intent is lost, and bound the work staff must do.

**Types:** `NOT_PICKED`, `VOICEMAIL`, `UNCONFIRMED`, `ASKED_FOR_RESCHEDULE`,
`ASKED_FOR_CANCELLATION`, `APPOINTMENT_NEEDED`, `APPOINTMENT_CANCELLED`,
`SERVICE_OPPORTUNITY`, `SERVICE_LINK`, `CRM_SYNC`, `MISSING_PHONE`, `MISSING_EMAIL`.

**Requirements**

- **F7.1** Todo type is derived automatically from call analysis — voicemail detection and
  disconnection reason take precedence over conversational outcome.
- **F7.2** Lifecycle `open → in_progress → resolved | dismissed`, with priority
  `high | medium | low` and optional assignment to a user.
- **F7.3** Every state change writes an audit row (`todo_logs`) recording actor, actor
  type (user vs. system), event type, and the change.
- **F7.4** Todos link back to the originating call, so staff can read the transcript
  before acting.
- **F7.5** Test calls never generate real todos.

**Acceptance criteria**
- A call that reaches voicemail on the final attempt leaves exactly one `VOICEMAIL` todo.
- A resolved todo records who resolved it and when.

### 4.8 CRM write-back

**Purpose:** close the loop so office staff never re-key what the agent already learned.

**Requirements**

- **F8.1** **Appointment write-back** — confirmations, reschedules, cancellations, and new
  bookings push to ServiceTrade.
- **F8.2** **Comment write-back** (`crm_comment_writeback_enabled`, default off) — a call
  summary is posted as a comment on the CRM job.
- **F8.3** **Service link delivery** (`service_link_enabled`, default off) — after a
  confirmed customer-confirmation call, the job's ServiceTrade Service Link is emailed to
  the contact resolved or created live during the call.
- **F8.4** Every service-link send is tracked with lifecycle status
  (`pending | sent | failed | skipped`), the provider message id, and the error. Anything
  not sent surfaces as a `SERVICE_LINK` todo.
- **F8.5** Write-back failures never fail the call — they degrade to a todo.

### 4.9 Service opportunities

**Purpose:** convert already-identified, unbooked work into scheduled revenue.

**Requirements**

- **F9.1** Jobless service requests are surfaced as browsable opportunities with the full
  nested context — location, primary contact, customer, deficiency, contract, service
  line, recurrence, change order — in a single response. The UI never makes a second
  request to resolve a relation.
- **F9.2** Filterable by location and by office.
- **F9.3** Staff select opportunities and launch a `service_opportunity_followup` call.
  The agent is briefed with each item's work description, the deficiency rationale, the
  estimated price, and the requested window.
- **F9.4** Unresolved opportunities become `SERVICE_OPPORTUNITY` todos.

### 4.10 AI Copilot

**Purpose:** let an operator run and interrogate the system in natural language.

Built on LangGraph with Postgres checkpointing; responses stream over SSE.

**Read tools:** find/get customer, count unconfirmed jobs, count unconfirmed appointments
for a customer, list jobs, list open todos, list calls, get call, analytics summary, list
voices, get agent config, get call settings, find call targets.

**Write tools:** set todo status, update agent config, update call settings, enable/disable
a call trigger, make a call, schedule a call, run the scheduler.

**Requirements**

- **F10.1** Tools are registry-driven — adding a capability means adding a handler file,
  with no graph or loop changes.
- **F10.2** Tool availability is governed by a per-tenant catalog table (enable/disable).
- **F10.3** Write tools are additionally gated per request by `agent_can_make_changes`.
- **F10.4** Every handler is tenant-scoped at call time; no tool can read across tenants.
- **F10.5** Conversation state persists across sessions.

### 4.11 Analytics and dashboard

A single stats endpoint, period-filterable, excluding test data.

| Group | Metrics |
|---|---|
| **Calls** | Total, analyzed, confirmation rate, average duration, outcome breakdown (confirmed / not confirmed / unclear / voicemail / no answer), sentiment breakdown, calls by type |
| **Jobs** | Total, due within 7 days, unconfirmed, confirmation rate, full status breakdown |
| **Todos** | Open, high-priority open, resolution rate, breakdown by type |
| **Queue** | Pending, failed, dispatch success rate |
| **Business** | Quotations, customers |

Outcome buckets are mutually exclusive by construction — "unclear" explicitly excludes
voicemail and every no-answer disconnection reason, so the buckets sum to the analyzed
total.

### 4.12 Platform and administration

- **F12.1** Multi-tenancy — every table is company-scoped; every authenticated request
  resolves a company context and is rejected without one.
- **F12.2** JWT authentication with bcrypt password hashing; role-scoped user management.
- **F12.3** Cron endpoints protected by a shared `CRON_SECRET`, separate from user JWTs.
- **F12.4** Engine runs (`crm-sync`, `scheduler-run`) expose live SSE progress. The SSE
  stream uses a signed query-string token (browsers cannot set headers on `EventSource`);
  control endpoints use JWT.
- **F12.5** Every engine event is persisted with a monotonic sequence number, so a
  reconnecting client replays exactly the events it missed.
- **F12.6** Test mode — `is_test` flags on calls, todos, and queued calls keep pilot and
  QA traffic out of production analytics.
- **F12.7** Migrations run through a ledgered runner (`schema_migrations`) that is safe to
  re-run against a provisioned database.

---

## 5. Configuration surface

The full set of tenant-controlled settings, with shipped defaults.

| Setting | Default | Effect |
|---|---|---|
| `business_hours_start` / `_end` | `09:00` / `17:00` | Dispatch window in company timezone |
| `include_weekends` | `false` | Whether Sat/Sun are dispatch days |
| `max_attempts` | `3` | Retry ceiling per queued contact |
| `voicemail_behavior` | `leave` | Leave a message or hang up |
| `voicemail_message` | templated default | Message text, supports dynamic variables |
| `alert_days_before` | `2` | Default lead time |
| `agent_can_make_changes` | `true` | Master gate on all agent write tools |
| `auto_schedule_enabled` | `true` | Trigger sweep kill switch |
| `auto_dispatch_enabled` | `true` | Dispatcher kill switch |
| `channel_strategy` | `voice_only` | `voice_only` · `sms_only` · `voice_then_sms_fallback` · `web_chat_only` — company-level fallback only; superseded per-customer by the flags below whenever a customer row exists |
| `chat_link_delivery_method` | `email` | `email` · `sms` · `both` — company-level fallback for `web_chat` delivery, superseded per-customer by `is_sms`/`is_email` |
| `crm_comment_writeback_enabled` | `false` | Post call summaries to the CRM |
| `service_link_enabled` | `false` | Email the ServiceTrade Service Link post-call |

Plus, per trigger: `enabled`, `call_type`, `days_before`, and trigger-specific config.
Plus, per call type: name, description, greeting, system prompt, voice, voicemail message.

**Per-customer** (`customers` table, not `call_settings`):

| Field | Default | Effect |
|---|---|---|
| `is_voice` | `true` | Reach this customer with a real phone call |
| `is_sms` | `false` | Reach this customer by texting a confirmation link |
| `is_email` | `false` | Reach this customer by emailing a confirmation link |

At least one of the three must be true (`customers_channel_at_least_one` CHECK).
`is_voice=true` means voice-first with sms/email as fallback once voice retries are
exhausted, never simultaneous with a live voice attempt; `is_voice=false` means
`is_sms`/`is_email` fire together. `sms_on_callback_enabled` is no longer read —
callbacks are always voice (§4.3).

---

## 6. End-to-end flows

### 6.1 Appointment confirmation (the core loop)

1. CRM sync pulls a job scheduled for Thursday with an unconfirmed appointment.
2. The `scheduled_unconfirmed` trigger, at `days_before: 2`, enqueues a
   `customer_confirmation` contact for Tuesday.
3. The channel resolver returns `voice` (tenant is `voice_only`).
4. Tuesday, inside office hours, the dispatcher claims the row and places the call with
   hydrated job and appointment context.
5. The agent greets the customer on the **job**, calls `get_appointments`, tells them how
   many visits are upcoming, and confirms the next one.
6. Customer asks for Friday instead → agent calls `reschedule_appointment`.
7. The appointment updates in Clara and pushes to ServiceTrade; a summary comment is
   posted if write-back is enabled.
8. Post-call analysis records outcome and sentiment. Because the intent was resolved, no
   todo is raised.
9. If `service_link_enabled`, the agent confirms the right recipient via `search_contact` /
   `create_contact`, and the Service Link is emailed after the call.
10. The dashboard confirmation rate updates.

**Failure branch:** no answer → retry per `max_attempts`. Once voice retries are
exhausted, a customer with `is_sms`/`is_email` on file gets one chat-link send as a
fallback (§4.3 F3.4). Beyond that → `NOT_PICKED` or `VOICEMAIL` todo for a human.

### 6.2 Technician confirmation

The same loop, targeting the assigned technician, using the `technician_confirmation`
agent and a reduced toolset (`get_appointments`, `confirm_appointment`).

### 6.3 Service opportunity follow-up

Staff filter open opportunities by location, select a set, and launch a call. The agent
opens with `get_service_opportunities`, walks the customer through each recommended item
with its deficiency rationale and price, and books what the customer agrees to via
`create_appointment`. Anything undecided becomes a `SERVICE_OPPORTUNITY` todo.

### 6.4 Web chat link

For a customer flagged `is_email` (or a tenant without A2P approval): the dispatcher
resolves `web_chat`, generates a tokenized link scoped to the appointment, and delivers it
by email, SMS, or both. The customer opens the link and holds the confirmation
conversation in the browser with Clara's in-house phase-gated agent. State persists if
they close the tab. An unopened link expires after 24h and re-queues as a fresh attempt.

---

## 7. Success metrics

### 7.1 Primary (product value)

| Metric | Definition | Target |
|---|---|---|
| **Confirmation rate** | Appointments confirmed ÷ appointments contacted | ≥ 70% |
| **Autonomous resolution rate** | Calls resolved with no todo raised ÷ analyzed calls | ≥ 60% |
| **No-show reduction** | No-show appointments before vs. after activation | ≥ 30% reduction |
| **Opportunity conversion** | Opportunities booked ÷ opportunities called | ≥ 15% |
| **Staff hours reclaimed** | Automated contacts × average manual call handling time | ≥ 10 hrs/week per tenant |

### 7.2 Secondary (system health)

| Metric | Target |
|---|---|
| Dispatch success rate (fired ÷ due) | ≥ 98% |
| Sync success rate | ≥ 99% of scheduled runs |
| Todo resolution rate | ≥ 90% within 48h |
| Write-back success rate | ≥ 99% |
| Contact rate (answered ÷ attempted) | ≥ 50% |
| Negative-sentiment share | ≤ 5% |

### 7.3 Guardrails

- Duplicate contacts to the same person for the same reason: **0**.
- Calls dispatched outside configured office hours: **0**.
- Cross-tenant data exposure: **0**.
- Records mutated when `agent_can_make_changes` is off: **0**.

---

## 8. Constraints, risks, and dependencies

### 8.1 External dependencies

| Dependency | Used for | Risk |
|---|---|---|
| ServiceTrade API | Source of truth, write-back | Session invalidation; undocumented payload changes. Mitigation: raw mirror preserves everything; real captured payloads are the specification, not the published docs |
| Retell | Voice agents | Provisioning drift between Clara config and Retell state. Mitigation: prompt sync and per-company re-provisioning |
| Twilio | Chat-link SMS delivery | A2P 10DLC approval is manual and slow. Mitigation: ops-tracked `sms_status`, plus email delivery of the same chat link, which has no A2P dependency |
| SendGrid | Chat link and service link email | Deliverability. Mitigation: per-message status tracking and todos on failure |
| OpenAI / Groq | Copilot and web-chat confirmation agent reasoning | Cost and latency |
| PostgreSQL | All persistence | Standard |

### 8.2 Product risks

- **Customer annoyance.** Automated calls can irritate. Mitigated by office-hours
  enforcement, an attempt ceiling, dedup, per-customer channel preference, and everything
  being opt-in per tenant.
- **Agent acts wrongly.** A wrong reschedule is worse than no call. Mitigated by the
  `agent_can_make_changes` master gate, explicit pre-conditions on destructive tools
  (cancellation requires asking scope and reason), and full transcript audit.
- **Trust in autonomy.** Operators will not enable write tools until they trust them.
  Mitigated by shipping everything off by default, test mode, and dispatcher decision
  logging that answers "why did/didn't this happen?"
- **Provider lock-in.** Mitigated by the `CrmProvider` abstraction and the
  `source`/`external_ref` model.

### 8.3 Technical constraints

- SSE, not WebSockets, for live progress — browsers cannot set headers on `EventSource`,
  hence the signed query-string token.
- The provider webhook route must be mounted before body parsers to verify signatures
  against the raw request stream.
- Timezone correctness is a first-class concern: office hours are evaluated in the
  company's `default_timezone`, not server time.
- Migrations are additive by default — new columns are added rather than existing ones
  renamed, so a deploy can be rolled back without data loss. Where a column genuinely has
  to go (e.g. `customers.preferred_channel`, replaced by the three channel flags), the
  migration backfills its replacement in the same file before dropping it, and the drop
  ships only after the code that stopped reading it.

---

## 9. Roadmap

### Shipped
CRM sync and normalization · trigger engine (5 triggers) · voice agent with read and write
tools · scheduling, office hours, retries, concurrency · per-customer channel flags ·
web chat links with in-house phase-gated agent, delivered by email and/or SMS ·
todos with audit trail · CRM appointment/comment write-back · service link delivery ·
service opportunities · AI copilot · analytics dashboard · SSE engine framework.

### Next
- Additional CRM providers (BuildOps, ServiceTitan) against the existing interface.
- Domain-model consolidation: campaigns as the single configuration entity, replacing the
  split between trigger configs and call-type configs; a campaign owns its own prompt and
  greeting.
- Staged campaign lifecycles streamed as a `campaign_run` engine.
- Deeper service-request modeling: recurrences, deficiencies, inspection-driven routing.

### Later
- Inbound call handling.
- Multi-language agents.
- Cross-tenant benchmarking.
- Customer self-service portal beyond the single-conversation chat link.

---

## 10. Open questions

1. **Campaign consolidation cutover.** The campaign refactor changes agent node ids and
   requires per-company Retell re-provisioning between the expand and contract migrations.
   What is the acceptable customer-visible downtime, and do we drain the pending queue at
   cutover?
2. **Voice vs. chat as the default channel.** Web chat has no A2P dependency and lower
   per-contact cost. Should new tenants default to `web_chat_only` rather than
   `voice_only`?
3. **Attribution for no-show reduction.** We do not currently capture a pre-activation
   baseline. Do we instrument a holdout group, or accept tenant-reported baselines?
4. **Todo SLA.** Should unresolved high-priority todos escalate (notification, reassignment)
   after a threshold, or stay purely pull-based?
5. **Opportunity call consent.** Opportunity follow-up is closer to sales than to a
   transactional confirmation. Does it need a separate consent/opt-out model?

---

## Appendix A — API surface

| Namespace | Purpose |
|---|---|
| `/auth`, `/users`, `/company` | Authentication, user management, tenant settings |
| `/customers`, `/jobs`, `/locations` | Platform data browsing |
| `/service-opportunities` | Opportunity browsing and call launch |
| `/integrations/servicetrade/*` | Connect, status, sync, raw data |
| `/agent-settings`, `/call-settings`, `/call-triggers`, `/call-analysis-configs` | Configuration |
| `/dynamic-variables` | Read-only catalog of template variables |
| `/scheduled-calls`, `/calls`, `/calls/manual` | Queue view/cancel, call history, manual trigger |
| `/todos` | Exception queue and audit log |
| `/dashboard/stats` | Analytics |
| `/chat-links` | Generate (staff, JWT) and resolve (public, token) |
| `/service-link-messages` | Service-link send status |
| `/copilot` | Copilot control (JWT) and turn stream (signed token) |
| `/engines` | Engine run control (JWT) and SSE stream (signed token) |
| `/retell`, `/retell/tools` | Provider webhooks (signature / shared secret) |
| `/scheduler`, `/admin` | Cron and ops endpoints (`CRON_SECRET`) |
| `/health` | Liveness and DB connectivity |

## Appendix B — Glossary

| Term | Meaning |
|---|---|
| **Call type** | The kind of conversation: `customer_confirmation`, `technician_confirmation`, `quotation_followup`, `service_opportunity_followup` |
| **Trigger** | A rule that decides when a call type should fire |
| **Channel** | How the contact is reached: `voice` or `web_chat`. SMS and email are *delivery methods* for a web-chat link, not channels of their own |
| **Dispatcher** | The worker that claims due queued calls and fires them |
| **Engine run** | A tracked background operation with live SSE progress |
| **Service link** | A ServiceTrade-hosted job detail page emailed to a customer |
| **Service opportunity** | An unbooked, jobless service request — revenue not yet scheduled |
| **Todo** | A human work item created from an unresolved conversation |
| **Write-back** | Pushing a Clara-side change into the CRM |
