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
  business_hours_start: string;       // "HH:MM" 24h
  business_hours_end: string;         // "HH:MM" 24h
  max_attempts: number;               // 1–10
  voicemail_behavior: 'leave' | 'skip';
  include_weekends: boolean;
  voicemail_message: string;          // spoken when voicemail detected; supports {{representative_name}}, {{company_name}}
  agent_can_make_changes: boolean;    // when false, agent collects info only — no confirmations or reschedules
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
    "include_weekends": false,
    "voicemail_message": "Hi, this is {{representative_name}} calling from {{company_name}}. We were reaching out to confirm your upcoming appointment. Please call us back at your earliest convenience. Thank you!"
  }
}
```

#### `PATCH /call-settings` 🔒
All optional. Validation: `max_attempts` 1–10, `voicemail_behavior` `"leave"` or `"skip"`.

| Field | Type | Notes |
|---|---|---|
| `voicemail_behavior` | `"leave"` \| `"skip"` | `leave` = speak message then hang up; `skip` = hang up silently |
| `voicemail_message` | string | Message spoken when voicemail is detected. Supports `{{representative_name}}` and `{{company_name}}` placeholders. Synced to Retell automatically. |
| `agent_can_make_changes` | boolean | `true` (default) = agent can confirm/reschedule appointments in real time. `false` = agent collects info only, no DB writes — triggers tool re-registration on Retell automatically. |

> **Auto-sync:** When `voicemail_behavior`, `voicemail_message`, or `agent_can_make_changes` is updated, the backend immediately syncs to Retell. No manual sync needed.

**`agent_can_make_changes = false` behavior:**
- Write tools removed from all subagent nodes: `confirm_appointment`, `reschedule_appointment`, `create_appointment`, `reschedule_job`
- Read-only tools remain: `get_job`, `get_appointment`, `get_quotation`
- Agent prompt appended with: *"You are in read-only mode. Collect the customer's intent and let them know a team member will follow up."*
- Post-call analysis and todos are still created normally

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
    },
    {
      "type": "quotation_followup",
      "name": "Quotation Follow-up",
      "description": "Follow up with the customer on a sent or viewed quotation that hasn't been accepted yet.",
      "is_custom": false,
      "enabled": false,
      "days_before": 3,
      "begin_message": "Hi {{customer_name}}, this is {{representative_name}} calling from {{company_name}}. I'm following up on the quote we recently sent you — do you have a moment to discuss it?",
      "general_prompt": "You are {{representative_name}}, a friendly representative calling on behalf of {{company_name}}. Your goal is to follow up on a quotation that was sent but not yet accepted..."
    }
  ]
}
```

> **4 built-in types:** `customer_confirmation`, `technician_confirmation`, `technician_reschedule`, `quotation_followup`. All are built-in (`is_custom: false`) and cannot be deleted. Only **enabled** types are active in the Retell flow. Toggling `enabled` re-syncs the flow.

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

---

## 11. Customers Page — Migration from ServiceTrade to Platform Table

> The `CustomersPage` and `CustomerDetailPage` currently call ServiceTrade endpoints (`/integrations/servicetrade/customers`). These must be updated to use the new standalone `/customers` endpoint which reads from the platform's own `customers` table.

---

### 11.1 New TypeScript Types

Create or update `src/types/customer.ts`:

```typescript
export interface Customer {
  id: number;
  company_id: number;
  first_name: string | null;
  last_name: string | null;
  full_name: string | null;
  email: string | null;
  phone: string;
  alternate_phone: string | null;
  address_line1: string | null;
  city: string | null;
  state: string | null;
  zipcode: string | null;
  country: string;
  is_active: boolean;
  source: string | null;
  additional_information: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface CustomerJob {
  id: number;
  title: string | null;
  description: string | null;
  job_type: string | null;
  status: 'open' | 'scheduled' | 'confirmed' | 'in_progress' | 'completed' | 'cancelled';
  scheduled_date: string | null;
  scheduled_window_start: string | null;
  scheduled_window_end: string | null;
  technician_name: string | null;
  technician_phone: string | null;
  // Latest appointment for this job
  appointment_id: number | null;
  appointment_status: string | null;
  customer_confirmed: boolean | null;
  technician_confirmed: boolean | null;
  additional_information: Record<string, unknown>;
  created_at: string;
}

export interface CustomerQuotation {
  id: number;
  job_id: number | null;         // direct link to job — use this for exact quote→job mapping
  quote_number: string | null;
  title: string | null;
  status: 'draft' | 'sent' | 'viewed' | 'accepted' | 'rejected' | 'expired';
  total_amount: string | null;   // numeric string e.g. "189.00"
  currency: string;
  valid_until: string | null;
  created_at: string;
}

export interface CustomerDetail extends Customer {
  jobs: CustomerJob[];
  quotations: CustomerQuotation[];
}
```

---

### 11.2 New API Functions

Add to `src/lib/auth-api.ts`:

```typescript
// ── Customers ─────────────────────────────────────────────────────────────────

export async function getCustomers(
  token: string,
  params?: {
    search?: string;       // searches full_name, phone, email
    is_active?: boolean;
    limit?: number;        // max 200, default 50
    offset?: number;
  }
): Promise<{ customers: Customer[] } | null>

export async function getCustomer(
  token: string,
  id: number
): Promise<{ customer: CustomerDetail } | null>

export async function createCustomer(
  token: string,
  body: {
    phone: string;           // required, E.164 or local
    first_name?: string;
    last_name?: string;
    full_name?: string;
    email?: string;
    alternate_phone?: string;
    address_line1?: string;
    city?: string;
    state?: string;
    zipcode?: string;
    country?: string;
    source?: string;
    additional_information?: Record<string, unknown>;
  }
): Promise<{ success: boolean; customer?: Customer; error?: string }>

export async function updateCustomer(
  token: string,
  id: number,
  body: Partial<Omit<Customer, 'id' | 'company_id' | 'created_at' | 'updated_at'>>
): Promise<{ success: boolean; customer?: Customer; error?: string }>
```

---

### 11.3 New Endpoint Reference

#### `GET /customers` 🔒

**Query params:** `search` (name/phone/email), `is_active` (`true`/`false`), `limit` (max 200), `offset`

```json
{
  "customers": [
    {
      "id": 1,
      "full_name": "James Carter",
      "email": "james.carter@email.com",
      "phone": "+14085551001",
      "alternate_phone": null,
      "address_line1": "142 Oak Street",
      "city": "San Jose",
      "state": "CA",
      "zipcode": "95101",
      "country": "US",
      "is_active": true,
      "source": "manual",
      "additional_information": { "customer_since": "2022-03-15" },
      "created_at": "2026-05-22T10:00:00Z",
      "updated_at": "2026-05-22T10:00:00Z"
    }
  ]
}
```

#### `GET /customers/:id` 🔒

Returns customer + their complete job history (each with latest appointment) + quotations.

```json
{
  "customer": {
    "id": 1,
    "full_name": "James Carter",
    "phone": "+14085551001",
    "address_line1": "142 Oak Street",
    "city": "San Jose",
    "state": "CA",
    "is_active": true,
    "jobs": [
      {
        "id": 1,
        "title": "Annual HVAC Inspection",
        "job_type": "inspection",
        "status": "scheduled",
        "scheduled_date": "2026-05-28",
        "scheduled_window_start": "2026-05-28T09:00:00Z",
        "technician_name": "Ryan Brooks",
        "technician_phone": "+14085552001",
        "appointment_id": 1,
        "appointment_status": "scheduled",
        "customer_confirmed": false,
        "technician_confirmed": false
      }
    ],
    "quotations": [
      {
        "id": 1,
        "job_id": 1,
        "quote_number": "Q-2026-001",
        "title": "HVAC Inspection Quote",
        "status": "sent",
        "total_amount": "189.00",
        "currency": "USD",
        "valid_until": "2026-06-15",
        "created_at": "2026-05-22T10:00:00Z"
      }
    ]
  }
}
```

#### `POST /customers` 🔒
```json
// Request — only phone is required
{ "phone": "+14085551001", "first_name": "James", "last_name": "Carter", "email": "...", "address_line1": "..." }
// Response 201
{ "customer": { ...created } }
// Response 400 — missing phone
{ "error": "phone is required" }
// Response 409 — duplicate phone
{ "error": "A customer with this phone number already exists" }
```

#### `PATCH /customers/:id` 🔒
```json
// Request — all optional
{ "email": "new@email.com", "is_active": false }
// Response 200
{ "customer": { ...updated } }
// Response 404
{ "error": "Customer not found" }
```

---

