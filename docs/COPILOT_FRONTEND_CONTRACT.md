# Copilot Frontend Integration Contract

This is the **authoritative wire-protocol contract** between the frontend copilot widget
(bottom-right embedded assistant) and the backend copilot API. Keep this in sync with the
backend: `src/routes/copilot.js`, `src/copilot/*`, and the shared SSE transport in
`src/engines/core/{sse,token,broker,engine}.js`.

> **v1 capabilities.** LangGraph agent with OpenAI→Groq failover. Answers analytical/data
> questions, fuzzy-matches customer names ("did you mean …?"), and performs **write actions**
> (update to-dos / agent config / call settings / call triggers, place or schedule calls, run the
> scheduler) — every write requires explicit in-UI confirmation before it is applied. That
> confirmation is the only gate on copilot actions; the `agent_can_make_changes` call-setting
> applies to the **voice agent on a live call**, not to the copilot. Multi-turn memory is
> server-side.

---

## 1. Concepts

| Term | Meaning |
|------|---------|
| **Conversation** | A chat thread. Has a numeric `id` (used in URLs) and an opaque `thread_id`. History is stored server-side; the client never resends prior messages. |
| **Turn** | One streamed request/response. Started by sending a message OR by confirming/rejecting a pending action. Each turn has its own `runId` and SSE stream. |
| **Pending action** | A proposed write the agent wants to make. The graph is paused until the user confirms or rejects. Expires 30 minutes after it is proposed. |

### Auth
- **Control endpoints** (everything except the stream): `Authorization: Bearer <JWT>` — the same
  platform token. All data is scoped to the user's company server-side; the client never sends a
  company id.
- **SSE stream**: browser `EventSource` cannot send headers, so the POST that starts a turn
  returns a short-lived **signed `streamToken`** bound to `(runId, companyId)`. It is already
  embedded in the returned `streamUrl` as `?token=...`. TTL = 30 min.

### Base URL
All paths below are relative to the API base (same host the rest of the app calls). `streamUrl`
is returned as a root-relative path (e.g. `/copilot/runs/987/stream?token=...`) — prepend your API
base when constructing the `EventSource`.

---

## 2. REST API

### 2.1 Create a conversation
```
POST /copilot/conversations
Authorization: Bearer <JWT>
Content-Type: application/json
{ "title": "optional string" }
```
**201**
```json
{ "id": "12", "thread_id": "cplt_9f1c…", "title": null }
```

### 2.2 List conversations
```
GET /copilot/conversations?limit=30
```
**200**
```json
{ "conversations": [
  { "id": "12", "thread_id": "cplt_…", "title": "How many unconfirmed…", "created_at": "…", "updated_at": "…" }
] }
```

### 2.3 Get conversation history
```
GET /copilot/conversations/:id
```
**200**
```json
{
  "id": "12",
  "thread_id": "cplt_…",
  "title": "…",
  "messages": [
    { "role": "user", "content": "How many customers have unconfirmed jobs?" },
    { "role": "assistant", "content": "", "tool_calls": [ { "name": "count_unconfirmed_jobs", "args": {} } ] },
    { "role": "tool", "content": "{\"unconfirmed_jobs\":0,\"customers_with_unconfirmed_jobs\":0}" },
    { "role": "assistant", "content": "0 customers have unconfirmed jobs." }
  ]
}
```
`role` is `user | assistant | tool`. `tool_calls` is present only on assistant messages that
invoked tools. Use this to rehydrate the thread when the widget (re)opens. **404** if the
conversation doesn't exist / belongs to another company.

### 2.4 Send a message → start a turn
```
POST /copilot/conversations/:id/messages
{ "message": "How many appointments are unconfirmed for John Smith?" }
```
`message` is required, max **4000** chars.
**201**
```json
{
  "runId": "987",
  "streamToken": "<signed>",
  "streamUrl": "/copilot/runs/987/stream?token=%3Csigned%3E"
}
```
Then open `new EventSource(API_BASE + streamUrl)` to receive the response. Errors: **400**
(missing/too-long message), **404** (unknown conversation).

