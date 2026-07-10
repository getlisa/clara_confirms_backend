# Clara Confirms — Backend API Contracts

Base URL: `VITE_API_URL` (e.g. `http://localhost:3000`)  
Auth: `Authorization: Bearer <token>` on all protected endpoints.

---

## Table of Contents

1. [Auth](#1-auth)
2. [Company](#2-company)
3. [Users](#3-users)
4. [Agent Settings](#4-agent-settings)
4a. [Campaigns](#4a-campaigns)
4b. [Onboarding](#4b-onboarding)
5. [Call Settings](#5-call-settings)
6. [Calls](#6-calls)
7. [Todos](#7-todos)
8. [Testing](#8-testing)
9. [Retell Webhook](#9-retell-webhook)
10. [ServiceTrade Integration](#10-servicetrade-integration)
11. [Shared Types](#11-shared-types)

---

## 1. Auth

### `POST /auth/register`
Create a new company + admin user.

**Request**
```json
{
  "email": "admin@example.com",
  "password": "secret",
  "name": "Jane Doe",
  "companyName": "Acme HVAC"
}
```
**Response `201`**
```json
{
  "token": "<jwt>",
  "refreshToken": "<jwt>",
  "user": {
    "id": 1,
    "email": "admin@example.com",
    "first_name": "Jane",
    "last_name": "Doe",
    "role": "admin",
    "company_id": 1,
    "company_name": "Acme HVAC"
  }
}
```

---

### `POST /auth/login`
**Request**
```json
{ "email": "admin@example.com", "password": "secret" }
```
**Response `200`**
```json
{
  "token": "<jwt>",
  "refreshToken": "<jwt>",
  "user": { "id": 1, "email": "...", "first_name": "...", "last_name": "...", "role": "admin", "company_id": 1, "company_name": "..." }
}
```
**Response `401`** `{ "error": "Invalid email or password" }`

---

### `POST /auth/refresh`
**Request** `{ "refresh_token": "<jwt>" }`  
**Response `200`** `{ "token": "<new jwt>", "refreshToken": "<new jwt>" }`

---

### `GET /auth/me` 🔒
**Response `200`**
```json
{
  "user": {
    "id": 1,
    "email": "admin@example.com",
    "first_name": "Jane",
    "last_name": "Doe",
    "role": "admin",
    "company_id": 1,
    "company_name": "Acme HVAC",
    "last_login": "2026-05-09T10:00:00Z"
  }
}
```

---

### `PATCH /auth/profile` 🔒
**Request** _(all optional)_
```json
{ "first_name": "Jane", "last_name": "Smith", "email": "new@example.com" }
```
**Response `200`** `{ "user": { ...updated fields } }`

---

### `POST /auth/change-password` 🔒
**Request**
```json
{ "currentPassword": "old", "newPassword": "new" }
```
**Response `200`** `{ "message": "Password updated" }`  
**Response `400`** `{ "error": "Current password is incorrect" }`

---

### `POST /auth/forgot-password`
**Request** `{ "email": "user@example.com" }`  
**Response `200`** `{ "message": "Password reset email sent" }`

---

### `POST /auth/reset-password`
**Request**
```json
{ "token": "<reset-token>", "new_password": "newSecret" }
```
**Response `200`** `{ "message": "Password reset successfully" }`

---

### `POST /auth/magic-link`
**Request** `{ "email": "user@example.com" }`  
**Response `200`** `{ "message": "Sign-in link sent" }`

---

### `POST /auth/verify-email-link`
**Request** `{ "token": "<magic-link-token>" }`  
**Response `200`** — same shape as `/auth/login`

---

### `POST /auth/logout` 🔒
No body. Client should discard stored tokens.  
**Response `200`** `{ "message": "Logged out" }`

---

## 2. Company

### `GET /company` 🔒
**Response `200`**
```json
{
  "company": {
    "id": "1",
    "name": "Acme HVAC",
    "default_timezone": "America/New_York",
    "address_line1": "123 Main St",
    "city": "Springfield",
    "state": "IL",
    "zipcode": "62701",
    "country": "US"
  }
}
```

---

### `PATCH /company` 🔒
All fields optional.
```json
{
  "name": "Acme HVAC",
  "default_timezone": "America/Chicago",
  "address_line1": "456 Oak Ave",
  "city": "Chicago",
  "state": "IL",
  "zipcode": "60601",
  "country": "US"
}
```
**Response `200`** `{ "company": { ...updated } }`  
**Response `400`** `{ "error": "No fields to update" }`

---

## 3. Users

All endpoints require auth. `POST /users/invite` and `PATCH /users/:id` and `DELETE /users/:id` require admin role.

### `GET /users` 🔒
**Response `200`**
```json
{
  "users": [
    {
      "id": 1,
      "email": "jane@example.com",
      "first_name": "Jane",
      "last_name": "Doe",
      "role": "admin",
      "is_active": true,
      "created_at": "2026-01-01T00:00:00Z",
      "last_login": "2026-05-09T10:00:00Z"
    }
  ]
}
```

---

### `POST /users/invite` 🔒 Admin
**Request**
```json
{ "email": "new@example.com", "first_name": "Bob", "last_name": "Smith", "role": "user" }
```
**Response `201`** `{ "user": { ...created }, "message": "Invite sent" }`  
**Response `400`** `{ "error": "Maximum user limit (3) reached" }`

---

### `PATCH /users/:id` 🔒 Admin
**Request** _(at least one)_
```json
{ "role": "admin", "active": false }
```
**Response `200`** `{ "user": { ...updated } }`

---

### `DELETE /users/:id` 🔒 Admin
Soft-delete (sets `is_deleted=true`, `is_active=false`).  
**Response `200`** `{ "message": "User deleted" }`  
**Response `403`** `{ "error": "Cannot delete yourself" }`

---

## 4. Agent Settings

### `GET /agent-settings` 🔒
Returns the company's global agent identity. If no row exists yet, returns `null` for text fields.

**Response `200`**
```json
{
  "agent_settings": {
    "representative_name": "Clara"
  }
}
```

---

### `PATCH /agent-settings` 🔒
Partial update. Upserts — safe to call before a row exists.

**Request**
```json
{
  "representative_name": "Clara"
}
```
**Response `200`** `{ "agent_settings": { "representative_name": "Clara" } }`

---

## 4a. Campaigns

A **campaign** is the single config entity for outreach — trigger behavior (when/who to call) + its own
agent (prompt/greeting/voicemail). It replaces the removed `call_type_configs` + `call_trigger_configs`.
Fixed set of 5 keys: `scheduled_unconfirmed`, `open_job_due_soon`, `quotation_pending`,
`technician_unconfirmed`, `post_job_review`. `enabled` controls both scheduling and whether the campaign's
sub-agent is provisioned into the Retell flow.

Campaign-facing fields → columns: `greeting`↔`begin_message`, `prompt`↔`general_prompt`,
`voicemail`↔`voicemail_message`, `config`↔`trigger_config`.

### `GET /campaigns` 🔒
```json
{ "campaigns": [
  { "key": "scheduled_unconfirmed", "name": "Confirm Campaign", "enabled": true, "days_before": 2,
    "greeting": "Hi {{customer_name}}…", "prompt": "You are {{representative_name}}…",
    "voicemail": "Hi {{customer_name}}…", "config": { "retry_if_no_answer": true },
    "description": "…", "updated_at": "2026-05-09T10:00:00Z" }
] }
```

### `PATCH /campaigns/:key` 🔒
Send only the fields that change. Editing `enabled`/`name`/`greeting`/`prompt` re-provisions the Retell flow
automatically.
```json
// Request
{ "enabled": true, "prompt": "New agent instructions", "greeting": "Hi…", "voicemail": "…",
  "days_before": 2, "config": { "days_after": 1 } }
// Response 200
{ "campaign": { ...updated } }
```

---

## 4b. Onboarding

Server-side new-company setup — one call runs every step in order and ends with an awaited Retell provision.
Replaces the old frontend-orchestrated sequence of PATCH calls.

### `POST /onboarding` 🔒 Admin
Runs, in order, each best-effort: company profile + area code → agent identity → call settings →
enable/configure campaigns → **awaited** Retell provision (builds flow/agent, buys phone) → team invites.
A failing Retell provision is **non-fatal** (reported in `errors`; the other steps still persist), so this
returns `200` with a status payload rather than erroring.
```json
// Request — all sections optional; send what you're setting
{
  "company":  { "default_timezone": "America/Los_Angeles", "state": "CA", "address_line1": "…", "city": "…",
                "zipcode": "…", "country": "US", "office_area_code": "408" },
  "agent":    { "representative_name": "Clara", "voice_id": "…" },
  "call_settings": { "business_hours_start": "09:00", "business_hours_end": "17:00", "include_weekends": false },
  "campaigns": [ { "key": "scheduled_unconfirmed", "enabled": true, "prompt": "…", "greeting": "…", "voicemail": "…" } ],
  "invites":  [ { "email": "u@x.com", "first_name": "A", "last_name": "B", "role": "user" } ],
  "mark_complete": true
}
// Response 200
{
  "steps": { "company_profile": true, "agent_identity": true, "call_settings": true },
  "campaigns": [ { "key": "scheduled_unconfirmed", "enabled": true } ],
  "invited": [ { "id": 3, "email": "u@x.com" } ],
  "retell": { "flow_id": "…", "agent_id": "…", "phone_number": "…" },
  "errors": [],
  "status": { "...": "same shape as GET /onboarding/status" }
}
```
> `office_area_code` is optional — if `state` is given it's derived automatically. `retell` is `null` until a
> campaign is enabled + provisioning succeeds.

### `GET /onboarding/status` 🔒
```json
{ "status": {
  "company_profile": true, "agent_identity": true, "campaigns_enabled": true, "enabled_campaign_count": 2,
  "retell_provisioned": true, "phone_number_set": true, "completed": true } }
```

---

## 5. Call Settings

Per-company call scheduling configuration. Controls office hours, max attempts, and voicemail behavior.

### `GET /call-settings` 🔒

**Response `200`**
```json
{
  "call_settings": {
    "business_hours_start": "09:00",
    "business_hours_end": "17:00",
    "max_attempts": 3,
    "voicemail_behavior": "leave",
    "include_weekends": false
  }
}
```

If no row exists yet, return the above defaults.

---

### `PATCH /call-settings` 🔒

All fields optional (partial update). Upserts.

**Request**
```json
{
  "business_hours_start": "08:00",
  "business_hours_end": "18:00",
  "max_attempts": 5,
  "voicemail_behavior": "skip",
  "include_weekends": false
}
```

**Field validation:**
- `business_hours_start` / `business_hours_end`: `"HH:MM"` 24-hour format; end must be after start
- `max_attempts`: integer, min `1`, max `10`
- `voicemail_behavior`: `"leave"` | `"skip"`

**Response `200`** `{ "call_settings": { ...saved } }`  
**Response `400`** `{ "error": "end time must be after start time" }`

---

### Data model — `call_settings` table

```sql
CREATE TABLE call_settings (
  id                    SERIAL PRIMARY KEY,
  company_id            INTEGER NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
  business_hours_start  VARCHAR NOT NULL DEFAULT '09:00',
  business_hours_end    VARCHAR NOT NULL DEFAULT '17:00',
  max_attempts          INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  voicemail_behavior    VARCHAR NOT NULL DEFAULT 'leave' CHECK (voicemail_behavior IN ('leave','skip')),
  include_weekends      BOOLEAN NOT NULL DEFAULT false,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

### Office hours enforcement (scheduler)

The daily scheduler enforces call windows at **two layers**:

**Layer 1 — Schedule time (when the job is picked up for scheduling):**
Snap `scheduled_at` to the next valid window slot in the company's `default_timezone`. Steps forward hour by hour (up to 14 days) until the candidate time satisfies:
- Day is within `include_weekends` setting
- Time is ≥ `business_hours_start` AND < `business_hours_end`

**Layer 2 — Dispatch time (when the scheduler tries to fire a queued call):**
Re-check `isWithinActiveHours()` at fire time. If the window has closed since scheduling (e.g. was queued near end of day):
- Block the call
- Advance `scheduled_at` to next window open (`nextWindowStart()`)
- Return without placing the Retell call

**Test calls bypass both layers** — see [§8 Testing](#8-testing).

---

## 6. Calls

### `GET /calls` 🔒
Returns paginated call history for the company.

**Query params**

| Param | Type | Description |
|---|---|---|
| `status` | `ended` \| `analyzed` | Filter by processing status |
| `appointment_confirmed` | `yes` \| `no` \| `unclear` | Filter by confirmation outcome |
| `limit` | integer (max 200) | Default `50` |
| `offset` | integer | Default `0` |

**Response `200`**
```json
{
  "calls": [
    {
      "id": 42,
      "retell_call_id": "call_abc123",
      "to_number": "+15555550100",
      "from_number": "+15555550200",
      "direction": "outbound",
      "status": "analyzed",
      "duration_ms": 87000,
      "disconnection_reason": "agent_hangup",
      "in_voicemail": false,
      "call_successful": true,
      "call_summary": "Customer confirmed the appointment for Tuesday at 10am.",
      "user_sentiment": "Positive",
      "appointment_confirmed": "yes",
      "reschedule_requested": false,
      "cancellation_requested": false,
      "transcript": [
        { "role": "agent", "content": "Hi, this is Clara..." },
        { "role": "user", "content": "Yes, Tuesday works." }
      ],
      "created_at": "2026-05-09T10:00:00Z",
      "updated_at": "2026-05-09T10:01:30Z"
    }
  ]
}
```

**Call status values**

| `status` | Meaning |
|---|---|
| `ended` | Call finished; analysis not yet received from Retell |
| `analyzed` | Full post-call analysis available |

**`appointment_confirmed` values**

| Value | Meaning |
|---|---|
| `yes` | Customer explicitly confirmed |
| `no` | Customer declined or said no |
| `unclear` | Could not be determined (or voicemail/no-answer) |

**`user_sentiment` values:** `Positive` \| `Negative` \| `Neutral` \| `Unknown`

**`disconnection_reason` common values:** `agent_hangup` `user_hangup` `voicemail_reached` `dial_no_answer` `dial_busy` `dial_failed` `user_declined` `inactivity` `max_duration_reached`

---

### `GET /calls/:id` 🔒
Returns full call record including raw `transcript` array.

**Response `200`** `{ "call": { ...same shape as list item } }`  
**Response `404`** `{ "error": "Call not found" }`

---

## 7. Todos

Post-call action items auto-created after each analyzed call. Equivalent to "escalations" in collection_agent_backend.

### Todo types

| Type | When created | Default priority |
|---|---|---|
| `NOT_PICKED` | Call not answered (busy, failed, declined) | medium |
| `VOICEMAIL` | Voicemail reached | medium |
| `ASKED_FOR_RESCHEDULE` | Customer asked to reschedule | **high** |
| `ASKED_FOR_CANCELLATION` | Customer asked to cancel | **high** |
| `UNCONFIRMED` | Call connected but confirmation unclear or "no" | medium |
| _(none)_ | `appointment_confirmed = "yes"` — happy path | — |

### Todo statuses: `open` → `in_progress` → `resolved` / `dismissed`

---

### `GET /todos` 🔒

**Query params**

| Param | Type | Description |
|---|---|---|
| `status` | `open` \| `in_progress` \| `resolved` \| `dismissed` | Filter by status |
| `type` | `NOT_PICKED` \| `VOICEMAIL` \| `ASKED_FOR_RESCHEDULE` \| `ASKED_FOR_CANCELLATION` \| `UNCONFIRMED` | Filter by type |
| `assigned_to` | integer (user id) | Filter by assignee |
| `limit` | integer (max 200) | Default `50` |
| `offset` | integer | Default `0` |

Results are ordered: high priority first, then by `created_at DESC`.

**Response `200`**
```json
{
  "todos": [
    {
      "id": 7,
      "company_id": 1,
      "call_id": 42,
      "type": "ASKED_FOR_RESCHEDULE",
      "status": "open",
      "priority": "high",
      "assigned_to": null,
      "assigned_to_name": null,
      "notes": null,
      "metadata": {
        "retell_call_id": "call_abc123",
        "to_number": "+15555550100",
        "call_summary": "Customer confirmed the appointment for Tuesday at 10am.",
        "user_sentiment": "Positive",
        "appointment_confirmed": "unclear"
      },
      "resolved_at": null,
      "created_at": "2026-05-09T10:02:00Z",
      "updated_at": "2026-05-09T10:02:00Z",
      "retell_call_id": "call_abc123",
      "to_number": "+15555550100",
      "duration_ms": 87000,
      "appointment_confirmed": "unclear",
      "reschedule_requested": true,
      "cancellation_requested": false,
      "call_summary": "Customer confirmed the appointment for Tuesday at 10am."
    }
  ]
}
```

> Fields `retell_call_id`, `to_number`, `duration_ms`, `appointment_confirmed`, `reschedule_requested`, `cancellation_requested`, `call_summary` are joined from the `calls` table and may be `null` if the call record is not found.

---

### `PATCH /todos/:id/status` 🔒
Any authenticated user can update status.

**Request**
```json
{ "status": "resolved", "notes": "Called back manually, appointment confirmed." }
```
`status` must be one of: `open` `in_progress` `resolved` `dismissed`  
`notes` is optional.

**Response `200`** `{ "todo": { ...updated } }`  
**Response `400`** `{ "error": "status must be one of: open, in_progress, resolved, dismissed" }`  
**Response `404`** `{ "error": "Todo not found" }`

---

### `PATCH /todos/:id/assign` 🔒 Admin
**Request**
```json
{ "assigned_to": 3 }
```
Assigning a todo also moves its status from `open` → `in_progress` automatically.

**Response `200`** `{ "todo": { ...updated } }`  
**Response `404`** `{ "error": "Todo not found" }`

---

### `GET /todos/:id/logs` 🔒
Returns the full audit trail for a todo.

**Response `200`**
```json
{
  "logs": [
    {
      "id": 1,
      "todo_id": 7,
      "actor_id": null,
      "actor_name": null,
      "actor_type": "system",
      "event_type": "created",
      "change": { "type": "ASKED_FOR_RESCHEDULE", "priority": "high" },
      "notes": null,
      "created_at": "2026-05-09T10:02:00Z"
    },
    {
      "id": 2,
      "todo_id": 7,
      "actor_id": 1,
      "actor_name": "Jane Doe",
      "actor_type": "user",
      "event_type": "resolved",
      "change": { "status": "resolved" },
      "notes": "Called back manually.",
      "created_at": "2026-05-09T11:30:00Z"
    }
  ]
}
```

**`event_type` values:** `created` `assigned` `status_changed` `resolved` `dismissed`

---

## 8. Testing

Test calls bypass office hours and are scheduled with a fixed 2-minute gap. They are marked `is_test=true` throughout the system and excluded from all production metrics and reports by default.

### `is_test` propagation

Following the same pattern as collection_agent_backend, `is_test` propagates from the trigger down through all related records:

| Table | Column | Set when |
|---|---|---|
| `scheduled_calls` | `is_test` | `POST /test/trigger-call` sets to `true` |
| `calls` | `is_test` | Copied from `scheduled_calls.is_test` on webhook receipt |
| `todos` | `is_test` | Copied from `calls.is_test` when a todo is created post-call |

**API filtering:** All list endpoints (`GET /calls`, `GET /todos`) default to `is_test=false`. Pass `?is_test=true` to see test records only.

---

### `POST /test/trigger-call` 🔒

Schedules a test call ~2 minutes from now. Office hours and call-type scheduling rules are bypassed entirely.

**Request**
```json
{
  "phone_number": "+14155550100",
  "call_type": "scheduled_unconfirmed",
  "customer_name": "Jane Doe",
  "job_date": "2026-05-20",
  "is_test": true
}
```

- `phone_number` — required
- `call_type` — required; the campaign key to route to (e.g. `scheduled_unconfirmed`)
- `customer_name` — optional; used to fill `{{customer_name}}` placeholder
- `job_date` — optional ISO date; used to fill `{{job_date}}` placeholder

**Response `200`**
```json
{
  "call_id": "call_abc123",
  "scheduled_at": "2026-05-15T14:32:00Z"
}
```

**Response `400`**
```json
{ "error": "phone_number is required" }
```

---

### Test scheduling logic

```
function scheduleTestCall(params):
  scheduled_at = now() + 2 minutes          // fixed 2-min gap, no office-hours snap
  
  INSERT INTO scheduled_calls (
    company_id, phone_number, call_type, is_test,
    scheduled_at, customer_name, job_date, status
  ) VALUES (
    ..., TRUE, scheduled_at, ...
  )
  
  return { call_id, scheduled_at }
```

The dispatcher checks `is_test = true` to skip the `isWithinActiveHours()` gate entirely:

```
function dispatch(row):
  if not row.is_test:
    if not isWithinActiveHours(row.company_id, row.timezone):
      advanceToNextWindow(row)
      return
  // proceed with Retell call
```

---

### Test data in DB

Seed a test job (for manual scheduler testing scripts):

```sql
-- Insert a test scheduled call
INSERT INTO scheduled_calls (company_id, phone_number, call_type, is_test, status, scheduled_at)
VALUES (<company_id>, '+14155550100', 'customer_confirmation', TRUE, 'pending', NOW() + INTERVAL '2 minutes');
```

Query test records:
```sql
-- All test calls
SELECT * FROM calls WHERE is_test = TRUE ORDER BY created_at DESC;

-- All test todos
SELECT * FROM todos WHERE is_test = TRUE ORDER BY created_at DESC;
```

---

## 9. Retell Webhook

### `POST /retell/webhook`
Retell calls this endpoint after every call. No auth header — verified via HMAC signature.

**Headers**
```
x-retell-signature: <hmac-signature>
```

**Event: `call_ended`**
```json
{
  "event": "call_ended",
  "data": {
    "call_id": "call_abc123",
    "to_number": "+15555550100",
    "from_number": "+15555550200",
    "duration_ms": 87000,
    "disconnection_reason": "agent_hangup",
    "metadata": { "company_id": "1" }
  }
}
```
Backend action: upserts call stub row + inserts `call_logs` entry.  
**Response `204`**

---

**Event: `call_analyzed`**
```json
{
  "event": "call_analyzed",
  "data": {
    "call_id": "call_abc123",
    "to_number": "+15555550100",
    "from_number": "+15555550200",
    "duration_ms": 87000,
    "disconnection_reason": "agent_hangup",
    "transcript": [
      { "role": "agent", "content": "Hi, this is Clara..." },
      { "role": "user", "content": "Yes, Tuesday works." }
    ],
    "call_analysis": {
      "call_successful": true,
      "call_summary": "Customer confirmed the appointment.",
      "in_voicemail": false,
      "user_sentiment": "Positive",
      "custom_analysis_data": {
        "appointment_confirmed": "yes",
        "reschedule_requested": false,
        "cancellation_requested": false
      }
    },
    "metadata": { "company_id": "1" }
  }
}
```
Backend actions:
1. Upserts full call record
2. Inserts `call_logs` entry
3. Creates a `todo` if `appointment_confirmed !== "yes"` (see [Todo types](#todo-types))

**Response `204`**  
**Response `401`** `{ "error": "Invalid signature" }` — if `x-retell-signature` fails verification

---

## 10. ServiceTrade Integration

### `POST /integrations/servicetrade/credentials` 🔒
Save and verify ServiceTrade credentials.

**Request** `{ "username": "st_user", "password": "st_pass" }`  
**Response `200`** `{ "connected": true, "user": { "id": 123, "username": "st_user", "name": "..." } }`

---

### `GET /integrations/servicetrade/status` 🔒
**Response `200`** `{ "connected": true, "user": { ... }, "hasCredentials": true }`

---

### `DELETE /integrations/servicetrade/session` 🔒
**Response `200`** `{ "message": "Session closed" }`

---

### `POST /integrations/servicetrade/sync` 🔒
Query param: `?full=true` for a full re-sync (default: incremental).  
**Response `200`** `{ "success": true, "counts": { "companies": 120, "locations": 340, "service_requests": 890, "assets": 200 } }`

---

### `GET /integrations/servicetrade/customers` 🔒
**Query params:** `page`, `perPage`, `includeInactive`  
**Response `200`**
```json
{
  "customers": [
    { "id": 1, "servicetrade_id": 9001, "name": "Widgets Inc", "phone_number": "...", "address": "...", "is_active": true, "location_count": 3 }
  ],
  "pagination": { "page": 1, "perPage": 50, "total": 120, "totalPages": 3 }
}
```

---

### `GET /integrations/servicetrade/customers/:id/locations` 🔒
**Response `200`** `{ "locations": [ { "id", "servicetrade_id", "name", "phone_number", "email", "address", "is_active", "service_request_count" } ] }`

---

### `GET /integrations/servicetrade/customers/:id/detail` 🔒
Returns company + all locations with contacts and service requests per location.

---

### `GET /integrations/servicetrade/locations/:id` 🔒
Returns location detail with service requests, contacts, and assets.

---

## 11. Shared Types

### TypeScript interfaces

```typescript
// ─── Auth ────────────────────────────────────────────────────────────────────

interface User {
  id: number;
  email: string;
  first_name: string;
  last_name: string;
  role: 'admin' | 'user';
  is_active: boolean;
  company_id: number;
  company_name: string;
  last_login: string | null;
  created_at: string;
}

// ─── Agent Settings ──────────────────────────────────────────────────────────

interface AgentSettings {
  representative_name: string | null;
}

type CampaignKey =
  | 'scheduled_unconfirmed' | 'open_job_due_soon' | 'quotation_pending'
  | 'technician_unconfirmed' | 'post_job_review';

interface Campaign {
  key: CampaignKey;
  name: string;
  enabled: boolean;
  days_before: number;              // integer >= 1
  greeting: string | null;          // == begin_message
  prompt: string | null;            // == general_prompt (the agent's basis)
  voicemail: string | null;         // == voicemail_message
  config: Record<string, unknown>;  // == trigger_config
  description: string | null;
  updated_at: string | null;
}

// ─── Calls ───────────────────────────────────────────────────────────────────

type AppointmentConfirmed = 'yes' | 'no' | 'unclear';
type UserSentiment = 'Positive' | 'Negative' | 'Neutral' | 'Unknown';
type CallStatus = 'ended' | 'analyzed';

interface TranscriptTurn {
  role: 'agent' | 'user';
  content: string;
}

interface Call {
  id: number;
  retell_call_id: string;
  to_number: string | null;
  from_number: string | null;
  direction: string;
  status: CallStatus;
  duration_ms: number | null;
  disconnection_reason: string | null;
  in_voicemail: boolean | null;
  call_successful: boolean | null;
  call_summary: string | null;
  user_sentiment: UserSentiment | null;
  appointment_confirmed: AppointmentConfirmed | null;
  reschedule_requested: boolean | null;
  cancellation_requested: boolean | null;
  transcript: TranscriptTurn[] | null;
  created_at: string;
  updated_at: string;
}

// ─── Todos ───────────────────────────────────────────────────────────────────

type TodoType =
  | 'NOT_PICKED'
  | 'VOICEMAIL'
  | 'ASKED_FOR_RESCHEDULE'
  | 'ASKED_FOR_CANCELLATION'
  | 'UNCONFIRMED';

type TodoStatus = 'open' | 'in_progress' | 'resolved' | 'dismissed';
type TodoPriority = 'high' | 'medium' | 'low';

interface Todo {
  id: number;
  company_id: number;
  call_id: number | null;
  type: TodoType;
  status: TodoStatus;
  priority: TodoPriority;
  assigned_to: number | null;
  assigned_to_name: string | null;   // joined from users
  notes: string | null;
  metadata: {
    retell_call_id?: string;
    to_number?: string;
    call_summary?: string;
    user_sentiment?: string;
    appointment_confirmed?: string;
  } | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
  // Joined from calls table:
  retell_call_id: string | null;
  to_number: string | null;
  duration_ms: number | null;
  appointment_confirmed: string | null;
  reschedule_requested: boolean | null;
  cancellation_requested: boolean | null;
  call_summary: string | null;
}

interface TodoLog {
  id: number;
  todo_id: number;
  actor_id: number | null;
  actor_name: string | null;         // joined from users
  actor_type: 'user' | 'system';
  event_type: 'created' | 'assigned' | 'status_changed' | 'resolved' | 'dismissed';
  change: Record<string, unknown> | null;
  notes: string | null;
  created_at: string;
}
```

---

### New routes required on the frontend

| Route | Component | Notes |
|---|---|---|
| `/todos` | `TodosPage` | List todos, filter by status/type, resolve/dismiss actions |
| `/calls` | `CallsPage` | Call history with outcome badges; click row → detail sheet |
| `/settings` → Agent tab | `AgentSettings` (exists) | Already wired to `GET/PATCH /agent-settings` |

### New sidebar nav item

Add **Todos** between Calls and Audit Trail.
```
Calls        /calls
Todos        /todos    ← new
Audit Trail  /audit-trail
```

### Updated `Call` type
The existing `src/types/call.ts` mock type needs replacing with the `Call` interface from [§9 Shared Types](#9-shared-types) above.

### New `Todo` + `TodoLog` types
Create `src/types/todo.ts` using the interfaces from [§9 Shared Types](#9-shared-types).