### 11.4 Frontend Changes Required

#### `src/pages/CustomersPage.tsx` — replace ServiceTrade call

**Current (broken after migration):**
```typescript
import { getServiceTradeCustomers, type STCustomer } from "@/lib/auth-api";
// ...
getServiceTradeCustomers(token, includeInactive, page, perPage)
```

**Replace with:**
```typescript
import { getCustomers } from "@/lib/auth-api";
import type { Customer } from "@/types/customer";
// ...
getCustomers(token, {
  is_active: includeInactive ? undefined : true,  // undefined = show all
  limit: perPage,
  offset: (page - 1) * perPage,
})
```

**Column/display changes:**

| Old (ServiceTrade) | New (customers table) |
|---|---|
| `c.name` | `c.full_name` |
| `c.phone_number` | `c.phone` |
| `c.address` (nested object) | `c.address_line1`, `c.city`, `c.state`, `c.zipcode` (flat strings) |
| `c.location_count` | Remove — no equivalent |
| `c.is_active` | `c.is_active` (same) |
| Link to `/customers/${c.servicetrade_id}` | Link to `/customers/${c.id}` |

**Remove:**
- "Locations on this page" KPI card (ServiceTrade concept)
- `location_count` badge

**Update description text:**
```
// Before
"Browse ServiceTrade companies that currently roll up to locations with service requests."

// After
"All customers managed by your company. Click a customer to see their job history and quotations."
```

---

#### `src/pages/CustomerDetailPage.tsx` — replace ServiceTrade call

**Current (broken after migration):**
```typescript
const { servicetradeCompanyId } = useParams<{ servicetradeCompanyId: string }>();
import { getServiceTradeCustomerDetail, type STCustomerDetail } from "@/lib/auth-api";
// ...
getServiceTradeCustomerDetail(token, stCompanyId, includeInactive)
```

**Replace with:**
```typescript
const { id } = useParams<{ id: string }>();
import { getCustomer } from "@/lib/auth-api";
import type { CustomerDetail } from "@/types/customer";
// ...
getCustomer(token, Number(id))
```

**New detail layout — 3 sections:**

**1. Customer header** — `full_name`, `phone`, `email`, `address_line1 city state zipcode`, `is_active` badge, `source` badge

**2. Jobs table** — list `customer.jobs`:

| Column | Field |
|---|---|
| Title | `job.title` |
| Type | `job.job_type` badge |
| Status | `job.status` badge (color-coded) |
| Scheduled | `job.scheduled_date` |
| Technician | `job.technician_name` |
| Appointment | `job.appointment_status` badge |
| Confirmed | `job.customer_confirmed` ✅/❌ |

**3. Quotations table** — list `customer.quotations`:

| Column | Field |
|---|---|
| Quote # | `quotation.quote_number` |
| Title | `quotation.title` |
| Status | `quotation.status` badge |
| Amount | `$${quotation.total_amount}` |
| Valid until | `quotation.valid_until` |

**Job status badge colours:**

| Status | Colour |
|---|---|
| `open` | gray |
| `scheduled` | blue |
| `confirmed` | green |
| `in_progress` | yellow |
| `completed` | emerald |
| `cancelled` | red |

**Quotation status badge colours:**

| Status | Colour |
|---|---|
| `draft` | gray |
| `sent` | blue |
| `viewed` | purple |
| `accepted` | green |
| `rejected` | red |
| `expired` | orange |

**Remove:**
- "Include inactive" toggle for locations (ServiceTrade concept)
- Locations list / location detail drill-down
- Contacts per location
- Service requests per location

---

#### `src/App.tsx` — update route param

```tsx
// Before
<Route path="/customers/:servicetradeCompanyId" element={<CustomerDetailPage />} />

// After
<Route path="/customers/:id" element={<CustomerDetailPage />} />
```

---

### 11.5 Note on Quote→Job Linking (Contract Gap — Now Fixed)

The frontend agent noted that `job_id` was missing from quotation responses, making exact quote-to-job linking impossible and requiring a fallback:

> *"Show the next upcoming job and the most relevant quotation (nearest valid date, else latest created)"*

**This gap is now fixed.** `job_id` is included in every quotation in `GET /customers/:id`. The linking logic is:

```typescript
// Exact linking (now possible)
const jobQuotations = customer.quotations.filter(q => q.job_id === job.id);

// Fallback (keep this as a safety net for quotations where job_id is null)
const fallbackQuotation = customer.quotations
  .filter(q => q.job_id === null)
  .sort((a, b) => {
    // Prefer nearest valid_until, then newest created_at
    if (a.valid_until && b.valid_until) return new Date(a.valid_until).getTime() - new Date(b.valid_until).getTime();
    if (a.valid_until) return -1;
    if (b.valid_until) return 1;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  })[0] ?? null;
```

Use the exact `job_id` match first. Fall back to the date-sorted heuristic only when `quotation.job_id === null` (e.g. a customer-level quote not tied to a specific job).

---

### 11.6 Checklist

- [ ] Create `src/types/customer.ts` — `Customer`, `CustomerJob`, `CustomerQuotation` (with `job_id`), `CustomerDetail`
- [ ] Add `getCustomers()`, `getCustomer()`, `createCustomer()`, `updateCustomer()` to `src/lib/auth-api.ts`
- [ ] Update `src/pages/CustomersPage.tsx` — replace `getServiceTradeCustomers` with `getCustomers`; update field names; remove `location_count`
- [ ] Update `src/pages/CustomerDetailPage.tsx` — replace `getServiceTradeCustomerDetail` with `getCustomer`; jobs table + quotations table; use `q.job_id` for exact linking with date-sorted fallback for `job_id === null`
- [ ] Update `src/App.tsx` — route param `:servicetradeCompanyId` → `:id`

---

## 12. Jobs & Appointments — Replace Inspections Mock with Real API

> The `InspectionsPage` at `/inspections` currently uses `mockInspections`. These map directly to the new `/jobs` API. Replace the mock entirely — the `Inspection` type, mock data, and filter logic should all be replaced with real data from `GET /jobs`.

---

### 12.1 New TypeScript Types

Create `src/types/job.ts`:

```typescript
export type JobStatus = 'open' | 'scheduled' | 'confirmed' | 'in_progress' | 'completed' | 'cancelled';
export type JobType = 'inspection' | 'repair' | 'maintenance' | 'installation' | 'estimate';
export type AppointmentStatus = 'scheduled' | 'confirmed' | 'rescheduled' | 'cancelled' | 'completed' | 'no_show';

// Used in GET /jobs list (lightweight — includes joined customer + technician + active appointment)
export interface Job {
  id: number;
  company_id: number;
  customer_id: number;
  technician_id: number | null;
  title: string | null;
  description: string | null;
  job_type: JobType | null;
  status: JobStatus;
  scheduled_date: string | null;          // ISO date "2026-05-28"
  scheduled_window_start: string | null;  // ISO datetime
  scheduled_window_end: string | null;
  external_ref: string | null;
  source: string | null;
  additional_information: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  // Joined from customers + technicians:
  customer_name: string | null;
  customer_phone: string | null;
  customer_address: string | null;        // "142 Oak Street, San Jose, CA"
  technician_name: string | null;
  technician_phone: string | null;
  // Latest active appointment:
  active_appointment: JobAppointment | null;
}

export interface JobAppointment {
  id: number;
  job_id?: number;
  technician_id?: number | null;
  scheduled_start: string;
  scheduled_end: string | null;
  status: AppointmentStatus;
  customer_confirmed: boolean | null;
  technician_confirmed: boolean | null;
  customer_confirmed_at: string | null;
  technician_confirmed_at: string | null;
  reschedule_requested: boolean;
  rescheduled_to: string | null;
  previous_appointment_id: number | null;
  cancellation_reason: string | null;
  external_ref: string | null;
  source: string | null;
  additional_information: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  // Joined:
  technician_name: string | null;
  technician_phone: string | null;
}

// Used in GET /jobs/:id (full detail)
export interface JobDetail extends Job {
  customer: {
    id: number;
    full_name: string | null;
    phone: string;
    email: string | null;
    address_line1: string | null;
    city: string | null;
    state: string | null;
    zipcode: string | null;
  };
  technician: {
    id: number;
    name: string;
    phone: string;
    email: string | null;
  } | null;
  appointments: JobAppointment[];  // full history, newest first
  quotations: Array<{
    id: number;
    quote_number: string | null;
    title: string | null;
    status: string;
    total_amount: string | null;
    currency: string;
    valid_until: string | null;
    created_at: string;
  }>;
}
```

---

### 12.2 New API Functions