### 2.5 Confirm / reject a pending write action
```
POST /copilot/conversations/:id/confirm
{ "pendingActionId": "55", "decision": "confirm" }   // or "reject"
```
**201** → same shape as 2.4 (`runId`, `streamToken`, `streamUrl`) — a **new turn** that applies
(or cancels) the action and streams the assistant's acknowledgement.
Errors: **400** (missing `pendingActionId`), **404** (unknown/foreign action), **409** (already
resolved, or a newer proposal supersedes it), **410** (expired).

### 2.6 SSE stream for a turn
```
GET /copilot/runs/:runId/stream?token=<streamToken>
```
`Content-Type: text/event-stream`. Not behind JWT (uses the signed token). Errors: **401**
(missing/expired/invalid token), **403** (token/runId mismatch). See §3 for the event protocol.

---

## 3. SSE streaming protocol

### 3.1 Frame format
Standard SSE. Each frame is:
```
id: <seq>            ← present only for persisted (milestone) events; absent for token frames
event: <type>
data: <json>

```
A `: ping` comment is sent every 15s as a heartbeat (ignore it — `EventSource` does). The socket
closes after the terminal `done`/`failed` event.

**`EventSource` requires `addEventListener("<type>", …)` per event type** — because every frame
sets an `event:` name, the default `onmessage` handler will **not** fire. Always attach listeners
for the types in §3.3 (at minimum `token`, `message`, `tool_call`, `tool_result`, `propose`,
`done`, `failed`). See §3.7 for how `token`/`message`/`tool_*` form the four render channels.

### 3.2 Event envelope
All events **emitted by the agent** (everything except `token`) carry an envelope: their `data`
includes `state` (usually `null` for copilot — ignore it) and `ts` (ISO timestamp), merged with
the event's own fields. `token` frames are lightweight: `data` is just `{ "text": "…" }` with no
`id`, `state`, or `ts`.

> ⚠️ **The terminal `done` event nests its result.** `data` is
> `{ "state": "done", "ts": "…", "result": { … } }`. Read the final answer from
> **`data.result.text`**, not `data.text`.

### 3.3 Event types

| `event` | `data` (after JSON.parse) | Meaning / UI action |
|---|---|---|
| `snapshot` | `{ id, kind, current_state, status, last_event_seq, started_at }` | First frame on connect. `status` is `running` or terminal. |
| `started` | `{ state, ts, kind, companyId, startedAt }` | Turn began. |
| `provider` | `{ state, ts, provider: "openai" }` | Which LLM answered (primary). |
| `provider_switch` | `{ state, ts, from: "openai", to: "groq" }` | Failover occurred. |
| `token` | `{ text, message_id }` | **High frequency.** A live text delta. Append `text` to the bubble grouped by `message_id`. The bubble's *channel* (reasoning vs answer) arrives on the matching `message` event — see §3.7. |
| `message` | `{ state, ts, message_id, channel, text }` | A completed assistant generation. `channel` is **`"reasoning"`** (intermediate thinking — this generation also made tool calls) or **`"answer"`** (the final reply). `text` is the authoritative full text for that `message_id`. |
| `tool_call` | `{ state, ts, tool_call_id, name, args }` | Agent invoked a tool — render as a tool-activity chip ("Looking up…"). Pair with its result via `tool_call_id`. |
| `tool_result` | `{ state, ts, tool_call_id, name, result }` | That tool's response/data (the "tool/API response"). **`result` is structured JSON you can render as cards/tables/props** (see §3.6). Not truncated. Paired to its `tool_call` by `tool_call_id`. |
| `propose` | `{ state, ts, pendingActionId, tool_name, preview, args, expires_at }` | A write awaits confirmation — render a Confirm/Reject card from `preview`. |
| `awaiting_confirmation` | `{ state, ts, pendingActionId }` | Turn parked; stream then closes. |
| `done` | `{ state: "done", ts, result: { status, text?, pendingActionId? } }` | **Terminal.** `result.status` is `"done"` (final answer in `result.text`) or `"awaiting_confirmation"` (a write was proposed; `result.pendingActionId` set). |
| `failed` | `{ state: "failed", ts, error, partialResult }` | **Terminal** error. |

`result.status` on `done`:
- `"done"` → a normal answer; `result.text` is the full assistant message.
- `"awaiting_confirmation"` → the turn ended because a write was proposed (you already received the
  `propose` event); `result.pendingActionId` echoes it.

