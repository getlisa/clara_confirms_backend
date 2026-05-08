# Clara Confirms — Backend API Contracts

Base URL: `VITE_API_URL` (e.g. `http://localhost:3000`)  
Auth: `Authorization: Bearer <token>` on all protected endpoints.

---

## Table of Contents

1. [Auth](#1-auth)
2. [Company](#2-company)
3. [Users](#3-users)
4. [Agent Settings](#4-agent-settings)
5. [Calls](#5-calls)
6. [Todos](#6-todos)
7. [Retell Webhook](#7-retell-webhook)
8. [ServiceTrade Integration](#8-servicetrade-integration)
9. [Shared Types](#9-shared-types)

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
Returns the company's agent configuration. If no row has been saved yet, returns defaults (`null` for text fields, `2` for `days_before_confirmation`).

**Response `200`**
```json
{
  "agent_settings": {
    "representative_name": "Clara",
    "begin_message": "Hi, this is Clara calling from {{company_name}}...",
    "general_prompt": "You are Clara, a friendly and professional scheduling assistant...",
    "days_before_confirmation": 2
  }
}
```

**Supported placeholders in `begin_message`:**

| Placeholder | Replaced with |
|---|---|
| `{{company_name}}` | Company name |
| `{{customer_name}}` | Customer name |
| `{{representative_name}}` | Value of `representative_name` field |

---

### `PATCH /agent-settings` 🔒
All fields optional (partial update). Upserts — safe to call before a row exists.  
Saving any field automatically syncs the Retell LLM + Agent in the background.

**Request**
```json
{
  "representative_name": "Clara",
  "begin_message": "Hi, this is Clara calling from {{company_name}}...",
  "general_prompt": "You are Clara, a friendly and professional scheduling assistant...",
  "days_before_confirmation": 3
}
```
**Response `200`** `{ "agent_settings": { ...saved } }`  
**Response `400`** `{ "error": "days_before_confirmation must be an integer >= 1" }`

---

## 5. Calls

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

## 6. Todos

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

## 7. Retell Webhook

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

## 8. ServiceTrade Integration

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

## 9. Shared Types

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
  begin_message: string | null;
  general_prompt: string | null;
  days_before_confirmation: number;   // integer >= 1, default 2
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