Add to `src/lib/auth-api.ts`:

```typescript
// ── Jobs ──────────────────────────────────────────────────────────────────────

export async function getJobs(
  token: string,
  params?: {
    status?: JobStatus;
    job_type?: JobType;
    customer_id?: number;
    technician_id?: number;
    scheduled_date_from?: string;   // ISO date
    scheduled_date_to?: string;
    search?: string;                // searches title + customer name
    limit?: number;                 // max 200, default 50
    offset?: number;
  }
): Promise<{ jobs: Job[] } | null>

export async function getJob(
  token: string,
  id: number
): Promise<{ job: JobDetail } | null>

export async function createJob(
  token: string,
  body: {
    customer_id: number;            // required
    technician_id?: number;
    title?: string;
    description?: string;
    job_type?: JobType;
    status?: JobStatus;
    scheduled_date?: string;
    scheduled_window_start?: string;
    scheduled_window_end?: string;
    additional_information?: Record<string, unknown>;
  }
): Promise<{ success: boolean; job?: Job; error?: string }>

export async function updateJob(
  token: string,
  id: number,
  body: Partial<Pick<Job,
    'technician_id' | 'title' | 'description' | 'job_type' | 'status' |
    'scheduled_date' | 'scheduled_window_start' | 'scheduled_window_end' | 'additional_information'
  >>
): Promise<{ success: boolean; job?: Job; error?: string }>

// ── Appointments ──────────────────────────────────────────────────────────────

export async function getJobAppointments(
  token: string,
  jobId: number
): Promise<{ appointments: JobAppointment[] } | null>

export async function createJobAppointment(
  token: string,
  jobId: number,
  body: {
    scheduled_start: string;        // required, ISO datetime
    scheduled_end?: string;
    technician_id?: number;
    status?: AppointmentStatus;
    additional_information?: Record<string, unknown>;
  }
): Promise<{ success: boolean; appointment?: JobAppointment; error?: string }>

export async function updateAppointment(
  token: string,
  id: number,
  body: {
    status?: AppointmentStatus;
    scheduled_start?: string;
    scheduled_end?: string;
    technician_id?: number;
    customer_confirmed?: boolean;
    technician_confirmed?: boolean;
    reschedule_requested?: boolean;
    rescheduled_to?: string;
    cancellation_reason?: string;
    additional_information?: Record<string, unknown>;
  }
): Promise<{ success: boolean; appointment?: JobAppointment; error?: string }>

// Returns active technicians for the assignment dropdown
export async function getTechnicians(
  token: string,
  params?: { is_available?: boolean }
): Promise<{
  technicians: Array<{
    id: number;
    name: string;
    phone: string;
    email: string | null;
    is_available: boolean;
  }>
} | null>
```

---

### 12.3 Endpoint Reference

#### `GET /jobs` 🔒

**Query params:** `status`, `job_type`, `customer_id`, `technician_id`, `scheduled_date_from`, `scheduled_date_to`, `search`, `limit` (max 200), `offset`

```json
{
  "jobs": [{
    "id": 1,
    "customer_id": 1,
    "technician_id": 1,
    "title": "Annual HVAC Inspection",
    "job_type": "inspection",
    "status": "scheduled",
    "scheduled_date": "2026-05-28",
    "scheduled_window_start": "2026-05-28T09:00:00Z",
    "scheduled_window_end": "2026-05-28T11:00:00Z",
    "customer_name": "James Carter",
    "customer_phone": "+14085551001",
    "customer_address": "142 Oak Street, San Jose, CA",
    "technician_name": "Ryan Brooks",
    "technician_phone": "+14085552001",
    "active_appointment": {
      "id": 1,
      "scheduled_start": "2026-05-28T09:00:00Z",
      "status": "scheduled",
      "customer_confirmed": false,
      "technician_confirmed": false
    },
    "source": "manual",
    "additional_information": {},
    "created_at": "2026-05-22T10:00:00Z",
    "updated_at": "2026-05-22T10:00:00Z"
  }]
}
```

#### `GET /jobs/:id` 🔒

Full detail with nested `customer`, `technician`, `appointments` (full history), and `quotations`.

```json
{
  "job": {
    "id": 1, "title": "Annual HVAC Inspection", "status": "scheduled",
    "customer": {
      "id": 1, "full_name": "James Carter", "phone": "+14085551001",
      "email": "james.carter@email.com", "address_line1": "142 Oak Street",
      "city": "San Jose", "state": "CA", "zipcode": "95101"
    },
    "technician": {
      "id": 1, "name": "Ryan Brooks", "phone": "+14085552001", "email": "ryan@alexent.com"
    },
    "appointments": [
      {
        "id": 1, "scheduled_start": "2026-05-28T09:00:00Z",
        "status": "scheduled", "customer_confirmed": false,
        "technician_confirmed": false, "reschedule_requested": false,
        "technician_name": "Ryan Brooks", "technician_phone": "+14085552001"
      }
    ],
    "quotations": [
      { "id": 1, "quote_number": "Q-2026-001", "title": "HVAC Inspection Quote",
        "status": "sent", "total_amount": "189.00", "currency": "USD",
        "valid_until": "2026-06-15" }
    ]
  }
}
```

#### `POST /jobs` 🔒
```json
// Request — customer_id required
{ "customer_id": 1, "technician_id": 1, "title": "New Repair", "job_type": "repair",
  "scheduled_date": "2026-06-10", "scheduled_window_start": "2026-06-10T10:00:00Z" }
// Response 201
{ "job": { ...created } }
// Response 400
{ "error": "customer_id is required" }
```

#### `PATCH /jobs/:id` 🔒
```json
// Assign technician
{ "technician_id": 2 }
// Change status
{ "status": "confirmed" }
// Update schedule
{ "scheduled_date": "2026-06-15", "scheduled_window_start": "2026-06-15T09:00:00Z" }
// Response 200
{ "job": { ...updated } }
```

#### `GET /jobs/technicians` 🔒

Returns active technicians for the company. Use this to populate the **Assign technician** dropdown when creating or updating an appointment.

**Query params:** `is_available` (`true` / `false`) — filter by current availability

```json
{
  "technicians": [
    { "id": 1, "name": "Ryan Brooks",   "phone": "+14085552001", "email": "ryan@alexent.com",   "is_available": true },
    { "id": 2, "name": "Sofia Mendez",  "phone": "+14085552002", "email": "sofia@alexent.com",  "is_available": true },
    { "id": 3, "name": "Kevin Patel",   "phone": "+14085552003", "email": "kevin@alexent.com",  "is_available": false },
    { "id": 4, "name": "Angela Wu",     "phone": "+14085552004", "email": "angela@alexent.com", "is_available": true }
  ]
}
```

> Only `is_active = true` technicians are returned. Pass `is_available=true` to filter to those currently available.

#### `GET /jobs/:id/appointments` 🔒
```json
{ "appointments": [{ "id": 1, "status": "scheduled", "scheduled_start": "...", ... }] }
```

#### `POST /jobs/:id/appointments` 🔒
```json
// Request — scheduled_start required
{ "scheduled_start": "2026-06-10T10:00:00Z", "scheduled_end": "2026-06-10T12:00:00Z", "technician_id": 1 }
// Response 201
{ "appointment": { ...created } }
```

#### `PATCH /jobs/appointments/:id` 🔒
```json
// Confirm by customer (no technician required)
{ "customer_confirmed": true }

// Confirm technician — only valid if technician_id is already set OR sent in same request
{ "technician_confirmed": true }
{ "technician_id": 2, "technician_confirmed": true }  // assign + confirm in one call

// Mark rescheduled
{ "status": "rescheduled", "reschedule_requested": true, "rescheduled_to": "2026-06-20T10:00:00Z" }

// Cancel
{ "status": "cancelled", "cancellation_reason": "Customer request" }

// Response 200
{ "appointment": { ...updated } }

// Response 422 — technician_confirmed=true but no technician assigned
{ "error": "Cannot confirm technician — no technician is assigned to this appointment. Assign a technician first." }
```

> **Rules enforced by the backend:**
> 1. `customer_confirmed: true` — no precondition, always allowed
> 2. `technician_confirmed: true` — requires a `technician_id` to be set on the appointment (either already stored or sent in the same request). Returns `422` otherwise.
> 3. Setting either confirmed flag to `true` automatically sets the corresponding `_confirmed_at` timestamp.

---

### 12.4 Business Rules Enforced by the Backend

These rules are enforced server-side. The UI must reflect them to avoid confusing error states.

---

#### Rule 1 — Job status lifecycle