### 3.4 `preview` shapes (render the confirmation card from these)
- `set_todo_status`:
  `{ "entity": "todo", "todo_id": 33, "todo_type": "ASKED_FOR_RESCHEDULE", "from_status": "open", "to_status": "in_progress", "notes": null }`
- `update_agent_config` / `update_call_settings`:
  `{ "entity": "agent_config" | "call_settings", "changes": [ { "field": "representative_name", "from": "Alex", "to": "Sam" } ] }`
- `make_call` (place a call now):
  `{ "entity": "call", "mode": "now", "trigger_type": "scheduled_unconfirmed", "target_field": "appointment_id", "target_id": 42, "customer": "John Smith", "phone": "+1555…", "job_title": "AC tune-up", "scheduled_start": "…", "force": false }`
- `schedule_call` (call later):
  `{ "entity": "call", "mode": "scheduled", "trigger_type": "open_job_due_soon", "scheduled_for": "2026-06-16T14:00:00.000Z", "timezone": "America/New_York", "target_field": "job_id", "target_id": 7, "customer": "John Smith", "phone": "+1555…", "force": false }`
- `run_scheduler` (queue all eligible calls):
  `{ "entity": "scheduler_run", "enabled_triggers": [ { "trigger_type": "scheduled_unconfirmed", "call_type": "customer_confirmation", "days_before": 2 } ], "note": "…" }`
- `set_call_trigger_enabled` (toggle a trigger):
  `{ "entity": "call_trigger", "trigger_type": "scheduled_unconfirmed", "call_type": "customer_confirmation", "from_enabled": false, "to_enabled": true }`

Render generically off `entity` + the before/after fields (config/settings/trigger), the call
summary (`entity:"call"` → who/when), or the trigger list (`entity:"scheduler_run"`). New write
tools need no FE change.

### 3.5 Raw example (a read turn)
```
event: snapshot
data: {"id":987,"kind":"copilot_turn","current_state":null,"status":"running","last_event_seq":1,"started_at":"2026-06-15T18:20:00.000Z"}

id: 1
event: started
data: {"state":null,"ts":"2026-06-15T18:20:00.001Z","kind":"copilot_turn","companyId":4,"startedAt":"2026-06-15T18:20:00.000Z"}

id: 2
event: provider
data: {"state":null,"ts":"…","provider":"openai"}

id: 3
event: tool_call
data: {"state":null,"ts":"…","tool_call_id":"run-abc","name":"count_unconfirmed_jobs","args":{}}

id: 4
event: tool_result
data: {"state":null,"ts":"…","tool_call_id":"run-abc","name":"count_unconfirmed_jobs","result":{"unconfirmed_jobs":0,"customers_with_unconfirmed_jobs":0}}

event: token
data: {"text":"0 customers ","message_id":"run-def"}

event: token
data: {"text":"have unconfirmed jobs.","message_id":"run-def"}

id: 5
event: message
data: {"state":null,"ts":"…","message_id":"run-def","channel":"answer","text":"0 customers have unconfirmed jobs."}

id: 6
event: done
data: {"state":"done","ts":"…","result":{"status":"done","text":"0 customers have unconfirmed jobs."}}
```

---

## 3.6 Rendering responses (Markdown + cards)

Two complementary channels make up the answer; render both:

1. **Assistant text (`token` stream → `done.result.text`)** — the conversational reply. It is
   **Markdown** (bold, bullets, tables, links). Render it through a Markdown renderer, not as
   plain text. For list questions the agent keeps the text short (a framing sentence) and relies
   on the cards below for the detail — so don't expect it to enumerate every item.

2. **Structured tool results (`tool_result.result`)** — the underlying data, as JSON. Use this to
   render **cards / props / tables** for the user. The backend does **not** truncate these, so the
   full list is available client-side.

### How to render structured results
- Switch on `tool_result.name` to pick a renderer; fall back to a generic key/value or JSON
  table for unknown tools so new server-side tools degrade gracefully.
- **Large lists:** when a result holds many items (e.g. `list_voices` can return dozens), pick a
  space-appropriate, scannable UI — a **scrollable / collapsible container, a searchable
  dropdown, or a paginated table** — rather than dumping everything inline. Keep the chat compact;
  let the user expand.
