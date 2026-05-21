# Clara Confirms — Frontend Implementation Guide

> **For the frontend agent.** This document covers every backend API contract, TypeScript type, new page, and component change required to build the Clara Confirms UI against the current backend.

Base URL: `VITE_API_URL` (e.g. `http://localhost:3000`)  
Auth header: `Authorization: Bearer <token>` on all 🔒 endpoints.

---

## Table of Contents

1. [New Pages Required](#1-new-pages-required)
2. [Sidebar Changes](#2-sidebar-changes)
3. [TypeScript Types](#3-typescript-types)
4. [API Functions to Add](#4-api-functions-to-add)
5. [Endpoint Reference](#5-endpoint-reference)
6. [Settings Page Changes](#6-settings-page-changes)
7. [Calls Page Changes](#7-calls-page-changes)
8. [Todos Page](#8-todos-page)
9. [Frontend Checklist](#9-frontend-checklist)
10. [Bug Fixes Required](#10-bug-fixes-required)

---

## 1. New Pages Required

| Route | Page Component | Description |
|---|---|---|
| `/todos` | `TodosPage` | Action items from post-call analysis. Filter by status/type. Resolve/dismiss. |
| `/calls` | `CallsPage` | Call history. Real data — replace mock. |

Both go inside `AuthGuard > DashboardLayout` in `App.tsx`.

---

## 2. Sidebar Changes

```
Dashboard      /
Customers      /customers
Inspections    /inspections
Calls          /calls
Todos          /todos        ← ADD (icon: ListTodo from lucide-react)
Audit Trail    /audit-trail
Reports        /reports
Settings       /settings
```

---

## 3. TypeScript Types

### `src/types/call.ts` — replace entire file

> **Updated:** `call_cost` and `transcript_with_tool_calls` are no longer returned by `GET /calls` (list). They are stored internally but hidden from customers. Remove them from the `Call` type.

```typescript
export type AppointmentConfirmed = 'yes' | 'no' | 'unclear';
export type UserSentiment = 'Positive' | 'Negative' | 'Neutral' | 'Unknown';
export type CallStatus = 'ended' | 'analyzed';

export interface TranscriptTurn {
  role: 'agent' | 'user';
  content: string;
}

export interface Call {
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
  is_test: boolean;
  transcript: TranscriptTurn[] | null;
  created_at: string;
  updated_at: string;
}
```

---

### `src/types/todo.ts` — new file

```typescript
export type TodoType =
  | 'NOT_PICKED' | 'VOICEMAIL'
  | 'ASKED_FOR_RESCHEDULE' | 'ASKED_FOR_CANCELLATION'
  | 'UNCONFIRMED';

export type TodoStatus = 'open' | 'in_progress' | 'resolved' | 'dismissed';
export type TodoPriority = 'high' | 'medium' | 'low';

export interface Todo {
  id: number;
  company_id: number;
  call_id: number | null;
  type: TodoType;
  status: TodoStatus;
  priority: TodoPriority;
  assigned_to: number | null;
  assigned_to_name: string | null;
  notes: string | null;
  is_test: boolean;
  metadata: {
    retell_call_id?: string;
    to_number?: string;
    call_summary?: string;
    user_sentiment?: string;
    appointment_confirmed?: string;
    active_subagent?: string | null;
  } | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
  // Joined from calls:
  to_number: string | null;
  duration_ms: number | null;
  appointment_confirmed: string | null;
  reschedule_requested: boolean | null;
  cancellation_requested: boolean | null;
  call_summary: string | null;
}

export interface TodoLog {
  id: number;
  todo_id: number;
  actor_id: number | null;
  actor_name: string | null;
  actor_type: 'user' | 'system';
  event_type: 'created' | 'assigned' | 'status_changed' | 'resolved' | 'dismissed';
  change: Record<string, unknown> | null;
  notes: string | null;
  created_at: string;
}
```

---

### `src/types/agent-settings.ts` — new file

> **Updated:** `FlowStatus` no longer contains Retell IDs — only boolean flags.

```typescript
export interface AgentSettings {
  representative_name: string | null;
}

export interface CallTypeConfig {
  type: string;
  name: string;
  description: string;
  is_custom: boolean;
  enabled: boolean;
  days_before: number;
  begin_message: string | null;
  general_prompt: string | null;
}

export interface CallSettings {
  business_hours_start: string;  // "HH:MM" 24h
  business_hours_end: string;    // "HH:MM" 24h
  max_attempts: number;          // 1–10
  voicemail_behavior: 'leave' | 'skip';
  include_weekends: boolean;
}

export interface FlowStatus {
  flow_provisioned: boolean;    // ConversationFlow exists in Retell
  agent_provisioned: boolean;   // Agent exists in Retell
  phone_number_set: boolean;    // Phone number purchased and linked
}
```

---

### Update `CompanyResponse` in `src/lib/auth-api.ts`

> **Updated:** `retell_phone_number` is now hidden. Replaced by `phone_number_set` boolean. `retell_provisioned` remains.

```typescript
export interface CompanyResponse {
  company: {
    id: string;
    name: string;
    default_timezone: string;
    address_line1?: string;
    city?: string;
    state?: string;
    zipcode?: string;
    country?: string;
    office_area_code: number | null;
    suggested_area_codes: number[];
    retell_provisioned: boolean;   // true when flow + agent both exist
    phone_number_set: boolean;     // true when a phone number is purchased and linked
  };
}
```

---

## 4. API Functions to Add / Update

Add or update these in `src/lib/auth-api.ts`:

```typescript
// ── Company ───────────────────────────────────────────────────────────────────

export async function getAreaCodes(token: string, state: string):
  Promise<{ state: string; primary: number; area_codes: number[] } | null>

// Response: { message: "Phone number saved", phone_number_set: true }
// Does NOT return the phone number itself
export async function saveRetellPhoneNumber(token: string, phoneNumber: string):
  Promise<{ success: boolean; phone_number_set?: boolean; message?: string; error?: string }>

// ── Retell flow ───────────────────────────────────────────────────────────────

// Response shape changed — only boolean flags, no IDs
export async function getFlowStatus(token: string):
  Promise<{ flow_status: FlowStatus } | null>

// Response shape changed — only boolean flags
export async function syncRetellFlow(token: string):
  Promise<{
    success: boolean;
    message?: string;
    flow_provisioned?: boolean;
    agent_provisioned?: boolean;
    phone_number_set?: boolean;
    error?: string;
  }>

// ── Agent Settings ────────────────────────────────────────────────────────────

export async function getAgentSettings(token: string):
  Promise<{ agent_settings: AgentSettings } | null>

export async function updateAgentSettings(token: string, body: { representative_name: string }):
  Promise<{ success: boolean; agent_settings?: AgentSettings; error?: string }>

// ── Call Settings ─────────────────────────────────────────────────────────────

export async function getCallSettings(token: string):
  Promise<{ call_settings: CallSettings } | null>

export async function updateCallSettings(token: string, body: Partial<CallSettings>):
  Promise<{ success: boolean; call_settings?: CallSettings; error?: string }>

// ── Call Type Settings ────────────────────────────────────────────────────────

// Response: { call_types: CallTypeConfig[] }
// No Retell internal IDs in the response
export async function getCallTypes(token: string):
  Promise<{ call_types: CallTypeConfig[] } | null>

export async function createCallType(token: string, body: { name: string; description: string; days_before?: number }):
  Promise<{ success: boolean; call_type?: CallTypeConfig; error?: string }>

export async function updateCallType(token: string, type: string, body: {
  enabled?: boolean; days_before?: number;
  begin_message?: string; general_prompt?: string;
  name?: string; description?: string;
}): Promise<{ success: boolean; call_type?: CallTypeConfig; error?: string }>

export async function deleteCallType(token: string, type: string):
  Promise<{ success: boolean; error?: string }>

// ── Calls ─────────────────────────────────────────────────────────────────────

// Note: call_cost and transcript_with_tool_calls are NOT in list response
export async function getCalls(token: string, params?: {
  status?: string; appointment_confirmed?: string;
  is_test?: boolean; limit?: number; offset?: number;
}): Promise<{ calls: Call[] } | null>

export async function getCall(token: string, id: number):
  Promise<{ call: Call } | null>

// ── Todos ─────────────────────────────────────────────────────────────────────

export async function getTodos(token: string, params?: {
  status?: string; type?: string; assigned_to?: number;
  is_test?: boolean; limit?: number; offset?: number;
}): Promise<{ todos: Todo[] } | null>

export async function updateTodoStatus(token: string, id: number, body: { status: string; notes?: string }):
  Promise<{ success: boolean; todo?: Todo; error?: string }>

export async function assignTodo(token: string, id: number, assignedTo: number):
  Promise<{ success: boolean; todo?: Todo; error?: string }>

export async function getTodoLogs(token: string, id: number):
  Promise<{ logs: TodoLog[] } | null>

// ── Test call ─────────────────────────────────────────────────────────────────

export async function triggerTestCall(token: string, body: {
  phone_number: string;
  call_type: string;
  customer_name?: string;
  job_date?: string;
}): Promise<{
  success: boolean;
  call_id?: string;   // Retell call ID string e.g. "call_4eac567..."
  status?: string;    // "registered"
  message?: string;
  error?: string;
}>

// ── Scheduler ─────────────────────────────────────────────────────────────────

export async function runDispatcher():
  Promise<{ ok: boolean; fired: number; skipped: number; failed: number }>
```

---

## 5. Endpoint Reference

### 5.1 Auth — unchanged

---

### 5.2 Company

#### `GET /company` 🔒

> **Changed:** `retell_phone_number` removed. Replaced by `phone_number_set` boolean.

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
    "country": "US",
    "office_area_code": 217,
    "suggested_area_codes": [217, 224, 309, 312, 331, 618, 630, 708, 773, 815, 847, 872],
    "retell_provisioned": true,
    "phone_number_set": true
  }
}
```

#### `GET /company/area-codes?state=IL` 🔒
```json
{ "state": "IL", "primary": 217, "area_codes": [217, 224, 309, 312, 331, 618, 630, 708, 773, 815, 847, 872] }
```

#### `PATCH /company` 🔒
All optional: `name`, `default_timezone`, `address_line1`, `city`, `state`, `zipcode`, `country`, `office_area_code`

> When `state` is updated without `office_area_code`, the primary code for that state is auto-set.

#### `PATCH /company/phone-number` 🔒

> **Changed:** Response no longer echoes back the phone number.

```json
// Request
{ "retell_phone_number": "+12175550100" }

// Response 200
{ "message": "Phone number saved", "phone_number_set": true }
```

---

### 5.3 Users — unchanged

---

### 5.4 Agent Settings

#### `GET /agent-settings` 🔒
```json
{ "agent_settings": { "representative_name": "Clara" } }
```

#### `PATCH /agent-settings` 🔒
```json
// Request
{ "representative_name": "Clara" }
// Response
{ "agent_settings": { "representative_name": "Clara" } }
```

#### `GET /agent-settings/flow-status` 🔒

> **Changed:** Retell IDs removed. Returns boolean flags only.

```json
{
  "flow_status": {
    "flow_provisioned": true,
    "agent_provisioned": true,
    "phone_number_set": true
  }
}
```

Use these three flags to drive the status checklist in the Retell Setup settings card.

#### `POST /agent-settings/sync-flow` 🔒

> **Changed:** Retell IDs removed from response.

```json
// Response 200
{
  "message": "Retell conversation flow synced",
  "flow_provisioned": true,
  "agent_provisioned": true,
  "phone_number_set": true
}

// Response 422
{ "error": "No call types configured — add at least one call type before syncing" }
```

---

### 5.5 Call Settings

#### `GET /call-settings` 🔒
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

#### `PATCH /call-settings` 🔒
All optional. Validation: `max_attempts` 1–10, `voicemail_behavior` `"leave"` or `"skip"`.

---

### 5.6 Call Type Settings

#### `GET /agent-settings/call-types` 🔒

> **Changed:** No Retell internal IDs in response (`retell_llm_id`, `retell_agent_id`, `retell_subagent_node_id` are stored in DB but never sent to clients).

```json
{
  "call_types": [
    {
      "type": "customer_confirmation",
      "name": "Customer Confirmation",
      "description": "Call the end customer to confirm their upcoming appointment.",
      "is_custom": false,
      "enabled": true,
      "days_before": 2,
      "begin_message": "Hi {{customer_name}}, this is {{representative_name}}...",
      "general_prompt": "You are {{representative_name}}, a friendly scheduling assistant..."
    },
    {
      "type": "technician_confirmation",
      "name": "Technician Confirmation",
      "is_custom": false, "enabled": true, "days_before": 1, ...
    },
    {
      "type": "technician_reschedule",
      "name": "Technician Reschedule Notice",
      "is_custom": false, "enabled": false, "days_before": 1, ...
    }
  ]
}
```

> Only **enabled** types are active in the Retell flow. Toggling `enabled` re-syncs the flow.

#### `POST /agent-settings/call-types` 🔒
```json
{ "name": "Post-Job Follow-up", "description": "Call customer after job completion." }
```
`begin_message` and `general_prompt` are **auto-generated** — do not send them.

#### `PATCH /agent-settings/call-types/:type` 🔒
All optional: `enabled`, `days_before`, `begin_message`, `general_prompt`, `name` (custom only), `description` (custom only)

#### `DELETE /agent-settings/call-types/:type` 🔒
Custom types only. `403` for built-ins.

#### Placeholder reference
| Placeholder | Available in |
|---|---|
| `{{company_name}}` `{{representative_name}}` `{{job_date}}` `{{job_id}}` | All types |
| `{{customer_name}}` | `customer_confirmation` + custom |
| `{{technician_name}}` `{{customer_address}}` | `technician_confirmation`, `technician_reschedule` |

---

### 5.7 Calls

#### `GET /calls` 🔒

> **Changed:** `call_cost` and `transcript_with_tool_calls` are **not included** in the list response — hidden from customers. `is_test` filter is now reliable (bug fixed).

**Query params:**

| Param | Values | Default | Notes |
|---|---|---|---|
| `status` | `ended` \| `analyzed` | — | |
| `appointment_confirmed` | `yes` \| `no` \| `unclear` | — | |
| `is_test` | `true` \| `false` | `false` | `false` = production calls only, `true` = test calls only |
| `limit` | max 200 | `50` | |
| `offset` | integer | `0` | |

```json
{
  "calls": [{
    "id": 7,
    "retell_call_id": "call_f3e290916560496b4f71e9fe578",
    "to_number": "+919625694975",
    "from_number": "+19786622972",
    "direction": "outbound",
    "status": "analyzed",
    "is_test": true,
    "duration_ms": 33105,
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
      { "role": "user", "content": "Yes, it works." }
    ],
    "created_at": "2026-05-21T11:16:09.091Z",
    "updated_at": "2026-05-21T11:16:10.830Z"
  }]
}
```

#### `GET /calls/:id` 🔒
Returns the full call record. `404` if not found.

---

### 5.8 Todos

#### `GET /todos` 🔒

**Query params:**

| Param | Values | Default |
|---|---|---|
| `status` | `open` \| `in_progress` \| `resolved` \| `dismissed` | — |
| `type` | `NOT_PICKED` \| `VOICEMAIL` \| `ASKED_FOR_RESCHEDULE` \| `ASKED_FOR_CANCELLATION` \| `UNCONFIRMED` | — |
| `assigned_to` | user id | — |
| `is_test` | `true` \| `false` | `false` |
| `limit` / `offset` | — | `50` / `0` |

#### `PATCH /todos/:id/status` 🔒
```json
{ "status": "resolved", "notes": "Called back manually." }
```

#### `PATCH /todos/:id/assign` 🔒 Admin
```json
{ "assigned_to": 3 }
```

#### `GET /todos/:id/logs` 🔒

---

### 5.9 Test Call

#### `POST /test/call` 🔒

Fires immediately. No scheduler. Marked `is_test=true`.

```json
// Request
{
  "phone_number": "+919625694975",
  "call_type": "customer_confirmation",
  "customer_name": "Shivam",
  "job_date": "2026-05-21"
}

// Response 200
{
  "call_id": "call_f3e290916560496b4f71e9fe578",
  "status": "registered",
  "message": "Call initiated. Results will appear in the Calls page (enable 'Test calls' toggle)."
}
```

| Field | Required | Notes |
|---|---|---|
| `phone_number` | ✅ | E.164 format e.g. `+919625694975` |
| `call_type` | ✅ | Must match a configured call type slug |
| `customer_name` | optional | Injected as `{{customer_name}}` |
| `job_date` | optional | ISO date — formatted in prompt |

> **Note:** `agent_id` is no longer in the response (hidden from customers).

---

### 5.10 Scheduler

#### `POST /scheduler/run` — fire pending scheduled_calls
#### `POST /scheduler/daily` — create scheduled_calls from ServiceTrade SRs

---

## 6. Settings Page Changes

### 6.1 General Settings tab — no change

### 6.2 Agent tab — four sections

#### Section A: Identity
- Only `representative_name` — `GET/PATCH /agent-settings`

#### Section B: Retell Setup

> **Updated:** Phone number is never shown. Status card shows booleans only.

```
Retell Setup
──────────────────────────────────────────────────
  ✅  Conversation flow provisioned
  ✅  Agent provisioned
  ✅  Phone number linked

  Office area code
  State: [IL]   Area code: [217 ▼]   [Save]

  [Sync / Reprovision flow]
──────────────────────────────────────────────────
```

- Status from `GET /agent-settings/flow-status` → `{ flow_provisioned, agent_provisioned, phone_number_set }`
- Area code dropdown from `GET /company` → `suggested_area_codes`
- Save area code: `PATCH /company { office_area_code: 312 }`
- Sync: `POST /agent-settings/sync-flow` → check `flow_provisioned`, `agent_provisioned`, `phone_number_set` in response

**Status icon logic:**
| Condition | Icon |
|---|---|
| `flow_provisioned && agent_provisioned` | ✅ |
| `phone_number_set` | ✅ |
| `!flow_provisioned` | ⚠️ — show Sync button |
| `!phone_number_set` | ⚠️ — show area code config |
| `!company.office_area_code` | 🔴 — "Set area code first" |

#### Section C: Call Types
- Cards from `GET /agent-settings/call-types` (no Retell IDs in response)
- Enable toggle → immediate `PATCH`
- Edit prompts + days → Save → `PATCH /agent-settings/call-types/:type`
- Add custom → `POST /agent-settings/call-types`

#### Section D: Call Settings
- `GET /call-settings` / `PATCH /call-settings`
- Business hours, max attempts, voicemail behavior, include weekends

### 6.3 Testing tab
- Test call form → `POST /test/call`
- Show `call_id` from response (not `agent_id`)
- Recent test calls → `GET /calls?is_test=true`

---

## 7. Calls Page Changes

### Real data (replace mock)
```tsx
const { data, isLoading } = useQuery({
  queryKey: ['calls', isTestMode],
  queryFn: async () => {
    const token = getStoredToken();
    return getCalls(token!, { is_test: isTestMode }) ?? { calls: [] };
  },
});
```

Add a **Test / Production toggle** — `is_test=false` by default.

### Table columns

> **Updated:** Remove Cost column — `call_cost` is no longer in the list API response.

| Column | Field | Notes |
|---|---|---|
| Phone | `to_number` | monospace |
| Outcome | `appointment_confirmed` | Confirmed=green, Not confirmed=red, Unclear=gray, Voicemail=outline |
| Sentiment | `user_sentiment` | Positive=green, Negative=red, Neutral=gray pill |
| Duration | `duration_ms` | `1m 27s` |
| Summary | `call_summary` | Truncated |
| Test | `is_test` | Show "Test" badge when true |
| Date | `created_at` | `May 21, 10:00 AM` |

### Detail sheet

> **Updated:** Remove Cost card and Transcript-with-tool-calls — these fields are not in the API response.

1. **Analysis card** — outcome badge, sentiment, flags, summary
2. **Transcript card** — use `transcript` array (agent/user turns only)
3. **Details card** — to/from numbers, disconnect reason

---

## 8. Todos Page

- `GET /todos?status=open&is_test=false` default
- Status filter + Test/Production toggle
- Resolve → `PATCH /todos/:id/status { status: "resolved" }`
- Dismiss → `PATCH /todos/:id/status { status: "dismissed" }`

**Type badge colours:** `NOT_PICKED`=gray, `VOICEMAIL`=blue, `ASKED_FOR_RESCHEDULE`=yellow, `ASKED_FOR_CANCELLATION`=red, `UNCONFIRMED`=orange

---

## 9. Frontend Checklist

### Types
- [ ] Replace `src/types/call.ts` — remove `call_cost`, `transcript_with_tool_calls`, `CallCost*` interfaces
- [ ] Create `src/types/todo.ts`
- [ ] Create/update `src/types/agent-settings.ts` — update `FlowStatus` (booleans only, no IDs)

### API layer (`src/lib/auth-api.ts`)
- [ ] Update `CompanyResponse` — replace `retell_phone_number` with `phone_number_set: boolean`
- [ ] Update `saveRetellPhoneNumber` return type — `{ message, phone_number_set }`
- [ ] Update `getFlowStatus` return type — `FlowStatus` booleans only
- [ ] Update `syncRetellFlow` return type — `{ message, flow_provisioned, agent_provisioned, phone_number_set }`
- [ ] Update `CallTypeConfig` type — remove `retell_llm_id`, `retell_agent_id`
- [ ] Add `getAreaCodes()`
- [ ] Add `getCallSettings()`, `updateCallSettings()`
- [ ] Add `getCallTypes()`, `createCallType()`, `updateCallType()`, `deleteCallType()`
- [ ] Add `getCalls()`, `getCall()` — `is_test` param, no `call_cost`/`transcript_with_tool_calls` in `Call` type
- [ ] Add `getTodos()`, `updateTodoStatus()`, `assignTodo()`, `getTodoLogs()` — `is_test` param
- [ ] Update `triggerTestCall()` — endpoint `POST /test/call`, no `agent_id` in response

### Routing + Sidebar
- [ ] Add `/todos` route + `TodosPage` lazy import
- [ ] Add `ListTodo` + Todos nav item

### Calls page
- [ ] Replace mock with real API + Test/Production toggle
- [ ] Remove Cost column from table
- [ ] Remove Cost card and transcript-with-tool-calls from detail sheet
- [ ] Update `Call` type (no `call_cost`, no `transcript_with_tool_calls`)

### Settings page
- [ ] `RetellSetupCard.tsx` — use boolean-only `FlowStatus`; do not display phone number; show `phone_number_set` status only
- [ ] `AgentSettings.tsx` — representative name only
- [ ] `CallTypeSettings.tsx` — cards (no Retell IDs shown)
- [ ] `CallSettings.tsx` — business hours, attempts, voicemail, weekends
- [ ] `TestingPanel.tsx` — show `call_id` (not `agent_id`) in result; use `GET /calls?is_test=true`

### Todos page
- [ ] `TodosPage.tsx` + `TodosTable.tsx` with `is_test` toggle

---

## 10. Bug Fixes Required

> These are fixes needed in **already-written** frontend code.

---

### Bug 1 — `triggerTestCall` calls a 404 endpoint

**File:** `src/lib/auth-api.ts`

**Fix:** Change endpoint from `/test/trigger-call` → `/test/call`. Update return type: `call_id` is now a `string`, no `scheduled_at`, no `agent_id`.

```typescript
// Fix
const res = await fetch(`${API_BASE}/test/call`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  body: JSON.stringify(params),
});
const data = await res.json().catch(() => ({}));
if (!res.ok) return { success: false, error: data.error || "Failed" };
return { success: true, call_id: data.call_id, status: data.status, message: data.message };
```

---

### Bug 2 — `updateAgentSettings` uses PUT instead of PATCH

**File:** `src/lib/auth-api.ts`

```typescript
method: "PATCH",   // was "PUT"
```

---

### Bug 3 — `getAgentSettings` reads response at wrong key

**File:** `src/lib/auth-api.ts`

```typescript
return data?.agent_settings ?? null;   // was data?.settings
```

---

### Bug 4 — `TestingPanel` shows scheduling UX for immediate call

**File:** `src/components/settings/TestingPanel.tsx`

- Change subtitle: `"Fires immediately."` (not "Scheduled ~2 minutes from now")
- Replace `lastScheduled` state with `lastCallId: string | null`
- On success: `setLastCallId(result.call_id ?? null)` + `toast.success("Test call initiated...")`
- Show `call_id` string below button, not a scheduled time
- Keep "Run dispatcher now" button but relabel tooltip: `"Fire pending PRODUCTION scheduled calls"`

---

### Bug 5 — `FlowStatus` type has stale Retell ID fields ← **NEW**

**File:** `src/types/agent-settings.ts` (or wherever `FlowStatus` is defined)

**Problem:** The type previously included `retell_conversation_flow_id`, `retell_agent_id`, `retell_phone_number`. These are no longer returned by the API.

```typescript
// Before (stale — causes TypeScript errors if you try to read these)
export interface FlowStatus {
  flow_provisioned: boolean;
  agent_provisioned: boolean;
  phone_number_set: boolean;
  retell_conversation_flow_id: string | null;   // ← remove
  retell_agent_id: string | null;               // ← remove
  retell_phone_number: string | null;           // ← remove
}

// After (correct)
export interface FlowStatus {
  flow_provisioned: boolean;
  agent_provisioned: boolean;
  phone_number_set: boolean;
}
```

---

### Bug 6 — `CompanyResponse` still has `retell_phone_number` ← **NEW**

**File:** `src/lib/auth-api.ts` — `CompanyResponse` interface

**Problem:** `retell_phone_number: string | null` is no longer in `GET /company` response. Using it will always give `undefined`.

```typescript
// Before (stale)
retell_phone_number: string | null;   // ← remove

// Add instead
phone_number_set: boolean;            // ← new field
```

Also remove from any component that reads `company.retell_phone_number` — replace with `company.phone_number_set` for status display.

---

### Bug 7 — Calls page shows Cost column but `call_cost` no longer in response ← **NEW**

**File:** `src/components/calls/CallsTable.tsx` and `src/components/calls/CallDetailView.tsx`

**Problem:** `call_cost` is no longer returned by `GET /calls`. Any column or card that reads `call.call_cost` will always be `undefined`.

**Fix:**
- Remove the Cost column from `CallsTable`
- Remove the Cost card from `CallDetailView`
- Remove `CallCost`, `CallCostItem` interfaces from `src/types/call.ts`
- Remove `transcript_with_tool_calls`, `NodeTransition`, `ToolCallInvocation`, `ToolCallResult`, `TranscriptEntry` types — these were for the internal tool-call transcript which is also no longer returned