| Status | Meaning | Has appointment? |
|---|---|---|
| `open` | Job created, no appointment scheduled yet | No |
| `scheduled` | Appointment exists with a specific date/time | Yes |
| `confirmed` | Customer (and optionally technician) confirmed | Yes |
| `in_progress` | Technician on-site | Yes |
| `completed` | Work done | Yes |
| `cancelled` | Job cancelled | Either |

**`open` means no appointment record exists for the job.** A job can only be `open` while it has no appointments.

---

#### Rule 2 — Creating an appointment auto-promotes the job

`POST /jobs/:id/appointments` automatically updates the job status:

```
open  ──→  scheduled   (when first appointment is created)
```

Only fires for `open` jobs. `confirmed`, `in_progress`, and `completed` jobs are never touched.

**UI implication:** After a successful `POST /jobs/:id/appointments`, invalidate/refetch the parent job — its `status` will have changed from `open` to `scheduled`.

```typescript
// After createJobAppointment() succeeds:
queryClient.invalidateQueries({ queryKey: ["jobs"] });
queryClient.invalidateQueries({ queryKey: ["job", jobId] });
```

---

#### Rule 4 — Appointment state changes sync job status automatically

`PATCH /jobs/appointments/:id` triggers automatic job status updates:

| Appointment change | Job status transition |
|---|---|
| `customer_confirmed = true` | `scheduled` → `confirmed` |
| `status = "rescheduled"` | `confirmed` → `scheduled` (needs re-confirmation) |
| `status = "cancelled"` AND no other active appointments remain | `scheduled` / `confirmed` → `open` |
| `status = "cancelled"` AND other active appointments exist | no change |

**UI implication:** Always invalidate/refetch the parent job after updating an appointment — the job status may have changed.

```typescript
// After updateAppointment() succeeds:
queryClient.invalidateQueries({ queryKey: ["jobs"] });
queryClient.invalidateQueries({ queryKey: ["job", jobId] });
```

---

#### Rule 5 — Technician confirmation requires an assigned technician

`PATCH /jobs/appointments/:id` with `technician_confirmed: true` returns `422` if no technician is assigned.

**UI implication:** Disable or hide the "Confirm technician" button/checkbox when `appointment.technician_id === null`. Show a tooltip: *"Assign a technician before marking them as confirmed."*

You can assign and confirm in a single request:
```typescript
// Assign + confirm in one call — valid
updateAppointment(token, id, { technician_id: 2, technician_confirmed: true })
```

---

### 12.5 InspectionsPage → Jobs Page Migration

The `/inspections` route and all its components currently use `mockInspections` and the `Inspection` type. Replace entirely with the Jobs API.

#### `src/pages/InspectionsPage.tsx` — replace mock with real API

**Current (mock-based):**
```typescript
import { mockInspections } from "@/mocks/inspections";
import type { Inspection } from "@/types/inspection";
```

**Replace with:**
```typescript
import { useQuery } from "@tanstack/react-query";
import { getJobs, getStoredToken } from "@/lib/auth-api";
import type { Job, JobStatus, JobType } from "@/types/job";
```

**State & query:**
```typescript
const [statusFilter, setStatusFilter] = useState<JobStatus | "all">("all");
const [jobTypeFilter, setJobTypeFilter] = useState<JobType | "all">("all");
const [search, setSearch] = useState("");

const { data, isLoading } = useQuery({
  queryKey: ["jobs", statusFilter, jobTypeFilter, search],
  queryFn: async () => {
    const token = getStoredToken();
    if (!token) return { jobs: [] };
    return getJobs(token, {
      status: statusFilter !== "all" ? statusFilter : undefined,
      job_type: jobTypeFilter !== "all" ? jobTypeFilter : undefined,
      search: search || undefined,
      limit: 100,
    }) ?? { jobs: [] };
  },
});
const jobs = data?.jobs ?? [];
```

---

#### `src/components/inspections/InspectionsTable.tsx` — update columns

| Column | Field | Notes |
|---|---|---|
| Job | `job.title` | Primary identifier |
| Customer | `job.customer_name` | With phone as subtext |
| Type | `job.job_type` | Badge |
| Status | `job.status` | Color-coded badge (see below) |
| Scheduled | `job.scheduled_date` | `May 28` format |
| Technician | `job.technician_name` | `—` if unassigned |
| Appointment | `job.active_appointment?.status` | Badge, `—` if none |
| Confirmed | `job.active_appointment?.customer_confirmed` | ✅ / ❌ / `—` |

**Job status badge colours:**
| Status | Colour |
|---|---|
| `open` | gray |
| `scheduled` | blue |
| `confirmed` | green |
| `in_progress` | amber |
| `completed` | emerald |
| `cancelled` | red |

**Job type badge colours:** `inspection`=purple, `repair`=orange, `maintenance`=cyan, `installation`=indigo, `estimate`=pink

---

#### `src/components/inspections/InspectionDetailSheet.tsx` — update detail view

Replace `Inspection` type with `Job`. New layout when a row is clicked → open `GET /jobs/:id`:

**1. Job header** — title, type badge, status badge, scheduled date/window

**2. Customer card** — `job.customer.full_name`, phone, email, address

**3. Technician card** — `job.technician.name`, phone (or "Unassigned" with assign button)

**4. Appointments timeline** — ordered list of `job.appointments`:
- Each row: `scheduled_start` date, `status` badge, `customer_confirmed` ✅/❌, `technician_confirmed` ✅/❌
- Latest appointment highlighted

**5. Quotations** — same table as `CustomerDetailPage`: quote#, title, status, amount, valid until

---

#### `src/components/inspections/InspectionsFilters.tsx` — update filter options

Replace `source` filter (CRM/CSV) with `job_type` filter. Replace `InspectionStatus` options with `JobStatus` options.

```typescript
// Status filter options
const STATUS_OPTIONS = [
  { value: "all", label: "All statuses" },
  { value: "open", label: "Open" },
  { value: "scheduled", label: "Scheduled" },
  { value: "confirmed", label: "Confirmed" },
  { value: "in_progress", label: "In progress" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
];

// Job type filter options
const TYPE_OPTIONS = [
  { value: "all", label: "All types" },
  { value: "inspection", label: "Inspection" },
  { value: "repair", label: "Repair" },
  { value: "maintenance", label: "Maintenance" },
  { value: "installation", label: "Installation" },
  { value: "estimate", label: "Estimate" },
];
```

---

### 12.6 Checklist

- [ ] Create `src/types/job.ts` — `Job`, `JobDetail`, `JobAppointment`, `JobStatus`, `JobType`, `AppointmentStatus`
- [ ] Add `getJobs()`, `getJob()`, `createJob()`, `updateJob()` to `src/lib/auth-api.ts`
- [ ] Add `getJobAppointments()`, `createJobAppointment()`, `updateAppointment()`, `getTechnicians()` to `src/lib/auth-api.ts`
- [ ] Update `src/pages/InspectionsPage.tsx` — replace mock with TanStack Query + `getJobs()`
- [ ] Update `src/components/inspections/InspectionsTable.tsx` — new `Job` columns; `open` jobs show no appointment badge
- [ ] Update `src/components/inspections/InspectionDetailSheet.tsx` — fetch `GET /jobs/:id`; after creating appointment, invalidate job query (status changes `open` → `scheduled`)
- [ ] Update `src/components/inspections/InspectionsFilters.tsx` — replace `source` + `InspectionStatus` filters with `JobType` + `JobStatus`
- [ ] **Populate "Assign technician" dropdown from `GET /jobs/technicians`** — show `name`, grey out `is_available = false` ones
- [ ] **Disable "Confirm technician" when `appointment.technician_id === null`** — show tooltip: *"Assign a technician first"*
- [ ] **Invalidate job query after `createJobAppointment()`** — job status auto-changes `open` → `scheduled`
- [ ] **Invalidate job query after `updateAppointment()`** — job status may have changed (confirmed/rescheduled/cancelled)
- [ ] Delete `src/mocks/inspections.ts` and `src/types/inspection.ts` once migration is complete

---

## 13. Call Trigger Configuration — When to Auto-Call Customers

> New Settings section that lets each tenant configure **which business conditions trigger an outbound confirmation call**. All four triggers are seeded as disabled — tenants toggle them on as needed.

---

### 13.1 Trigger Types

| Trigger | Calls | Fires when... | Default `days_before` |
|---|---|---|---|
| `scheduled_unconfirmed` | **Customer** | Job is scheduled but customer hasn't confirmed | 2 days before appointment |
| `quotation_pending` | **Customer** | Quotation sent/viewed but not yet accepted | 3 days after sent |
| `open_job_due_soon` | **Customer** | Open job's `scheduled_date` is approaching | 7 days before |
| `technician_scheduled` | **Technician** | Appointment is scheduled with an assigned technician who hasn't confirmed | 1 day before appointment |