- Pair actionable cards with the relevant follow-up. E.g. a voice in the `list_voices` card can
  have a "Use this voice" button that sends a message like *"Set the agent voice to <voice_id>"*,
  which then triggers the propose→confirm flow (§4.3).

### Structured shapes returned by the list/detail tools
These are the `result` payloads on `tool_result` (and the JSON a `tool` message holds in history):

| `name` | `result` shape (abridged) |
|---|---|
| `list_voices` | `{ count, voices: [ { voice_id, name, provider, gender, accent, age, preview_audio_url } ] }` |
| `list_calls` | `{ count, calls: [ { id, created_at, customer, to_number, call_type, status, appointment_confirmed, user_sentiment, duration_ms, summary } ] }` |
| `get_call` | `{ status, call: { …, call_summary, user_sentiment, appointment_confirmed, transcript, customer } }` |
| `list_jobs` | `{ count, jobs: [ { id, title, status, job_type, scheduled_date, customer, technician } ] }` |
| `list_open_todos` | `{ count, todos: [ { id, type, status, priority, customer, job_id, notes, created_at } ] }` |
| `get_customer` | `{ status, customer: { …, jobs: [...], quotations: [...] } }` |
| `find_call_targets` | `{ status, customer, enabled_triggers: [...], targets: [ { trigger_type, call_type, enabled, reference_field, reference_id, summary } ], disabled_but_matched: [...] }` — **UPCOMING targets only by default** (past-due appointments/jobs and expired quotes are excluded; the agent can pass `include_past:true` on request). Render `targets` as a **pick-one list** (each becomes a "Call this" action → `make_call`/`schedule_call`); an empty `targets` means there are no upcoming calls for this customer. |
| `get_agent_config` | `{ representative_name, voice_id, subagent_count }` |
| `get_call_settings` | `{ business_hours_start, business_hours_end, max_attempts, agent_can_make_changes, auto_schedule_enabled, auto_dispatch_enabled, … }` |
| `find_customer` | `{ status: "resolved"|"ambiguous"|"not_found", candidates: [ { id, name, phone, email, score } ] }` |
| `count_unconfirmed_jobs` | `{ unconfirmed_jobs, customers_with_unconfirmed_jobs }` |
| `count_unconfirmed_appointments_for_customer` | `{ status, customer, unconfirmed_count, appointments: [...] }` |
| `analytics_summary` | `{ period, calls:{…}, jobs:{…}, todos:{…}, queue:{…}, quotations:{…}, customers:{…} }` |

> The list above will grow as tools are added server-side. Treat it as advisory and always keep a
> generic JSON renderer as the fallback so the widget never breaks on an unknown `name`.

---

## 3.7 Response channels — render each kind of output differently

A single turn produces **four distinct kinds of output**. They must NOT all be rendered as one
plain text stream — style them differently:

| Channel | Comes from | Suggested rendering |
|---|---|---|
| **Reasoning** (intermediate "thinking") | `token` deltas grouped by `message_id`, then a `message` with `channel:"reasoning"` | A muted / collapsible "Thinking…" block. Optional to show; safe to collapse or hide. |
| **Tool call** (the agent is doing something) | `tool_call` | A small activity chip: "🔧 Looking up voices…". Pair with its result by `tool_call_id`. |
| **Tool / API response** (the data) | `tool_result` | A **card / table** built from `result` (see §3.6). Often shown inside/next to the tool chip; can be collapsed. |
| **Final answer** | `token` deltas grouped by `message_id`, then a `message` with `channel:"answer"` (and echoed in `done.result.text`) | The primary assistant bubble, rendered as **Markdown**. |

### How to drive this from the stream
1. On each `token`, append `text` to a bubble keyed by `message_id`. You don't yet know its
   channel — render it provisionally (e.g. as streaming answer text, or a neutral style).
2. When the `message` event for that `message_id` arrives, you now know the channel:
   - `channel:"reasoning"` → restyle that bubble as a collapsible "thinking" block (or hide it).
   - `channel:"answer"` → keep it as the main answer bubble; `message.text` is authoritative.
