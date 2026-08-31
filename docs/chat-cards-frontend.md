# Chat Cards & Tool Visibility — Frontend Guide

> **For the frontend agent.** Every card action and free-text chat now go
> through a single endpoint, `POST /:token/messages` — the six separate
> action routes are retired (see the update in §0). Plus the appointment
> card shape they all share. Same conventions as
> `chat-link-status-frontend.md` / `daily-report-frontend.md`.

Base URL: `VITE_API_URL` · Auth: none — every endpoint below is public, token-authed
(same as today's `GET /chat-links/:token`). The token is the credential; never
put it in a URL a screenshot or a log could leak beyond what's necessary.

---

## 0. What shipped, and why

Today, confirming/rescheduling/cancelling an appointment only happens if the
model correctly reads free text and decides to call a tool. That's slow to
show anything (silence, then a sentence) and unreliable for something that
should be a sure thing. This ships two changes:

1. **Tool-call visibility** in the existing chat stream — you can now show
   *what the agent is doing*, not just a generic spinner.
2. **Appointment cards with buttons.** Confirm / Reschedule / Cancel /
   bulk-confirm-the-rest / decline-remaining now go **through the agent for
   real** (see the update below — this reverses an earlier version of this
   doc that had these as direct, model-free writes). Chat remains available
   alongside the cards for anything the buttons don't cover.

**Update — every card action now goes through `POST /:token/messages`, not
a route per action.** The six separate action routes that used to exist
(`/appointments/:id/confirm`, `/reschedule`, `/cancel`,
`/appointments/bulk-confirm`, `/appointments/decline-remaining`,
`/service-link`) are **retired — calling any of them now 404s.** Everything —
free chat, the "confirm the rest?" proposal, and every card button — is one
call: `POST /:token/messages` with `{ trigger, args }` (§1). `trigger` is
almost always the real tool name being invoked (`confirm_appointment`,
`reschedule_appointment`, `cancel_appointment`, `confirm_job_appointments`,
`decline_remaining_appointments`, `propose_remaining_appointments`) — there
is no separate URL to remember per action, and no appointment id in a route
path anymore; it's just another field in `args`. The one exception is
`send_service_link` (§5) — a composite trigger that runs two real tool
calls (`resolve_service_link_contact`, then `get_service_link`) in sequence.

**Update — every action goes through the agent for real, over one shared
endpoint.** Confirm/reschedule/cancel/bulk-confirm/decline-remaining used to
be plain JSON request/response per their own route, with no model involved
at all. Now, sending a trigger sends the agent a real turn — structurally
forced to call exactly one tool (it cannot do anything else, and the
API-level `tool_choice` guarantees the call actually happens, not just "the
model was allowed to") — and the response streams over SSE instead of a flat
JSON body:
- **One endpoint, `POST /:token/messages`, for every action** (§1/§3) — only
  the request's `trigger`/`args` change between actions; there is no
  per-action URL anymore.
- **Response is `thinking` → `tool_call` → `tool_result` →
  `done`/`error`** — the same event names/shapes free-text chat already
  uses (§1), deliberately narrowed for these triggers: they never emit
  `message_delta`/`message_complete`, even if the model produces stray
  narration — the shape of a successful response is always exactly those
  four events, never more, never fewer... with one deliberate exception:
  `send_service_link`'s happy path runs that pattern twice before `done`
  (seven events total) — see §1/§5.
- **The action's own result fields live in `tool_result.result`** — read
  `job_status`, `service_link_sent`, `confirmed`, etc. from there, not from
  a top-level JSON field. `tool_result.result` is byte-for-byte the same
  shape the old flat per-route response body used to be — only where you
  read it from changed.
- **Failure (e.g. "Appointment not found") is an `error` event, not an
  HTTP 4xx** — SSE can't change the status code after headers are sent, so a
  write that fails once the stream has started comes back as `error`
  instead. A bad token, an unknown `trigger`, or a missing required `args`
  field (e.g. cancel's `reason`) still 400s/404s as **plain JSON**, before
  any stream opens — those checks happen first, same as before.
- **Reschedule no longer has a separate no-SSE "skip" path.** Both picking a
  time and skipping now go through the same `trigger:
  "reschedule_appointment"` call — `args.scheduled_start` is optional, and
  omitting it IS the skip path (§3/§6). Every reschedule call streams
  `thinking` → `tool_call` → `tool_result` → `done`, full stop — no
  exceptions to the four-event shape.

**Sequencing update:** the opening message is accompanied on load by the card
for the appointment it's actually about, up front. See §2 for how many cards
the backend actually sends now, and what stays a frontend rendering choice.

**Update — the opening message is now deliberately short, and onsite
expectations moved to after confirmation.** Previously the agent's very
first message could carry the greeting, the job's internal description
text, AND the full onsite-expectations/noise-access question all crammed
into one dense paragraph — a real UX problem, since the customer hadn't
even replied yet. Now:
- **The opening message is just a greeting**: who the rep is, the visit's
  date, the reason for the visit, and the technician's name if one's
  already assigned. Nothing else — no job description, no onsite
  expectations, no access/noise question. Expect this to read noticeably
  shorter than before.
- **Onsite expectations + the noise/access question move to right after the
  customer confirms** (or reschedules) the appointment — delivered as part
  of that same reply, before the arrival-window message, not before. You
  don't need to change anything to consume this — it's still plain
  `message_delta`/`message_complete` text on the normal streaming contract
  (§1); only *when* the agent says it changed, not the event shape.

**Update — the "confirm the rest?" step is now a real conversation turn, and
`/end` enforces it.** Previously this was a pure UI-only prompt: the agent
never actually asked anything, and a "not now" answer left no trace at all —
which also meant nothing stopped the chat from just ending right after the
first appointment. Now:
- Confirming/rescheduling a card tells you (`needs_propose_remaining`) whether
  there's anything else on the job to ask about.
- If so, you trigger the agent's OWN real turn to ask the question (§8) —
  it composes the message itself and hands back real appointment cards for
  whatever it's asking about, via the normal streaming contract (§1).
- `POST /:token/end` now 409s if that question hasn't been asked and answered
  yet — handle this silently (§3, §8), never as a customer-facing error.
- The appointment card also carries a `service_link` field now (§2) — show it
  in the card's top-right corner.

**Update — `input_hint`'s old "Yes, confirm the rest / No, just this one"
quick-replies are retired.** `confirmation_accepted` now always returns
`{ "type": "free_text" }`. Every appointment on the job is already visible
as its own card from the very first load, so there's no longer a distinct
"now ask about the rest" moment for a quick-reply pair to represent — §8's
flow (triggered off `needs_propose_remaining`, not `input_hint`) is still
exactly how you offer that. If your `input_hint` handling special-cased
those two option strings, it can be removed; `free_text` there is the only
value you'll see now.

**Update — a new trigger, `capture_confirmer_identity`, records who's
actually confirming.** See §3a. Call it once, early, via a small identity
form (first name, last name, role, phone, email optional) — either before
the customer's first confirm/reschedule/cancel/create action, or any time
you want to prompt for it; it's a normal card-trigger action like the
others, not gated to a specific card. Once captured, "who confirmed" in the
CRM comment and every `confirmed_by`-style label uses this name instead of
whoever the link happened to be addressed to.

**Update — appointment cards can now carry `onsite_instructions`.** See
§2's field table. Company-authored access/noise/duration content, keyed by
service line, general or specific — some entries are pure statements to
show as-is, others are marked `requires_response: true` and need an input
(not just static text) since the agent can't wait for a typed reply from a
button click the way it can in the normal chat flow.

---

## 1. Streaming contract changes (`POST /chat-links/:token/messages`)

**Request body is now `{ content }` OR `{ trigger, args }` — never both.**
`content` is a real customer message, unchanged. `trigger` fires a named
internal turn instead — `trigger` is always the **real tool name** being
invoked, one of:

| `trigger` | `args` | used by |
|---|---|---|
| `propose_remaining_appointments` | none | §8 — agent asks "want to confirm the rest too?" for real |
| `confirm_appointment` | `{ appointment_id }` | §4 |
| `reschedule_appointment` | `{ appointment_id, scheduled_start?, scheduled_end? }` | §6 — `scheduled_start`/`scheduled_end` are **optional**; omitting `scheduled_start` IS the "skip, let staff follow up" path (see below) |
| `cancel_appointment` | `{ appointment_id, reason, scope? }` | §7 — `reason` required |
| `confirm_job_appointments` | `{ confirm_all: true }` or `{ appointment_ids: [...] }` | §8 — "confirm the rest" / bulk-confirm |
| `decline_remaining_appointments` | none | §8 — "not now" |
| `send_service_link` | `{ email, first_name?, last_name?, role?, phone? }` | §5 — `email` required; the four name fields are only used on the second call, after a `need_more_info` response |
| `capture_confirmer_identity` | `{ first_name, last_name, role, phone, email? }` | §3a — `role` is one of `management`/`on_site`/`billing`/`scheduling`/`owner`/`other` |

**Never hardcode the internal marker text a trigger maps to server-side** —
that's an implementation detail that can change; `trigger`/`args` is the
stable contract. An unknown `trigger` value 400s
(`{ "error": "Unknown trigger: ..." }`); a missing required `args` field
(e.g. cancel's `reason`, `send_service_link`'s `email`) 400s the same way,
before any stream opens; neither `content` nor `trigger` present still 400s
exactly as before (`{ "error": "content is required" }`).

**For every `trigger` except free `content`, the response is narrowed** to
exactly `thinking` → `tool_call` → `tool_result` → `done`/`error` — these
calls never emit `message_delta`/`message_complete`, even if the model
produces stray narration under the hood. A plain `content` message keeps
using the full event set (including `message_delta`/`message_complete`) as
before. See §3 for each trigger's exact `tool_result.result`/`done` shape.

**One exception to the four-event shape: `send_service_link`.** It's the
only trigger that isn't one tool call — server-side it forces
`resolve_service_link_contact`, and then, only if that actually resolved a
contact (not `need_more_info`), forces `get_service_link` too, in the same
response. So its happy-path shape is **seven** events —
`thinking → tool_call → tool_result → thinking → tool_call → tool_result →
done` — while its `need_more_info` path stays at the usual four. See §5.

| Event | Change |
|---|---|
| `typing` → **`thinking`** | Renamed only — same empty payload `{}`. Rename your listener; the UI copy can now say something more honest than a generic dot ("Clara is thinking…"). |
| **`tool_call`** (new) | `{ "tool": "confirm_appointment", "args": { "appointment_id": 501 } }` — fired the instant the agent decides to call a tool, before it runs. |
| **`tool_result`** (new) | `{ "tool": "confirm_appointment", "result": { "success": true, "appointment_id": 501, "job_status": "confirmed" } }` — fired when the tool finishes. `result` can be `null` if the tool's own output was unparseable — treat that as "something happened, details unavailable," not an error. |
| `message_delta` / `message_complete` | Unchanged. |
| `done` | **+ `appointments: [...]`** — a fresh card array reflecting the *entire* job, taken right after this turn. Update your card list from this on every turn, even if the customer only typed — a chat-driven action (they typed "yes, confirm it" instead of clicking) still changes the cards. |
| `error` | Unchanged. |

**`get_service_link` no longer has a special message shape.** Previously a
successful service-link fetch arrived as `message_complete` with
`{type:"service_link", url, job_name}`. That's retired — it now arrives as a
`tool_result` event with `tool === "get_service_link"` and
`result.url`/`result.job_name`, exactly like every other tool. If you already
built a service-link card renderer, wire it to `tool_result` instead of
`message_complete`.

### Suggested tool → status line mapping

Show *something* between `tool_call` and `tool_result` rather than a blank
gap — that gap, with zero indication of what was happening, is the exact
complaint this feature exists to fix.

| tool | while running | note |
|---|---|---|
| `confirm_appointment` / `confirm_job_appointments` | "Confirming your appointment…" | |
| `reschedule_appointment` | "Moving your appointment…" | |
| `cancel_appointment` | "Cancelling your appointment…" | |
| `resolve_service_link_contact` | "Looking you up…" | |
| `get_service_link` | "Pulling up your link…" | |
| `list_upcoming_appointments` | "Checking your other visits…" | |
| `propose_remaining_appointments` | *(don't show a status line — the result IS the message, see §8)* | Only ever fires on a `trigger: "propose_remaining_appointments"` turn. `tool_result.result` is `{ message, appointments }` — render `message` as the agent's chat bubble and `appointments` as cards, not a generic tool-result shape. |
| `report_customer_intent` | *(don't show anything)* | Internal signal only, never user-facing. |
| `end_conversation` | *(don't show anything)* | The turn is about to end anyway. |

This chat/tool-calling path (typing free text) still exists and still works
exactly as before — this table only matters if you want to render its tool
calls too. The cards below don't go through it at all.

---

## 2. The appointment card

### The known contact — pre-filling the service-link step

**`GET /chat-links/:token`'s initial load also returns `contact_name`,
`contact_email`, and `contact_phone`** — whoever we believe this conversation
is actually with (the same resolution the agent itself uses to decide who to
greet by name: a snapshot of who the link was addressed to, falling back to
the ServiceTrade contact record, falling back to whoever the send actually
went to). Any of the three can be `null` — we don't always know all of them.

**Use `contact_email` as the default value in the service-link email step
(§5)**, pre-filled in the input rather than left blank, with an **edit
button** so the customer can correct it before anything sends. Don't skip the
confirmation step just because a default is present — §5's "is that right?"
ask still applies; this only saves them from typing an address we already
have. `contact_name`/`contact_phone` are there for the same reason (e.g.
showing "Is this for Dana Acme?" instead of a blank), not required to be used
if you don't have a spot for them yet.

### When cards appear, and how many

**Update — `GET /chat-links/:token`'s initial load now returns the FULL job
appointment list**, same shape and sort order (soonest-first) as every
trigger call's `done` event — not truncated to one card anymore. This
changed specifically so the widget can resolve appointment ids referenced in
transcript lines from an *earlier* session (the system-action rewrite, e.g.
turning "Customer confirmed appointment #110727." into a full sentence
naming the service/date) — those ids aren't in a `done` event from this
session at all if the customer hasn't triggered anything yet, so the lookup
needs the whole list up front, not just the one appointment the opening
message is about.

**"Show only one card at a time" is still the right UX — it's just enforced
client-side now, not by the backend shrinking the array.** Render only the
lead appointment (the earliest one still unconfirmed; if everything's
confirmed, the chronologically next one) as a visible card on load. Store
the rest of the array for lookups only — same thing you already do with
every `done` event's full list — until the "want to confirm the rest too?"
step (§8) is the point where the others actually get rendered. Showing them
all as visible cards on the first turn is still the exact "wall of cards"
problem this feature exists to avoid; it's just your rendering logic's job
to prevent it now, not the payload's size.

**Flow, end to end:**
1. Load → greeting + the full appointment array; render only the lead one.
2. Customer acts on it (§4/§6/§7 below).
3. *Then* ask if they want to confirm the rest, and only then render the
   other cards already sitting in your state (§8).

Present everywhere a job's appointments are shown: `GET /chat-links/:token`'s
`appointments` field (the full list, or `[]` if nothing upcoming), and every
`done` SSE event's `appointments` field — every `POST /:token/messages` call
(§1/§3), whatever `trigger`/`content` it carries, emits one, always the full
list.

```json
{
  "appointment_id": 110735,
  "job_number": "49354684",
  "job_title": "Inspection Job #49354684",
  "location_name": "Kings Theatre",
  "scheduled_start": "2026-08-20T14:00:00.000Z",
  "scheduled_start_label": "Thursday, August 20, 2026 at 2:00 PM",
  "arrival_window_label": "between 2 PM and 3 PM",
  "service_line": "Fire Alarm Inspection",
  "service_requests": [
    { "line": "Fire Alarm Inspection", "description": "Semi-annual test" }
  ],
  "technicians": [
    { "name": "Casey Nary", "phone": "+15550001111", "email": null }
  ],
  "status": "not_confirmed",
  "actions_available": ["confirm", "reschedule", "cancel"],
  "service_link": { "sent": false, "url": null },
  "onsite_instructions": [
    { "text": "We'll need access to the electrical room to reach the panel.", "requires_response": false },
    { "text": "Is there a gate code we'll need, or will someone let the technician in?", "requires_response": true }
  ]
}
```

| field | note |
|---|---|
| `arrival_window_label` | **Render in italic.** This is the one field explicitly called out for that treatment — it's a caveat ("the tech arrives within this window, not at the exact scheduled time"), not a fact, and should read visually differently from the rest of the card. |
| `status` | One of `not_confirmed` \| `confirmed` \| `cancelled`. Never the raw appointment DB status — this is a clean, stable enum. |
| `actions_available` | **Computed by the backend — always trust this over any logic you might derive from `status` yourself.** A `confirmed` card never includes `"confirm"`; a `cancelled` card is `[]`. Show only the buttons this array lists. If a new action type is ever added here, an unrecognized string should be ignored, not crash the card. |
| `service_requests` | Every service on the visit, not just one — a card with 3 services shows 3 lines. |
| `technicians` | The whole crew, not just the lead. |
| `service_link` | **Render as a badge/icon in the card's top-right corner** when `sent` is `true` — clicking it opens `url`. `service_link` is job-scoped, not per-appointment (one job, one service link), so every card for the same job carries the identical value; that's expected, not a bug. `url` is `null` until a send actually succeeds — show nothing (or a plain "sent" badge with no link) if `sent` is `true` but `url` is still `null` (a rare timing gap, not an error state to surface). |
| `onsite_instructions` | Company-authored access/noise/duration content for this specific visit — `[]` when the company has none on file (the common case at launch). Each entry: `text` (already-written prose, show as-is, don't reformat it) and `requires_response` — `false` renders as plain informational text; `true` needs an actual input (a text field or yes/no, your call) since there's no chat turn here for the agent to ask a question and wait — capture whatever the customer enters and include it however you already surface free-form card input, if you have a mechanism for that; if not, this is a placeholder to build toward, not a blocker for using the `false` entries today. |

---

## 3. Action triggers, via `POST /:token/messages`

There is **no separate URL per action anymore.** Every action below is a
`{ trigger, args }` body to the one endpoint documented in §1 — `POST`,
public (token in the URL path). Only `/end` (further down) remains its own
route, unchanged plain JSON — nothing routes through the agent for that one.

**Before you build the buttons:** confirm/reschedule/cancel each write
directly to the appointment with no undo. Show a confirmation dialog
("This can't be undone — continue?") before firing any of these three. The
write happens the instant the forced tool call lands — there's no
server-side draft/review step, same as before.

**Reading a trigger call's response, in general:**
1. `thinking` — `{}`. Show it exactly like a normal chat turn.
2. `tool_call` — `{ tool, args }`. `tool` will always match the `trigger`
   you sent (e.g. `"confirm_appointment"`) — you don't strictly need to
   branch on it, but it's there for a generic renderer.
3. `tool_result` — `{ tool, result }`. **`result` is the action's own outcome
   fields — byte-for-byte the SAME shape the old per-route flat JSON body
   used to be.** Read `job_status`/`service_link_sent`/`confirmed`/etc. from
   here, not from `done`.
4. `done` — fresh `{ appointments, remaining_unconfirmed, all_confirmed
   [, needs_propose_remaining] }`, computed fresh after the write — same
   fields as before, just delivered here instead of the old per-route
   response body.
5. `error` (instead of `done`) — `{ error }`. Replaces the old 404/400 for
   anything that fails once the stream has started (a bad/gone appointment
   id, etc.) — SSE can't change the HTTP status after headers are sent.
   **A bad token, an unknown `trigger`, or a missing required `args` field
   checked before the stream opens (cancel's `reason`), still comes back as
   plain JSON 400/404** — those checks run first, unchanged from before.

### trigger: `"confirm_appointment"`
`args: { appointment_id }`

**`tool_result.result`** (on success) `{ "success": true, "appointment_id": 501, "job_status": "confirmed", "service_link_sent": true, "service_link_pending_reason": null }`
**`done`** `{ "appointments": [...], "remaining_unconfirmed": 2, "all_confirmed": false, "needs_propose_remaining": true }`
**`error`** (e.g. already-gone or wrong id) `{ "error": "Appointment not found" }` — sending this trigger again for an already-confirmed appointment is a harmless no-op (`job_status` stays `"confirmed"`, nothing changes twice, no error).

`service_link_sent`/`service_link_pending_reason` (in `tool_result.result`)
tell you whether this confirm was *also* the trigger that sent the service
link (see §5) — show a toast ("We've also sent your service link!") only
when `service_link_sent` is `true`.

`needs_propose_remaining` (in `done`, `remaining_unconfirmed > 0`) tells you
whether to trigger the agent's "confirm the rest?" turn — see §8. **Do not go
straight to `/end`** when this is `true`; it will 409.

### trigger: `"reschedule_appointment"`
`args: { appointment_id, scheduled_start?, scheduled_end? }` —
`scheduled_end` optional (defaults to +2h). **Both date/time fields are
optional** — see the skip case below. This is one trigger with two
outcomes, not two separate flows: whichever branch fires, the response is
always `thinking` → `tool_call` → `tool_result` → `done`/`error`, no
exceptions.

**A real reschedule** (`scheduled_start` given): `tool_result.result` =
`{ "success": true, "appointment_id": 501, "scheduled_start": "...", "scheduled_end": "..." }`, then `done` = `{ appointments, remaining_unconfirmed, all_confirmed, needs_propose_remaining }`.

**Skipped** (`scheduled_start` omitted): there is no way to invent a time
the customer never gave, so the agent's tool call itself takes the
escalation branch instead of a real reschedule — same trigger, same
streamed shape, **different `tool_result.result`**:
`{ "success": true, "escalated": true, "appointment_id": 501, "message": "Our team will follow up to find a time." }`,
then the same `done` shape as a real reschedule.

**Always check `escalated` in `tool_result.result` before assuming the
appointment moved.** When `escalated` is `true`, nothing changed on the
appointment (the card still shows `not_confirmed`/whatever it was) — a
staff member will follow up by phone. Show the `message` field as the
confirmation in that case, not "your appointment has been moved."

### trigger: `"cancel_appointment"`
`args: { appointment_id, reason, scope? }`

`reason` **required** — **400, plain JSON, before the SSE stream opens** if
blank (unchanged from before). `scope` optional, defaults to
`"appointment_only"`; pass `"entire_job"` only if the customer means the
whole job, not just this one visit.

**`tool_result.result`** `{ "success": true, "appointment_id": 501, "scope": "appointment_only", "job_status": null }`
**`done`** `{ "appointments": [...], "remaining_unconfirmed": ..., "all_confirmed": ... }` — no `needs_propose_remaining` here; cancel closes the chat (§7), nothing to propose.
**`error`** `{ "error": "Appointment not found" }`

### trigger: `"confirm_job_appointments"`
`args: { confirm_all: true }` or `args: { appointment_ids: [501, 502] }`

This is the **"confirm the rest?"** step (formerly "bulk-confirm") — see §8
for when to show it.

**`tool_result.result`** `{ "success": true, "confirmed": [501, 502], "skipped": [{ "appointment_id": "503", "reason": "already_confirmed" }], "job_status": "confirmed" }`
**`done`** `{ "appointments": [...], "remaining_unconfirmed": 0, "all_confirmed": true, "needs_propose_remaining": false }`
**`error`** (e.g. neither `confirm_all` nor a non-empty `appointment_ids` given) `{ "error": "Pass confirmAll=true or a non-empty appointmentIds list" }` — a client bug, not a user-facing state.

`skipped` entries (in `tool_result.result`) are informational only — don't
surface `reason` codes to the customer, just use the `confirmed` count for
your success message.

### trigger: `"decline_remaining_appointments"`
`args: {}` (no fields needed). Call this when the customer answers the
agent's "confirm the rest?" question (§8) with **Not now**. Records that the
question was asked and answered — same purpose as `confirm_job_appointments`
above, just without confirming anything — so `/end` stops 409ing.

**`tool_result.result`** `{ "success": true }`
**`done`** `{ "appointments": [...], "remaining_unconfirmed": 2, "all_confirmed": false }`

### trigger: `"capture_confirmer_identity"` (§3a)
`args: { first_name, last_name, role, phone, email? }` — all but `email`
**required, 400 before any SSE stream opens** if any are blank/invalid.
`role` must be one of `management` / `on_site` / `billing` / `scheduling` /
`owner` / `other` — anything else 400s.

Not tied to a specific appointment or card — call it once per conversation,
via a small identity form, whenever makes sense in your flow (e.g. before
the first Confirm/Reschedule/Cancel button, or up front alongside the
opening message). The agent also has this same tool and may capture it
itself mid-conversation if the customer volunteers their name/role in free
text — either path writes the same record, so don't re-prompt if you
already know it was captured (e.g. from an earlier response in this
session).

**`tool_result.result`** `{ "success": true, "first_name": "Jane", "last_name": "Doe", "role": "on_site", "phone": "+15551234567", "email": null }`
**`done`** `{ "appointments": [...], "remaining_unconfirmed": ..., "all_confirmed": ... }` — no `needs_propose_remaining`; capturing identity doesn't touch confirmation state.
**`error`** (no active session for this token) `{ "error": "No active chat session" }`

### trigger: `"send_service_link"`
`args: { email, first_name?, last_name?, role?, phone? }` — `email`
**required, 400 before any SSE stream opens** if blank. The four name
fields are only meaningful on a **second** call, after a `need_more_info`
result (see below).

**This is the one trigger that isn't a single tool call** — see §1's
seven-event exception. Server-side it forces `resolve_service_link_contact`
first, then, only if that call actually resolved a contact, forces
`get_service_link` too, so the response also carries a URL to render as a
preview card. `email_confirmed` is never something you send — it's forced
`true` server-side, since your own "is this the right email?" step (below)
already happened before this call is ever made.

**Full success** (a contact was found or created, and the link was fetched):
```
thinking → tool_call(resolve_service_link_contact) → tool_result(...) →
thinking → tool_call(get_service_link) → tool_result(...) → done
```
- First `tool_result.result`: `{ "success": true, "status": "found", "contact_id": "55", "name": "Dana Acme", "email": "dana@x.test", "link_sent": true }` (`status` is `"found"` or `"created"`).
- Second `tool_result.result`: `{ "success": true, "url": "https://...", "job_name": "Quarterly PM" }` — render this as the inline link preview card.
- `done`: `{ "appointments": [...], "remaining_unconfirmed": ..., "all_confirmed": ... }` — no `needs_propose_remaining`; sending a link doesn't touch confirmation state.

**Need more info** (no existing contact matched the email, and no name was given yet) — stops after ONE tool call, back to the usual four-event shape:
```
thinking → tool_call(resolve_service_link_contact) → tool_result(...) → done
```
`tool_result.result`: `{ "success": true, "status": "need_more_info", "email": "dana@x.test", "fields_needed": ["first_name", "last_name"] }`.
Show a small name form (first/last required, role optional), then send this
same trigger again with `email` **and** those fields included.

**Failure at either step** → `error` instead of `done`, immediately — a
failed resolve never reaches `get_service_link`. E.g.
`{ "error": "Failed to create contact in ServiceTrade" }`.

### `POST /:token/end`
No body. Call this once the "confirm the rest?" step resolves, however it
resolves (bulk-confirmed, confirmed some, or decline-remaining).

**200** `{ "ok": true, "state": "chat_ended" }`
**409** `{ "ok": false, "error": "remaining_appointments_unaddressed", "code": "remaining_appointments_unaddressed" }`

**The 409 is enforcement, not a bug — and it is never a customer-facing
error.** The backend refuses to close a conversation that still has other
unconfirmed appointments nobody has actually been asked about yet (this is
what used to let the chat end right after just the first appointment). If you
see this: it means §8 hasn't been shown/resolved yet (e.g. a page reload
between the confirm and the end call) — go run §8, then retry `/end`. Do not
show this error to the customer under any circumstance; there's no world
where "remaining_appointments_unaddressed" is something they should read.

After a successful `/end`, the widget should show a closed/"you're all set"
state — don't let the customer send another message or click another card
action on this token afterward (nothing will error if they do, but there's
nothing left for the conversation to do).

---

## 4. Building CASE A — confirm

1. Customer clicks **Confirm** on the next upcoming appointment's card.
2. Confirmation dialog ("This can't be undone — continue?"). On yes:
3. `POST /:token/messages` with `{ "trigger": "confirm_appointment", "args": { "appointment_id": <id> } }`
   (§3): show `thinking`, then wait for `tool_result`/`done` (or `error`).
4. Re-render cards from `done`'s `appointments` array.
5. **Remember `service_link_sent`/`service_link_pending_reason` from
   `tool_result.result`** — don't act on them yet. Check `done`'s
   `needs_propose_remaining` and go to §8; the service-link step (§5) now
   comes *after* that resolves, not before.

## 5. The service-link email step — once per conversation, after §8 resolves

**This is asked once §8 (confirm the rest?) is fully resolved — bulk-confirmed,
confirmed some, or declined via the `decline_remaining_appointments` trigger —
right before `POST /:token/end`.** Use the
`service_link_sent`/`service_link_pending_reason` fields from whichever
call's `tool_result.result` most recently confirmed something (the initial
`confirm_appointment` trigger, or `confirm_job_appointments` if the customer
confirmed more there — the later call's values win, since either can trigger
the send). Never repeated more than once per conversation; the backend is
idempotent about it either way, but the intended UX is: ask once.

1. If `service_link_sent: true` on that latest response, the link already went
   out automatically — show a small "we've also emailed your link" note and
   skip straight to `POST /:token/end`. Nothing left to ask.
2. Otherwise, if `service_link_pending_reason` was set (no recipient captured
   yet), show: *"We'll send a link to track this job to **{email}** — is that
   right?"* with **Yes** / **No, use a different email**. Pre-fill `{email}`
   with the load-time `contact_email` (§2) as the default, shown with an
   **edit button** rather than a blank input — the customer can still change
   it before anything sends.
3. **Yes** → `POST /:token/messages` with `{ "trigger": "send_service_link", "args": { "email": "..." } }` (§3).
4. **No** (or they used the edit button) → collect the corrected email, then
   the same trigger with what they typed.
5. Listen for the `tool_result` event where `tool === "resolve_service_link_contact"`.
   If its `result.status` is `need_more_info` — this is a brand-new contact
   ServiceTrade has never seen, and needs a name to create one. Show a small
   "what's your name?" form (first/last required, role optional), then send
   `send_service_link` **again** with `email` + those fields added to `args`.
6. On `status: "found"` or `"created"`, the link was sent — show it as sent.
   Then listen for the SECOND `tool_result` event, `tool === "get_service_link"`,
   and render `result.url`/`result.job_name` as an inline preview card (this
   step only fires when step 5 didn't need more info — see §1/§3's
   seven-event shape for `send_service_link`).
7. `POST /:token/end`.

If `contact_email` was `null` at load (no address on file at all), skip
straight to the "type an email" input rather than asking to confirm a blank.
If nothing was ever confirmed this conversation (customer only
rescheduled/cancelled), there's no service link to offer — skip this section
entirely (see §6/§7).

## 6. Building CASE B — reschedule

1. Customer clicks **Reschedule** on a card.
2. Show a date/time picker, **with a visible "I'm not sure — just let staff
   know" / Skip option**.
3. Confirmation dialog before submitting either path (rescheduling is also
   not reversible via the UI).
4. Picked a time → `POST /:token/messages` with `{ "trigger": "reschedule_appointment", "args": { "appointment_id": <id>, "scheduled_start": "..." } }` (§3).
   Skipped → same trigger, same endpoint, with `scheduled_start` **omitted**
   from `args` — no separate route, no separate plain-JSON branch anymore
   (§3). Both stream `thinking` → `tool_call` → `tool_result` → `done`.
   Check `tool_result.result.escalated` — when `true`, show the returned
   `message` ("Our team will follow up to find a time"), not a
   success-with-new-time message.
5. Re-render cards from `done`'s `appointments` array either way.
   Check `needs_propose_remaining` and go to §8.

## 7. CASE C — cancel

1. Customer clicks **Cancel** on a card.
2. Ask for a reason — **required**, the call 400s (plain JSON, before any
   SSE stream) without one.
3. Confirmation dialog.
4. `POST /:token/messages` with `{ "trigger": "cancel_appointment", "args": { "appointment_id": <id>, "reason": "...", "scope": "..." } }` (§3).
5. **This closes the chat.** Call `POST /:token/end` right after a successful
   cancel (`tool_result.result.success: true`) — do not proceed to §8 or §5;
   there's nothing left to offer once the customer has cancelled. (`/end`
   will not 409 here even if other appointments are still unconfirmed —
   cancelling satisfies that check on its own, by design: there's genuinely
   nothing left to ask.)

## 8. The shared follow-up — "confirm the rest?"

**This is now a real agent turn, not a UI-only prompt.** After CASE A or CASE
B (not after a cancel — see above), check the response's
`needs_propose_remaining` (equivalently, `remaining_unconfirmed > 0`). If
`false`, skip straight to step 4. If `true`:

1. Send the agent's own proposal: `POST /:token/messages` with
   `{ "trigger": "propose_remaining_appointments" }` — same SSE stream as any
   chat turn (§1). Show `thinking` while it runs.
2. Listen for the `tool_result` event where `tool === "propose_remaining_appointments"`.
   Its `result` is `{ message, appointments }` — render `message` as the
   agent's own chat bubble (this is real, agent-composed text, not a
   template) and `appointments` as cards with checkboxes, plus a
   **Confirm All** button. (If this event never arrives — e.g. the agent
   errored — fall back to a generic "Want to confirm the rest too?" prompt
   using the `appointments` array you already have from step 3/5 above.)
3. **Confirm All** → `POST /:token/messages` with
   `{ "trigger": "confirm_job_appointments", "args": { "confirm_all": true } }` (§3).
   **Confirm selected** → same trigger with `{ "args": { "appointment_ids": [...] } }`.
   **Not now** → `POST /:token/messages` with
   `{ "trigger": "decline_remaining_appointments" }` (§3).
4. Go to §5 if an appointment was confirmed at any point this conversation
   (via `confirm_appointment` or a `confirm_job_appointments` call just
   above) — that's the service-link step. Otherwise (customer only
   rescheduled, or declined), go straight to `POST /:token/end`.

`/end` after this always succeeds now — step 3's confirm_job_appointments/
decline_remaining_appointments trigger is exactly what satisfies the gate
described in §3. If you ever see the 409 there anyway, it means this section
was skipped somehow; go back and run it rather than working around the
error.

---

## 9. Things to get right

**Never derive `actions_available` yourself.** If the backend ever adds a
new status or action, a client re-deriving the rule from `status` alone will
render the wrong buttons instead of just not knowing about the new one.

**The six old per-action routes (`/appointments/:id/confirm`, `/reschedule`,
`/cancel`, `/appointments/bulk-confirm`, `/appointments/decline-remaining`,
`/service-link`) are gone — calling any of them 404s.** If you have any code
left pointing at them, it will silently stop working; every action now goes
through `POST /:token/messages` with `{ trigger, args }` (§1/§3).

**For every trigger, check `tool_result.result.success`, not HTTP status, for
whether the write actually happened** — a failed write now comes back as an
`error` event, never a 2xx `done` with `success:false` buried inside.
`reschedule_appointment`'s escalation branch and `send_service_link`'s
`need_more_info` result are the two remaining cases where `success:true`
doesn't mean "the thing you asked for happened" — check `escalated`/`status`
there instead.

**The confirmation dialog is load-bearing.** There is no undo, no draft, no
review step server-side — the write happens the instant the forced tool call
lands, same as before.

**A successful trigger call emits exactly `thinking` → `tool_call` →
`tool_result` → `done`, in that order, nothing more — except
`send_service_link`, whose happy path emits that pattern TWICE before
`done` (§1).** This is a deliberate guarantee, not an implementation detail
you need to defend against — the backend suppresses any stray model
narration before it reaches the wire (§3). Build your renderer to expect
exactly this shape.

**`done`'s `appointments` array is the source of truth after ANY turn** —
whether the customer typed, clicked a card, or an agent-routed action just
ran. Don't maintain a separate "cards last fetched at page load" state that
free-text chat (or another card click) can silently go stale against.

**Re-opening a link mid-conversation can now replay message shapes beyond
plain text.** `GET /chat-links/:token`'s `messages` array (a customer
re-opening the same link) can contain, alongside the usual
`{role:"user"/"agent", content}`: `{role:"agent", type:"service_link", url,
job_name}` (unchanged, existing), `{role:"agent", type:"propose_remaining",
content, appointments}` (§8's agent turn, replayed), and `{role:"system",
type:"action", content}` (a plain-text note recording a past card action,
e.g. "Customer confirmed appointment #501.") — render this last one as a
small system/log-style line, not a chat bubble attributed to the agent or the
customer. All three carry `created_at: null` when the timestamp couldn't be
recovered — don't crash on a missing timestamp.