**All four are disabled by default.** Tenant enables them in Settings → Call Triggers.

---

### 13.2 New TypeScript Type

Add to `src/types/agent-settings.ts`:

```typescript
export type CallTriggerType =
  | 'scheduled_unconfirmed'
  | 'quotation_pending'
  | 'open_job_due_soon'
  | 'technician_scheduled';

export interface CallTriggerConfig {
  trigger_type: CallTriggerType;
  enabled: boolean;
  call_type: string;          // which call type slug to use (e.g. "customer_confirmation")
  days_before: number;        // days before job date to fire
  trigger_config: {
    // scheduled_unconfirmed
    retry_if_no_answer?: boolean;
    // quotation_pending
    quote_statuses?: string[];   // default: ["sent", "viewed"]
    days_after_sent?: number;    // default: 3
    // open_job_due_soon
    only_if_technician_assigned?: boolean;
  };
  description: string | null;
  updated_at: string;
}
```

---

### 13.3 New API Functions

Add to `src/lib/auth-api.ts`:

```typescript
// GET /call-triggers — always returns all 3 trigger configs
export async function getCallTriggers(token: string):
  Promise<{ call_triggers: CallTriggerConfig[] } | null>

// PATCH /call-triggers/:type — update one trigger
export async function updateCallTrigger(
  token: string,
  type: CallTriggerType,
  body: {
    enabled?: boolean;
    call_type?: string;
    days_before?: number;
    trigger_config?: CallTriggerConfig['trigger_config'];
  }
): Promise<{ success: boolean; call_trigger?: CallTriggerConfig; error?: string }>
```

---

### 13.4 Endpoint Reference

#### `GET /call-triggers` 🔒

Always returns all four triggers. Missing DB rows return built-in defaults.

```json
{
  "call_triggers": [
    {
      "trigger_type": "scheduled_unconfirmed",
      "enabled": false,
      "call_type": "customer_confirmation",
      "days_before": 2,
      "trigger_config": { "retry_if_no_answer": true },
      "description": "Call customer to confirm their upcoming appointment when job is scheduled but unconfirmed."
    },
    {
      "trigger_type": "quotation_pending",
      "enabled": false,
      "call_type": "quotation_followup",
      "days_before": 3,
      "trigger_config": { "quote_statuses": ["sent", "viewed"], "days_after_sent": 3 },
      "description": "Follow up with customer on a sent or viewed quotation that hasn't been accepted yet."
    },
    {
      "trigger_type": "open_job_due_soon",
      "enabled": false,
      "call_type": "customer_confirmation",
      "days_before": 7,
      "trigger_config": { "only_if_technician_assigned": false },
      "description": "Call customer when an open (unscheduled) job is approaching its expected date."
    },
    {
      "trigger_type": "technician_scheduled",
      "enabled": false,
      "call_type": "technician_confirmation",
      "days_before": 1,
      "trigger_config": {},
      "description": "Call the assigned technician when an appointment is scheduled to confirm their availability."
    }
  ]
}
```

#### `PATCH /call-triggers/:type` 🔒

`:type` must be one of: `scheduled_unconfirmed`, `quotation_pending`, `open_job_due_soon`, `technician_scheduled`

```json
// Enable a trigger
{ "enabled": true }

// Enable with custom days
{ "enabled": true, "days_before": 3 }

// Update trigger-specific config
{ "trigger_config": { "quote_statuses": ["sent"], "days_after_sent": 5 } }

// Response 200
{ "call_trigger": { ...updated } }

// Response 400 — invalid type or days_before < 1
{ "error": "days_before must be an integer >= 1" }
```

---

### 13.5 Settings Page — Call Triggers Section

Add a new **"Call Triggers"** section to the Settings page (after Call Settings, before Testing). Group the triggers into two tabs or visual sections: **Customer Calls** and **Technician Calls**.

```
Call Triggers
──────────────────────────────────────────────────────────────────
  Configure when Clara should automatically place outbound calls.
  Each trigger creates a scheduled call via the daily job.

  ── Customer Calls ────────────────────────────────────────────

  ┌─────────────────────────────────────────────────────────────┐
  │  [●  Enabled  ]   Scheduled — Unconfirmed      👤 Customer  │
  │  Call when job is scheduled but customer hasn't confirmed   │
  │  Days before appointment:  [2]                              │
  │  Call type: [Customer Confirmation ▼]              [Save]   │
  └─────────────────────────────────────────────────────────────┘

  ┌─────────────────────────────────────────────────────────────┐
  │  [○  Disabled ]   Quotation Pending            👤 Customer  │
  │  Follow up on sent/viewed quotations not yet accepted       │
  │  Days after sent:  [3]   Statuses: [sent] [viewed]          │
  │  Call type: [Quotation Follow-up ▼]                [Save]   │
  └─────────────────────────────────────────────────────────────┘

  ┌─────────────────────────────────────────────────────────────┐
  │  [○  Disabled ]   Open Job Due Soon            👤 Customer  │
  │  Call when an unscheduled job's date is approaching         │
  │  Days before:  [7]                                          │
  │  Call type: [Customer Confirmation ▼]              [Save]   │
  └─────────────────────────────────────────────────────────────┘

  ── Technician Calls ──────────────────────────────────────────

  ┌─────────────────────────────────────────────────────────────┐
  │  [○  Disabled ]   Appointment Scheduled        🔧 Technician│
  │  Call technician to confirm when appointment is booked      │
  │  Days before appointment:  [1]                              │
  │  Call type: [Technician Confirmation ▼]            [Save]   │
  └─────────────────────────────────────────────────────────────┘
──────────────────────────────────────────────────────────────────
```

**UX behaviour:**
- Toggle `enabled` → immediate `PATCH` (no Save needed)
- Editing `days_before` or `trigger_config` fields → Save button → `PATCH`
- `call_type` dropdown populated from `GET /agent-settings/call-types` (all enabled types + the type currently set on the trigger)
- Disabled triggers show a muted/greyed card
- Show 👤 or 🔧 icon to distinguish who gets called

**Tenant scenarios:**

| Tenant scenario | Configuration |
|---|---|
| "Only confirm scheduled appointments" | Enable `scheduled_unconfirmed` only |
| "Also notify technicians" | Enable `scheduled_unconfirmed` + `technician_scheduled` |
| "No quotation follow-ups" | Leave `quotation_pending` disabled |
| "Call open jobs 1 week out" | Enable `open_job_due_soon`, `days_before = 7` |
| "Full automation" | Enable all four |
| "Manual calls only" | All disabled (default) |

---

### 13.6 Checklist

- [ ] Add `CallTriggerType` and `CallTriggerConfig` to `src/types/agent-settings.ts`
- [ ] Add `getCallTriggers()`, `updateCallTrigger()` to `src/lib/auth-api.ts`
- [ ] Create `src/components/settings/CallTriggerSettings.tsx` — three toggle cards
- [ ] Add `CallTriggerSettings` to `src/pages/SettingsPage.tsx` after Call Settings section
- [ ] Toggle `enabled` → immediate PATCH (no Save)
- [ ] `days_before` / `trigger_config` → Save button → PATCH
- [ ] `call_type` dropdown from `GET /agent-settings/call-types`

---

## 14. Scheduled Calls — View and Manage the Call Queue

> The call queue shows every outbound call created by the daily scheduler (or manually). Tenants can see what's pending, what fired, what failed, and cancel any pending call.

---

### 14.1 New TypeScript Type

Create `src/types/scheduled-call.ts`:

```typescript
export type ScheduledCallStatus =
  | 'pending'      // waiting to be fired by the dispatcher
  | 'in_progress'  // claimed by dispatcher, being placed now
  | 'completed'    // Retell call was successfully initiated
  | 'failed'       // exceeded max_attempts
  | 'cancelled';   // manually cancelled

export interface ScheduledCall {
  id: number;
  call_type: string;          // e.g. "customer_confirmation", "quotation_followup"
  phone_number: string;
  job_id: string | null;      // numeric string for platform jobs, "quotation_N" for quote-only
  job_date: string | null;    // ISO date
  customer_name: string | null;
  technician_name: string | null;
  customer_address: string | null;
  status: ScheduledCallStatus;
  scheduled_at: string;       // ISO datetime — when it will fire
  is_test: boolean;
  attempt_number: number;
  max_attempts: number;
  failure_reason: string | null;
  retell_call_id: string | null;  // set after dispatcher fires it
  created_at: string;
  updated_at: string;
  // Joined from jobs table (when job_id is a valid platform job):
  job_title: string | null;
  job_status: string | null;
}
```