3. `tool_call` / `tool_result` interleave between messages — render them as their own
   activity/card elements, not as text in a bubble. Match a result to its call via `tool_call_id`.
4. The terminal `done.result.text` always equals the final **answer** text — use it to finalize the
   answer bubble (and as the fallback if you didn't track messages, e.g. after a reconnect).

Typical event order for a tool-using turn:
```
provider
token(msg=A) …            ← optional preamble ("Let me check…")
message(msg=A, reasoning) ← A was thinking; collapse it
tool_call(id=T1, list_voices)
tool_result(id=T1, {voices:[…]})   ← render as a card
token(msg=B) …            ← the actual answer, streaming
message(msg=B, answer)    ← finalize the answer bubble
done(result.text = answer)
```
> Many turns have no reasoning text at all (the model calls a tool immediately, then answers) —
> in that case you'll just see `tool_call`/`tool_result` then an `answer` message.

---

## 4. UX flows

### 4.1 Plain Q&A
1. `POST …/messages` → get `streamUrl`.
2. Open `EventSource`; on each `token`, append `data.text` to the bubble for its `message_id`.
3. On the `answer` `message`, finalize that bubble (Markdown); render any `reasoning` message as a
   collapsed "thinking" block and `tool_call`/`tool_result` as activity/cards (§3.7).
4. On `done`, the answer bubble is authoritative via `data.result.text`; close the stream.

### 4.2 Fuzzy customer disambiguation
No special protocol. The agent streams a normal question — *"Did you mean **John Smith**
(555-0100)?"*. The user replies with another message (`POST …/messages`).

### 4.3 Write action (propose → confirm)
```
FE                                  BE
│ POST …/messages                   │
│ ──────────────────────────────────▶ start turn
│ ◀────────────────────────────────── 201 {runId, streamUrl}
│ EventSource(streamUrl)             │
│ ◀═ token … (agent explains)        │
│ ◀═ propose {pendingActionId,preview}│   ← DB NOT changed yet
│ ◀═ awaiting_confirmation            │
│ ◀═ done {result.status:"awaiting_confirmation"}  → stream closes
│ [render Confirm / Reject card]     │
│ POST …/confirm {pendingActionId, decision}        │
│ ──────────────────────────────────▶ resume graph → apply (or cancel) mutation
│ ◀────────────────────────────────── 201 {runId, streamUrl}
│ EventSource(streamUrl)             │
│ ◀═ token … done {result.text}      │   ← "Done — to-do 33 is now in_progress."
```
Only **one** pending action per conversation at a time — always confirm the `pendingActionId`
from the most recent `propose`.

---

## 5. Reconnect, lifecycle & edge cases

- **Late connect is safe.** Milestone events (`started`, `provider*`, `tool_call`, `tool_result`,
  `propose`, `awaiting_confirmation`, `done`, `failed`) are **persisted**. If you open the stream
  after the turn already finished, you still receive the snapshot + a full replay of those events
  ending in `done`/`failed`. Only `token` frames are ephemeral.
- **Reconnect (`EventSource` auto-retry).** It resends `Last-Event-ID` (the last `id:` seen — i.e.
  the last milestone seq, since tokens have no id). The server replays persisted events with
  `seq > Last-Event-ID`, then live-tails. **Practical rule:** on reconnect, discard the partial
  streaming bubble and rely on `done.result.text` for the final message; tool/propose state is
  restored from replay. Tokens streamed before the drop are not re-sent.
- **Terminal handling.** Treat `done` and `failed` as end-of-turn; close the `EventSource`
  yourself (the server also closes the socket). There is no separate "close" event.
- **Stream token expired (401 on stream).** The turn is over — refetch history
  (`GET …/conversations/:id`) or start a new message.
- **Pending action expired (410) / superseded (409).** Show "this action is no longer available"
  and let the user re-ask.
- **`failed` / no providers configured.** Show a generic error; the turn is done.
- **Copilot writes are always available.** The copilot can always *propose* write actions; the
  safety gate is the per-action confirmation (§4.3), not a setting. The `agent_can_make_changes`
  call-setting governs only the **voice agent during a live call** — it does not disable copilot
  actions. (The copilot can even read/toggle that setting via `get_call_settings` /
  `update_call_settings`.)

---

## 6. Minimal client reference (vanilla JS)

```js
async function sendMessage(apiBase, jwt, conversationId, message) {
  const res = await fetch(`${apiBase}/copilot/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ message }),
  });
  const { streamUrl } = await res.json();
  return openTurnStream(apiBase, streamUrl);
}