---

### 14.2 New API Functions

Add to `src/lib/auth-api.ts`:

```typescript
export async function getScheduledCalls(
  token: string,
  params?: {
    status?: ScheduledCallStatus;
    call_type?: string;
    is_test?: boolean;         // default false — show production queue
    limit?: number;
    offset?: number;
  }
): Promise<{ scheduled_calls: ScheduledCall[] } | null>

export async function cancelScheduledCall(
  token: string,
  id: number
): Promise<{ success: boolean; message?: string; error?: string }>

export async function scheduleCall(
  token: string,
  body: {
    call_type: string;           // required — must exist in call_type_configs
    phone_number: string;         // required — E.164
    customer_name?: string;
    technician_name?: string;
    customer_address?: string;
    job_id?: string;
    job_date?: string;            // ISO date
    scheduled_at?: string;        // ISO datetime — snapped to office hours if outside
    max_attempts?: number;        // default 3
  }
): Promise<{
  success: boolean;
  scheduled_call?: ScheduledCall;
  scheduled_at?: string;          // actual fire time after office-hours snapping
  error?: string;
}>
```

---

### 14.3 Endpoint Reference

#### `GET /scheduled-calls` 🔒

**Query params:**

| Param | Values | Default |
|---|---|---|
| `status` | `pending` \| `in_progress` \| `completed` \| `failed` \| `cancelled` | — (all) |
| `call_type` | any call type slug | — (all) |
| `is_test` | `true` \| `false` | `false` |
| `limit` | max 200 | `50` |
| `offset` | integer | `0` |

Results ordered by `scheduled_at ASC` (soonest first).

```json
{
  "scheduled_calls": [
    {
      "id": 1,
      "call_type": "quotation_followup",
      "phone_number": "+14085551001",
      "job_id": "1",
      "job_date": null,
      "customer_name": "James Carter",
      "technician_name": null,
      "customer_address": null,
      "status": "pending",
      "scheduled_at": "2026-05-25T09:00:00Z",
      "is_test": false,
      "attempt_number": 1,
      "max_attempts": 3,
      "failure_reason": null,
      "retell_call_id": null,
      "created_at": "2026-05-25T06:00:00Z",
      "updated_at": "2026-05-25T06:00:00Z",
      "job_title": "Annual HVAC Inspection",
      "job_status": "scheduled"
    }
  ]
}
```

#### `POST /scheduled-calls` 🔒

Manually schedule an outbound call. `scheduled_at` is automatically snapped to the next office-hours window if omitted or outside business hours.

```json
// Request
{
  "call_type": "customer_confirmation",  // required — must exist in call_type_configs
  "phone_number": "+14085551001",         // required — E.164
  "customer_name": "James Carter",        // optional — injected as {{customer_name}}
  "technician_name": null,                // optional — injected as {{technician_name}}
  "customer_address": null,               // optional — injected as {{customer_address}}
  "job_id": "1",                          // optional — reference to a job
  "job_date": "2026-05-27",               // optional — injected as {{job_date}}
  "scheduled_at": "2026-05-26T10:00:00Z", // optional — snapped to next window if outside hours
  "max_attempts": 3                       // optional — default 3
}

// Response 201
{
  "scheduled_call": {
    "id": 4, "call_type": "customer_confirmation", "phone_number": "+14085551001",
    "status": "pending", "is_test": false, "attempt_number": 1, "max_attempts": 3,
    ...
  },
  "scheduled_at": "2026-05-26T09:00:00Z"  // actual fire time after office-hours snapping
}

// Response 400 — missing required field
{ "error": "phone_number is required" }

// Response 400 — unknown call type
{ "error": "call_type 'unknown' not found for this company" }
```

> `is_test` is always `false`. Use `POST /test/call` for test calls.  
> Office-hours snapping uses the company's `call_settings` (business hours + timezone).

---

#### `DELETE /scheduled-calls/:id` 🔒

Cancel a pending or in-progress call. Completed or already-cancelled calls return `404`.

```json
// Response 200
{ "message": "Scheduled call cancelled" }

// Response 404
{ "error": "Scheduled call not found or already completed/cancelled" }
```

---

### 14.4 Scheduler Manual Trigger Endpoints

These exist already and are used by the Testing panel + Vercel Cron:

```
POST /scheduler/daily   — runs the daily job: reads trigger configs → creates scheduled_calls rows
POST /scheduler/run     — runs the dispatcher: fires pending scheduled_calls via Retell
```

Both return:
```json
// /scheduler/daily
{ "ok": true, "created": 2, "skipped": 0 }

// /scheduler/run
{ "ok": true, "fired": 1, "skipped": 0, "failed": 0 }
```

---

### 14.5 New Page — Scheduled Calls Queue

Add a new page at `/scheduled-calls` inside `AuthGuard > DashboardLayout`.

**Sidebar entry:** Add between Calls and Todos:
```
Calls              /calls
Scheduled Calls    /scheduled-calls    ← ADD (icon: CalendarClock from lucide-react)
Todos              /todos
```

**Page layout:**

```
Scheduled Calls
──────────────────────────────────────────────────────────────────
  [Pending (2)] [In Progress] [Completed] [Failed] [Cancelled]
  [call_type ▼]   [Test / Production toggle]   [Run daily job] [Run dispatcher]

  ┌──────────────────────────────────────────────────────────────┐
  │ #  │ Call type          │ Customer       │ Phone       │ Job  │ Scheduled    │ Status  │ Attempts │ ✕ │
  │────┼────────────────────┼────────────────┼─────────────┼──────┼──────────────┼─────────┼──────────┼───│
  │ 2  │ Quotation Follow-up│ David Kim      │ +1408555... │ 5    │ Today 9:00am │ pending │ 1 / 3   │ ✕ │
  │ 1  │ Quotation Follow-up│ James Carter   │ +1408555... │ 1    │ Today 9:00am │ pending │ 1 / 3   │ ✕ │
  └──────────────────────────────────────────────────────────────┘
──────────────────────────────────────────────────────────────────
```

**Table columns:**

| Column | Field | Notes |
|---|---|---|
| Call Type | `call_type` | Badge with colour (see below) |
| Customer / Technician | `customer_name` or `technician_name` | depends on call type |
| Phone | `phone_number` | monospace |
| Job | `job_title` (or `job_id` if no title) | link to `/inspections` filtered by job |
| Scheduled | `scheduled_at` | "Today 9:00am", "Tomorrow", relative format |
| Status | `status` | colour-coded badge |
| Attempts | `attempt_number / max_attempts` | `1 / 3` |
| Cancel | ✕ button | only for `pending` status — `DELETE /scheduled-calls/:id` |

**Status badge colours:**

| Status | Colour |
|---|---|
| `pending` | blue |
| `in_progress` | amber |
| `completed` | emerald |
| `failed` | red |
| `cancelled` | gray |

**Call type badge colours:**

| Call type | Colour |
|---|---|
| `customer_confirmation` | blue |
| `technician_confirmation` | purple |
| `technician_reschedule` | orange |
| `quotation_followup` | teal |
| custom | gray |

**"Run daily job" button** → `POST /scheduler/daily` → toast showing `created` count → refetch list

**"Run dispatcher" button** → `POST /scheduler/run` → toast showing `fired` count → refetch list

**Auto-refresh:** Poll `GET /scheduled-calls` every 30 seconds when `in_progress` calls exist.

---

### 14.6 Naming Note — `technician_scheduled` vs `technician_unconfirmed`

The frontend agent's `BACKEND_CHANGES.md` refers to a trigger called `technician_unconfirmed`. The backend uses `technician_scheduled` — same logic, different name. Use `technician_scheduled` everywhere in the frontend.

```typescript
// Correct
updateCallTrigger(token, 'technician_scheduled', { enabled: true })

// Wrong — this type does not exist
updateCallTrigger(token, 'technician_unconfirmed', { enabled: true })  // ← 400 error
```

---

### 14.7 What Was Already Implemented (no action needed)

The frontend agent's `BACKEND_CHANGES.md` listed several items as "missing". All have been implemented:

| Item | Status |
|---|---|
| `GET /scheduled-calls` | ✅ Done |
| `POST /scheduled-calls` | ✅ Done (added now) |
| `DELETE /scheduled-calls/:id` | ✅ Done |
| `quotation_followup` call type seeded | ✅ Done |
| Scheduler `quotation_pending` logic | ✅ Done |
| Scheduler `open_job_due_soon` logic | ✅ Done |
| Scheduler `technician_scheduled` logic | ✅ Done |
| 4 call trigger types seeded per company | ✅ Done |

---

### 14.8 Checklist

- [x] Add `/scheduled-calls` route to `src/App.tsx` ✅ Done by frontend
- [x] Add `CalendarClock` + "Scheduled Calls" nav item to `src/components/layout/Sidebar.tsx` ✅ Done by frontend
- [ ] Create `src/types/scheduled-call.ts` — `ScheduledCall`, `ScheduledCallStatus`
- [ ] Add `getScheduledCalls()`, `cancelScheduledCall()`, `scheduleCall()` to `src/lib/auth-api.ts`
- [ ] Create `src/pages/ScheduledCallsPage.tsx` — status tabs, call_type filter, test/production toggle
- [ ] Create `src/components/scheduled-calls/ScheduledCallsTable.tsx` — columns as above, cancel button for pending rows
- [ ] "Schedule call" button → `POST /scheduled-calls` → refetch
- [ ] "Run daily job" button → `POST /scheduler/daily` → refetch
- [ ] "Run dispatcher" button → `POST /scheduler/run` → refetch
- [ ] Auto-refresh every 30s when `in_progress` rows exist
- [ ] Use `technician_scheduled` (not `technician_unconfirmed`) for the 4th trigger type

---

## 15. Post-Call Analysis — Configurable Outcome Priorities

> Each company can configure which post-call outcomes create a todo and what priority level (high / medium / low) to assign. Outcomes can also be disabled entirely — if disabled, no todo is created for that outcome.

---

### 15.1 Outcome Types

| `todo_type` | Trigger condition | Default priority | Default enabled |
|---|---|---|---|
| `ASKED_FOR_RESCHEDULE` | Customer asked to reschedule the appointment | `high` | ✅ |
| `ASKED_FOR_CANCELLATION` | Customer asked to cancel the job or appointment | `high` | ✅ |
| `NOT_PICKED` | Customer did not pick up the call | `medium` | ✅ |
| `VOICEMAIL` | Call reached voicemail | `medium` | ✅ |
| `UNCONFIRMED` | Customer did not confirm the job or appointment | `medium` | ✅ |

---

### 15.2 New TypeScript Type

Add to `src/types/todo.ts`:

```typescript
export type CallAnalysisPriority = 'high' | 'medium' | 'low';

export interface CallAnalysisConfig {
  todo_type: TodoType;
  priority: CallAnalysisPriority;
  enabled: boolean;
  description: string | null;
  updated_at: string;
}
```

---

### 15.3 New API Functions

Add to `src/lib/auth-api.ts`:

```typescript
// GET /call-analysis-configs
export async function getCallAnalysisConfigs(token: string):
  Promise<{ call_analysis_configs: CallAnalysisConfig[] } | null>

// PATCH /call-analysis-configs/:type
export async function updateCallAnalysisConfig(
  token: string,
  todoType: TodoType,
  body: { priority?: CallAnalysisPriority; enabled?: boolean }
): Promise<{ call_analysis_config: CallAnalysisConfig } | null>
```

---

### 15.4 Endpoint Reference

#### `GET /call-analysis-configs` 🔒

Always returns all 5 outcome configs ordered by severity.

```json
{
  "call_analysis_configs": [
    {
      "todo_type": "ASKED_FOR_RESCHEDULE",
      "priority": "high",
      "enabled": true,
      "description": "Customer asked to reschedule the appointment.",
      "updated_at": "2026-05-27T10:00:00Z"
    },
    {
      "todo_type": "ASKED_FOR_CANCELLATION",
      "priority": "high",
      "enabled": true,
      "description": "Customer asked to cancel the job or appointment.",
      "updated_at": "2026-05-27T10:00:00Z"
    },
    {
      "todo_type": "NOT_PICKED",
      "priority": "medium",
      "enabled": true,
      "description": "Customer did not pick up the call.",
      "updated_at": "2026-05-27T10:00:00Z"
    },
    {
      "todo_type": "VOICEMAIL",
      "priority": "medium",
      "enabled": true,
      "description": "Call reached voicemail.",
      "updated_at": "2026-05-27T10:00:00Z"
    },
    {
      "todo_type": "UNCONFIRMED",
      "priority": "medium",
      "enabled": true,
      "description": "Customer did not confirm the job or appointment.",
      "updated_at": "2026-05-27T10:00:00Z"
    }
  ]
}
```

#### `PATCH /call-analysis-configs/:type` 🔒

`:type` must be one of the 5 todo types above.

```json
// Change priority only
{ "priority": "low" }

// Disable — no todo will be created for this outcome
{ "enabled": false }

// Both at once
{ "priority": "high", "enabled": true }

// Response 200
{ "call_analysis_config": { "todo_type": "NOT_PICKED", "priority": "low", "enabled": true, ... } }

// Response 400 — invalid type
{ "error": "Invalid todo_type: UNKNOWN" }

// Response 400 — invalid priority
{ "error": "priority must be 'high', 'medium', or 'low'" }
```

---

### 15.5 Settings Page — Post-Call Analysis Section

Add a **"Post-Call Analysis"** section to the Settings page (after Call Triggers).

```
Post-Call Analysis
──────────────────────────────────────────────────────────────────
  Configure which call outcomes create action items and
  what priority level to assign them.

  ┌────────────────────────────────────────────────────────────┐
  │ [● Enabled]  Customer asked to reschedule     [High   ▼]  │
  │ Creates a high-priority todo when customer requests        │
  │ a different appointment time.                              │
  └────────────────────────────────────────────────────────────┘

  ┌────────────────────────────────────────────────────────────┐
  │ [● Enabled]  Customer asked to cancel         [High   ▼]  │
  │ Creates a high-priority todo when customer wants           │
  │ to cancel the job or appointment.                          │
  └────────────────────────────────────────────────────────────┘

  ┌────────────────────────────────────────────────────────────┐
  │ [● Enabled]  Call not answered                [Medium ▼]  │
  │ Creates a todo when customer does not pick up.             │
  └────────────────────────────────────────────────────────────┘

  ┌────────────────────────────────────────────────────────────┐
  │ [● Enabled]  Voicemail reached                [Medium ▼]  │
  │ Creates a todo when the call goes to voicemail.            │
  └────────────────────────────────────────────────────────────┘

  ┌────────────────────────────────────────────────────────────┐
  │ [● Enabled]  Job/appointment unconfirmed      [Medium ▼]  │
  │ Creates a todo when customer does not confirm.             │
  └────────────────────────────────────────────────────────────┘
──────────────────────────────────────────────────────────────────
```

**UX behaviour:**
- Toggle `enabled` → immediate `PATCH` (no Save needed)
- Priority dropdown change → immediate `PATCH`
- When `enabled = false` → card is greyed out; no todo will be created for this outcome
- Priority badge colours: `high` = red, `medium` = amber, `low` = gray

---

### 15.6 Checklist

- [ ] Add `CallAnalysisConfig`, `CallAnalysisPriority` to `src/types/todo.ts`
- [ ] Add `getCallAnalysisConfigs()`, `updateCallAnalysisConfig()` to `src/lib/auth-api.ts`
- [ ] Create `src/components/settings/CallAnalysisSettings.tsx` — 5 toggle+priority cards
- [ ] Add `CallAnalysisSettings` to `src/pages/SettingsPage.tsx` after Call Triggers section
- [ ] Toggle `enabled` → immediate PATCH
- [ ] Priority dropdown → immediate PATCH
- [ ] Disabled cards are visually muted

---

## 16. Environment-Aware UI — Development vs Production

> The backend behaves differently based on `NODE_ENV`. The frontend must detect the environment and adapt its UI, labels, and defaults so that developers get a fast feedback loop while production shows correct real-world behaviour.

---

### 16.1 How to Detect the Environment

#### `GET /health` — no auth required

```json
{
  "status": "healthy",
  "database": "connected",
  "timestamp": "2026-05-28T14:00:00Z",
  "environment": "development"
}
```

`environment` is either `"development"` or `"production"`.

**Recommended:** call this once on app startup and store `environment` in a global context/store. Do not rely on `VITE_NODE_ENV` — the backend is the source of truth.

```typescript
// src/lib/auth-api.ts
export async function getHealthStatus():
  Promise<{ status: string; environment: 'development' | 'production' } | null>
```

---

### 16.2 Behaviour Differences Per Environment