function openTurnStream(apiBase, streamUrl) {
  const es = new EventSource(apiBase + streamUrl); // token is already in the URL
  const bubbles = new Map(); // message_id → accumulated text

  // Live deltas: group by message_id; channel is learned on `message`.
  es.addEventListener("token", (e) => {
    const { text, message_id } = JSON.parse(e.data);
    const prev = bubbles.get(message_id) || "";
    bubbles.set(message_id, prev + text);
    renderBubble(message_id, prev + text, /* channel unknown yet */ "pending");
  });

  // A generation finished — now we know if it was reasoning or the answer.
  es.addEventListener("message", (e) => {
    const { message_id, channel, text } = JSON.parse(e.data);
    if (channel === "reasoning") renderReasoning(message_id, text);   // collapsible "thinking"
    else renderAnswer(message_id, text);                              // primary Markdown bubble
  });

  // Tool activity + data (pair by tool_call_id).
  es.addEventListener("tool_call", (e) => { const t = JSON.parse(e.data); showToolChip(t.tool_call_id, t.name); });
  es.addEventListener("tool_result", (e) => { const t = JSON.parse(e.data); showToolCard(t.tool_call_id, t.name, t.result); });

  es.addEventListener("provider_switch", (e) => console.debug("LLM failover", JSON.parse(e.data)));

  es.addEventListener("propose", (e) => {
    const { pendingActionId, tool_name, preview } = JSON.parse(e.data);
    showConfirmCard({ pendingActionId, tool_name, preview }); // Confirm/Reject buttons
  });

  es.addEventListener("done", (e) => {
    const { result } = JSON.parse(e.data);
    if (result.status === "done") finalizeAnswer(result.text); // authoritative final answer
    es.close();
  });
  es.addEventListener("failed", (e) => { showError(JSON.parse(e.data).error); es.close(); });

  return es;
}

async function resolveAction(apiBase, jwt, conversationId, pendingActionId, decision) {
  const res = await fetch(`${apiBase}/copilot/conversations/${conversationId}/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ pendingActionId, decision }), // "confirm" | "reject"
  });
  const { streamUrl } = await res.json();
  return openTurnStream(apiBase, streamUrl); // streams the acknowledgement turn
}
```

---

## 7. Appendix — tools the agent can use (v1)

Read-only (always available): `find_customer`, `get_customer`, `count_unconfirmed_jobs`,
`count_unconfirmed_appointments_for_customer`, `list_jobs`, `list_open_todos`, `list_calls`,
`get_call`, `analytics_summary`, `list_voices`, `get_agent_config`, `get_call_settings`,
`find_call_targets`.

Write (always confirmation-gated; NOT restricted by the voice agent's `agent_can_make_changes`
flag): `set_todo_status`, `update_agent_config`, `update_call_settings`, `set_call_trigger_enabled`,
`make_call`, `schedule_call`, `run_scheduler`.

**Calling a customer (the smart flow):** `find_call_targets` returns the customer's possible calls
(appointments to confirm, open jobs, pending quotes), each with the exact reference and whether its
trigger is enabled. The widget should render these as a **pick-one list**; selecting one (or the
user telling the agent which) leads to a `make_call`/`schedule_call` propose→confirm. If the
needed trigger is disabled, the agent may first propose `set_call_trigger_enabled`.

`update_call_settings` and `update_agent_config` previews use `entity: "call_settings"` /
`entity: "agent_config"` with a `changes: [{ field, from, to }]` array — render the same generic
before/after card as §3.4. `make_call` / `schedule_call` previews use `entity: "call"` (a "call
X now / at <time>?" confirmation) — see §3.4 for the shape.

The frontend doesn't call these directly — they surface only via `tool_call`/`tool_result`
(informational) and, for writes, `propose`. New tools added server-side appear automatically with
no FE change, as long as the card in §3.4 renders generically from `preview.entity`.