| Feature | Development | Production |
|---|---|---|
| `POST /scheduler/daily` — date matching | Matches **any upcoming** job (no date restriction) | Exact `today + days_before` date match only |
| `POST /scheduler/daily` — `scheduled_at` | `NOW()` — calls are due immediately | Business-hours window (e.g. tomorrow 9:00 AM) |
| `POST /scheduler/daily` — `is_test` on rows | `true` | `false` |
| `POST /scheduler/daily` — dedup | Blocks only `pending`/`in_progress` — allows re-test after completion | Blocks `pending`/`in_progress`/`completed` — one real call per job |
| `POST /scheduler/run` — office hours | **Skipped** — fires any time of day | Enforced — reschedules if outside 09:00–17:00 |
| Scheduled calls `is_test` default filter | `true` | `false` |

---

### 16.3 TypeScript Type

Add to `src/types/app.ts` (new file):

```typescript
export type AppEnvironment = 'development' | 'production';

export interface HealthStatus {
  status: 'healthy' | 'unhealthy';
  database: 'connected' | 'disconnected';
  timestamp: string;
  environment: AppEnvironment;
}
```

---

### 16.4 Environment Context

Create `src/contexts/EnvironmentContext.tsx`:

```typescript
import { createContext, useContext, useEffect, useState } from 'react';
import type { AppEnvironment } from '@/types/app';
import { getHealthStatus } from '@/lib/auth-api';

interface EnvironmentContextValue {
  environment: AppEnvironment;
  isDev: boolean;
}

const EnvironmentContext = createContext<EnvironmentContextValue>({
  environment: 'production',
  isDev: false,
});

export function EnvironmentProvider({ children }: { children: React.ReactNode }) {
  const [environment, setEnvironment] = useState<AppEnvironment>('production');

  useEffect(() => {
    getHealthStatus().then(h => {
      if (h?.environment) setEnvironment(h.environment);
    });
  }, []);

  return (
    <EnvironmentContext.Provider value={{ environment, isDev: environment === 'development' }}>
      {children}
    </EnvironmentContext.Provider>
  );
}

export const useEnvironment = () => useContext(EnvironmentContext);
```

Wrap `App.tsx` with `<EnvironmentProvider>` outside `AuthGuard`.

---

### 16.5 Component Changes

#### Development Mode Banner

Show a non-dismissable banner at the top of every page when `isDev = true`:

```
┌─────────────────────────────────────────────────────────────────┐
│  ⚠️  Development mode — calls fire immediately, marked as test  │
└─────────────────────────────────────────────────────────────────┘
```

```tsx
// src/components/layout/DevModeBanner.tsx
import { useEnvironment } from '@/contexts/EnvironmentContext';

export function DevModeBanner() {
  const { isDev } = useEnvironment();
  if (!isDev) return null;
  return (
    <div className="bg-amber-50 border-b border-amber-200 px-4 py-2 text-sm text-amber-800 flex items-center gap-2">
      <span>⚠️</span>
      <span>Development mode — calls fire immediately and are marked as test calls</span>
    </div>
  );
}
```

Add `<DevModeBanner />` at the top of `DashboardLayout` (inside the layout, above page content).

---

#### Scheduled Calls Page — default `is_test` filter

```typescript
const { isDev } = useEnvironment();

// Default the is_test toggle to match the environment
const [showTestCalls, setShowTestCalls] = useState(isDev);
```

In dev, the page opens on test calls by default (since all dev-scheduled calls are `is_test=true`). In prod, it defaults to production calls.

---

#### "Schedule Calls" Button — label and description

```tsx
const { isDev } = useEnvironment();

<Button onClick={handleScheduleDaily}>
  Schedule Calls
</Button>
<p className="text-xs text-muted-foreground mt-1">
  {isDev
    ? 'Dev mode: queues calls immediately for all upcoming jobs (is_test=true)'
    : 'Schedules calls at next business-hours window for jobs due in the configured days'}
</p>
```

---

#### Scheduler Section in Testing Panel

```
Testing Panel
─────────────────────────────────────────────────────────────────
  Scheduler
  ─────────────────────────────────────────────────────────────────
  [Schedule Calls]    [Run Dispatcher]

  Development mode:
  ┌──────────────────────────────────────────────────────────────┐
  │ Schedule Calls → queues ALL upcoming jobs immediately        │
  │ Run Dispatcher → fires immediately (no office-hours check)   │
  └──────────────────────────────────────────────────────────────┘

  Production mode:
  ┌──────────────────────────────────────────────────────────────┐
  │ Schedule Calls → queues jobs at next business-hours window   │
  │ Run Dispatcher → fires only during business hours            │
  └──────────────────────────────────────────────────────────────┘
```

---

#### Placeholder Reference Update — Section 5.6

Add `{{current_date}}` and `{{current_time}}` to the placeholder reference table:

| Placeholder | Available in | Resolved to |
|---|---|---|
| `{{current_date}}` | All types | e.g. `"Wednesday, May 28, 2026"` in company timezone |
| `{{current_time}}` | All types | e.g. `"02:45 PM"` in company timezone |
| `{{company_name}}` `{{representative_name}}` `{{job_date}}` `{{job_id}}` | All types | — |
| `{{customer_name}}` | `customer_confirmation` + custom | — |
| `{{technician_name}}` `{{customer_address}}` | `technician_confirmation`, `technician_reschedule` | — |
| `{{job_name}}` `{{job_description}}` `{{job_type}}` | All types | From jobs table |
| `{{appointment_id}}` | `customer_confirmation`, `technician_confirmation` | From scheduled_calls |
| `{{total_amount}}` | `quotation_followup` | Quote total |

These are injected by the dispatcher when the call fires — not at scheduling time.

---

#### Todo Types — Section 5.8 Update

`APPOINTMENT_NEEDED` is now a valid todo type (added alongside the existing 5):

```typescript
export type TodoType =
  | 'NOT_PICKED'
  | 'VOICEMAIL'
  | 'ASKED_FOR_RESCHEDULE'
  | 'ASKED_FOR_CANCELLATION'
  | 'UNCONFIRMED'
  | 'APPOINTMENT_NEEDED';    // ← NEW: no active appointment, customer had no time preference
```

| Type | Trigger | Default priority |
|---|---|---|
| `APPOINTMENT_NEEDED` | Customer confirmation call: no active appointment and customer gave no preferred time | `high` |

Badge colour: `APPOINTMENT_NEEDED` = **indigo**

Also add to the `GET /todos` type filter param and the `call_analysis_configs` priority/enable settings (Section 15).

---

### 16.6 `GET /health` — New Endpoint

#### `GET /health` — no auth

```json
{
  "status": "healthy",
  "database": "connected",
  "timestamp": "2026-05-28T14:00:00Z",
  "environment": "development"
}
```

```typescript
export async function getHealthStatus(): Promise<HealthStatus | null> {
  const res = await fetch(`${API_BASE}/health`);
  if (!res.ok) return null;
  return res.json().catch(() => null);
}
```

---

### 16.7 Checklist

- [ ] Add `HealthStatus`, `AppEnvironment` to `src/types/app.ts`
- [ ] Add `getHealthStatus()` to `src/lib/auth-api.ts`
- [ ] Create `src/contexts/EnvironmentContext.tsx` — `EnvironmentProvider`, `useEnvironment`
- [ ] Wrap `App.tsx` with `<EnvironmentProvider>`
- [ ] Create `src/components/layout/DevModeBanner.tsx` — amber banner shown in dev only
- [ ] Add `<DevModeBanner />` to `DashboardLayout`
- [ ] `ScheduledCallsPage` — default `is_test` toggle to `isDev`
- [ ] "Schedule Calls" button — show dev/prod description text below button
- [ ] Testing panel — show scheduler behaviour description based on `isDev`
- [ ] Update placeholder reference table — add `{{current_date}}`, `{{current_time}}`, `{{job_name}}`, `{{appointment_id}}`, `{{total_amount}}`
- [ ] Update `TodoType` — add `APPOINTMENT_NEEDED`
- [ ] Update `CallAnalysisConfig` type — add `APPOINTMENT_NEEDED` to the 5 outcome types
- [ ] Add `APPOINTMENT_NEEDED` todo type badge (indigo) to Todos page

---

## Implementation Status

| Section | Status |
|---|---|
| Todos page (`TodosPage`, `TodosTable`, `TodoDetailSheet`) | ✅ Done |
| Calls page (real data, `CallsTable`, `CallDetailView` updated) | ✅ Done |
| Types (`call.ts`, `todo.ts`, `customer.ts`) | ✅ Done |
| Customers page migration (ServiceTrade → platform table) | 🔲 Pending |
| Jobs page migration (mock → real API) | 🔲 Pending |
| Bug fixes 1–7 in Section 10 | 🔲 Some done, verify remaining |