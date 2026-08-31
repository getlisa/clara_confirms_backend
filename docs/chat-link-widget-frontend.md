# Chat links — Frontend Integration Guide

> Covers a **third** way to reach the same conversation flow, alongside voice
> and SMS: a shareable link for a specific **job** that opens **our
> own** full-page, ChatGPT-style chat interface — not Retell's widget. The
> conversation is **job-centric**: it covers every upcoming appointment on that
> job, confirms the next one, and offers to confirm the rest before ending. (An
> appointment-scoped link resolves to that appointment's parent job and behaves
> identically.) This
> sidesteps the SMS A2P approval cost/timeline entirely — no phone number, no
> Retell public key, no Retell script tag on the page at all. The frontend
> talks only to this backend; everything Retell-related (creating the chat
> session, sending messages, reading the transcript) happens server-side.
> Independent of the channel-strategy work in `chat-sms-channel-frontend.md`
> — this isn't part of that automatic voice/SMS resolution, it's a manually
> triggered "send a chat link" action (for now — see §6).

## 0. What shipped (backend)

- `POST /chat-links/appointments/:id` and `POST /chat-links/jobs/:id` —
  authenticated (staff), generates (or reuses) an opaque, unguessable token.
  **`/jobs/:id` is the preferred entry point** now that the conversation is
  job-scoped; `/appointments/:id` is kept for the appointment-card action and
  resolves to the parent job.
- `GET /chat-links/:token` — **public, no auth** — the token itself is the
  credential. Creates the real chat session on first open (triggering the
  agent's opening greeting — verified live, the agent always speaks first,
  never the customer) or resumes it on a repeat open. Returns the visible
  message history plus a `state` and `input_hint` telling the UI exactly what
  to render next.
- `POST /chat-links/:token/messages` — **public, same token-as-credential
  model**, Server-Sent Events. Send a customer reply, get the agent's response
  back as a simulated typing stream (Retell's chat completion has no true
  token-level streaming, so this reveals the final text progressively rather
  than all-at-once).
- A **state machine** (`chat_started` → `confirmation_accepted` → …) derived
  server-side from which tools the agent actually calls during the
  conversation — the frontend never has to parse message text to figure out
  what's happening.

---

## 1. What the frontend needs to build

1. A **"Send chat link"** action on the job/appointment views — calls
   `POST /chat-links/appointments/:id` (or `/jobs/:id`), gets back a `token`,
   and builds a shareable URL: `https://<your-frontend-domain>/chat/<token>`.
   **Delivery is out of scope for this backend feature** — how that URL
   reaches the customer (copy/paste, email, etc.) is a frontend/product
   decision for now.
2. A **full-page chat UI** at that route (`/chat/:token`):
   - On load: `GET /chat-links/:token` → render the returned `messages`
     (the agent's opening greeting is already in there — don't wait for user
     input before showing it).
   - Render the input control based on `input_hint` (§3) — buttons, a date
     picker, an email field, or a plain text box.
   - On send: `POST /chat-links/:token/messages` with `{ content }`, consume
     the SSE stream (§4), append the revealed text as it arrives, then swap
     the input control based on the final `state`/`input_hint`.
   - On `404`/`503` from the initial `GET`, show an appropriate message (§5).

---

## 2. Generating a link

### `POST /chat-links/appointments/:id`
### `POST /chat-links/jobs/:id`
Standard JWT auth. Optional body:
```json
{ "call_type": "customer_confirmation" }
```
Defaults to `"customer_confirmation"` — this is the only call type the
chat-link feature currently drives.

**Response `201`:** `{ "token": "a4fce883…" }` — idempotent, calling again for
the same job/appointment returns the same token rather than minting a new one
**as long as it hasn't expired**.

**Expiry — new:** every link is now valid for **24 hours** from creation.
After that, `GET /chat-links/:token` returns `410 link_expired` (§5) and the
idempotent lookup above stops returning it — a fresh `POST` mints a new token
instead. This isn't just a widget-side concern: if a link goes out via the
automatic scheduler and sits unopened for 24h, the backend treats that the
same as a voice no-answer and automatically re-queues the confirmation (voice,
if the customer has `is_voice` on file — see `chat-sms-channel-frontend.md`
§2 — otherwise a fresh link), up to that job's normal retry cap. Nothing for
the frontend to build here beyond handling `410` gracefully; it's mentioned so
"the link died and nothing happened" isn't mistaken for a bug — a new attempt
is already on its way.

**Errors:** `404` if the job/appointment doesn't exist for this company; `422`
if there is nothing left to talk about — the job is cancelled/completed, or it
has no upcoming appointment. A job with *past* appointments is fine: the chat
covers whatever is still upcoming.

Note the asymmetry: that `422` applies at **creation** time. Once a link has been
delivered, `GET /chat-links/:token` deliberately still opens even if every
appointment has since been cancelled or has passed — the customer clicking a link
you sent them should never hit a dead page, and the agent simply offers to book a
new visit instead.

### Sending it by email — `POST /chat-links/appointments/:id/send-email` / `POST /chat-links/jobs/:id/send-email`
Same auth, same idempotent link (re-using an existing token rather than
minting a new one) — but this variant **also emails the link** to the
customer, for an actual "Send chat link" button on the appointment card
instead of the clipboard-copy-only flow above. Use this one if you want the
button to really deliver the link, not just generate a URL for a human to
paste somewhere.

```json
{ "call_type": "customer_confirmation", "email": "jack@example.com" }
```
Both fields optional. **`email`** sends to that address for this one send
instead of requiring the customer to already have one on file — pass it
whenever the caller has one in hand (e.g. a field the service manager just
typed in). It is **not** saved back to the customer record.

**Response `200`:**
```json
{ "token": "a4fce883…", "email": "customer@example.com", "sent": true }
```
`sent` mirrors whether the email actually went out (it's `true` even in local
dev if SendGrid isn't configured — that's a no-op-but-successful send, not a
failure).

**Errors:** same `404`/`422` as above, plus:
- **`422` `{ "error": "Customer has no email on file. Pass email to send to a specific address." }`**
  if no `email` was given in the request and the customer has none on file
  either. **This will happen a lot** — ServiceTrade-synced customers almost
  never have `customers.email` populated (their real email lives on a
  separate ServiceTrade Contact) — so don't dead-end on this error: prompt for
  an address inline and resubmit with `email` set, same pattern as
  `web-chat-dispatch-frontend.md`'s automatic-dispatch `MISSING_EMAIL` todo
  suggests for the unattended path.
- **`400` `{ "error": "Invalid email — could not validate as an email address." }`**
  if the given `email` doesn't look like one.

### Sending it by SMS — `POST /chat-links/appointments/:id/send-sms` / `POST /chat-links/jobs/:id/send-sms`
Same idea as `send-email` above, but texts the link via Twilio instead — a
plain text with a link, **not** the conversational Retell "Text Now" feature
used elsewhere in the product.

```json
{ "call_type": "customer_confirmation", "phone": "+15551234567" }
```
Both fields optional. **`phone`** sends to that number for this one send
instead of requiring the customer to already have one on file. Not saved
back to the customer record. Accepts loose formats — normalized to E.164
server-side.

**Response `200`:**
```json
{ "token": "a4fce883…", "phone": "+15551234567", "sent": true }
```
**Errors:** same `404` as `send-email`, plus:
- **`422` `{ "error": "Customer has no phone on file. Pass phone to send to a specific number." }`**
- **`400` `{ "error": "Invalid phone_number — could not normalize to a valid E.164 number." }`**

---

## 3. Loading a conversation

### `GET /chat-links/:token`
No auth header — fetched from an anonymous customer's browser.

**Response `200`:**
```json
{
  "ok": true,
  "company_name": "Testing Enterprise",
  "job_name": "Construction Job #44399940",
  "customer_name": "JACK LTR",
  "messages": [
    { "role": "agent", "content": "Hi JACK LTR, this is Clara with Testing Enterprise. I'm reaching out about your Construction Job #44399940 — you have 3 upcoming appointments on it, and the next one is on Thursday, July 23, 2026 at 09:30 AM for a Sprinkler / Fire Protection inspection. Is now a good time to chat?", "created_at": 1784819388725 }
  ],
  "state": "chat_started",
  "input_hint": { "type": "quick_replies", "options": ["Confirm", "Request Reschedule", "Cancel"] }
}
```
The greeting adapts to how many appointments are upcoming: with **one** it names
just that appointment and never mentions a count (no "1 upcoming appointments");
with **none** it says no visit is booked yet and offers to schedule one. It leads
with the date and service rather than an appointment ID — internal IDs mean
nothing to a customer, so the agent only gives one if asked.
`messages` only ever contains real chat turns (`role: "agent" | "user"`) —
internal tool-call/routing plumbing is already filtered out server-side.
Calling this again later (e.g. the customer reopens the link, or just
refreshes the page) resumes the same conversation and returns the full
history — no special "reopen" endpoint needed, this is just what `GET` does.

If enough time has passed that the underlying session timed out from
inactivity, this same `GET` transparently starts a fresh session behind the
scenes instead of erroring: the response still contains the full prior
history, followed by a new opening-style greeting, and `state`/`input_hint`
reset back to `chat_started`/`quick_replies` for that new turn (the agent's
own next tool calls will reflect whatever's actually true in the platform —
e.g. if some appointments were already confirmed before the gap, it'll pick
that up rather than re-asking from scratch). Nothing distinguishes this response
shape from a normal resume — treat it the same way, just render the returned
`messages` in order.

### State reference
| State | Meaning |
|---|---|
| `chat_started` | Greeting sent, awaiting the customer's initial decision |
| `confirmation_accepted` | Customer confirmed **at least one** appointment on the job — normally the next one. Other upcoming appointments may still be unconfirmed; the agent asks about those before ending |
| `collecting_contact_info` | Agent is resolving/collecting a contact for the service link |
| `service_link_sent` | Service link emailed + pasted into the chat |
| `reschedule_needed` | Customer wants to reschedule, no date picked yet |
| `reschedule_pending_confirmation` | New date picked and applied — needs reconfirmation later |
| `canceled` | Customer canceled |
| `chat_ended` | **Changed** — the conversation is genuinely over. Historically this only ever meant "session timed out from inactivity"; it now *also* fires the moment the agent explicitly wraps up a conversation (far and away the more common case — see §6) |

### `input_hint` reference — what to render for the next input
| `type` | Fields | Render |
|---|---|---|
| `quick_replies` | `options: string[]` | Buttons instead of a text box — send the clicked label as `content`. Only ever fires at `chat_started`, with `["Confirm","Request Reschedule","Cancel"]` — **updated**, was `["Yes","Reschedule","Cancel"]`. `confirmation_accepted` is `free_text` now (see below) — every appointment on the job is already visible as its own card (chat-cards-frontend.md §2), so there's no separate "confirm the rest?" quick-reply moment to represent here anymore |
| `date_picker` | `min`, `max` (YYYY-MM-DD) | Calendar/time picker constrained to before the job's due date. Rescheduling moves **one** appointment — the job's other appointments are untouched — send the picked value as a plain formatted string through the same `content` field (e.g. `"August 5th at 2pm"`) — the flow already parses natural-language dates, no special payload needed |
| `email_form` | — | Single email field |
| `ended` | — **new** | Conversation is over — see §6. No further input expected |
| `free_text` | — | Normal chat input (default/fallback) |

### Service-link messages — a distinct message shape
Most entries in `messages` (and in `message_complete` events, §4) look like
`{ role, content, created_at }`. When the agent sends the service link, one
entry instead looks like this:
```json
{ "role": "agent", "type": "service_link", "url": "https://app.servicetrade.com/customer/jobsummary?id=...", "job_name": "Fire Extinguisher Inspection", "created_at": 1784819388725 }
```
Render this as a **preview card** (e.g. job name + a "View Job" button), not a
plain text bubble — clicking it should open the full ServiceTrade page (new
tab or full navigation, your call). Entries without a `type` field are always
plain text; check for `type === "service_link"` to distinguish. The agent's
own text never contains the raw URL — it's intentionally never pasted as text.

---

## 4. Sending a message (SSE)

### `POST /chat-links/:token/messages`
```json
{ "content": "Yes" }
```
Response is `Content-Type: text/event-stream`. Event sequence, always in
this order:

1. `event: typing` — `{}` — show a typing indicator immediately.
2. `event: message_delta` (repeated) — `{ "role": "agent", "chunk": "..." }`
   — append each chunk to reveal the agent's reply progressively. **This is a
   simulated typing effect**, not real token streaming — Retell's chat
   completion API returns the complete text; we chunk and pace it out
   server-side. There can be more than one full message per turn (e.g. the
   agent says something, calls a tool, then says something else) — each gets
   its own delta sequence.
3. `event: message_complete` — `{ "role": "agent", "content": "...", "created_at": ... }`
   — the full text of that message, once its chunks are done (use this for
   the canonical stored value; the deltas are purely visual).
4. `event: done` — `{ "state": "...", "input_hint": {...} }` — the
   conversation's state after this turn; swap the input control accordingly.
5. `event: error` — `{ "error": "..." }` — only on failure; the stream ends
   after this instead of `done`.

Don't wait for a message's `role` to filter — every event in this stream is
already `role: "agent"` (the customer's own message isn't echoed back; render
it optimistically the moment the user hits send, same as any chat UI).

---

## 5. Error states to handle

| Response | Meaning | Suggested UI |
|---|---|---|
| `404` | Token doesn't exist at all | "This chat link is no longer valid." |
| `410` `{code:"link_expired"}` | Token existed but its 24h window has passed | "This confirmation link has expired — please contact us to reschedule." Distinct from 404 because it's a much more common case: every link now expires 24h after being sent, and an unopened one is automatically re-queued on a different channel (see below) rather than silently going nowhere. |
| `503` | Token is valid but the company's chat agent isn't provisioned yet | "Chat isn't available for this yet — please call us instead." |

---

## 6. Conversation ending — NEW, frontend action required

**What changed:** the backend now reliably tells you when a conversation is
truly over. Previously, once the agent wrapped up, `state`/`input_hint`
stayed at whatever they last were (e.g. `service_link_sent`/`free_text`)
forever — there was no way to distinguish "still going" from "done," so the
text input never went away even though nothing more would happen.

**What to build:** when a `done` event (SSE, §4) or a `GET` response carries
`state: "chat_ended"` / `input_hint: { "type": "ended" }`, treat the
conversation as terminal:
- Hide or disable the text input / quick-reply buttons.
- Show a short "This conversation has ended." message (or similar) in place
  of the input control.
- No further `POST /chat-links/:token/messages` calls are expected once
  this state is reached — the widget's job for this session is done.

This can now arrive at any point mid-conversation, not just after
inactivity — e.g. right after a customer says "no, that's all" following a
confirmation. A real example `done` payload:
```json
{ "state": "chat_ended", "input_hint": { "type": "ended" } }
```
Note the final turn that reaches this state may carry an **empty**
`messages` array in the SSE response (the agent's last internal step was
just calling its end-of-conversation tool, with no new text to say) — that's
expected, not an error; just apply the terminal `state`/`input_hint` from
the `done` event regardless of whether any `message_complete` events
preceded it in that same turn.

**Also fixed (no frontend change needed, just confirming the contract now
actually holds):** the SSE stream from `POST /chat-links/:token/messages`
was, in one specific case, incorrectly echoing the customer's own
just-sent message back as a `role: "user"` `message_delta`/`message_complete`
event — a violation of §4's documented promise that every event in that
stream is `role: "agent"`. This is now fixed backend-side; no defensive
role-filtering was ever supposed to be necessary on your end, and now it
genuinely isn't.

---

## 7. Not in this build
- Automatic re-engagement — right now a chat link is only ever created when
  staff explicitly click "Send chat link." Wiring `web_chat` into the same
  automatic scheduler/channel-strategy voice and SMS use (e.g. auto-emailing a
  new link when a rescheduled appointment needs reconfirmation) is a separate,
  larger piece of backend work, not yet built.
- Any delivery mechanism (emailing the link, etc.) — link generation only.
- Revoking/rotating a link once shared.
- Rate limiting / abuse protection on the public endpoints.
- Per-appointment confirmation as separate customer turns — confirming the
  remaining appointments is one batch action driven by the single "confirm the
  rest?" question, not a loop the UI walks through.
- A distinct chat state for that "confirm the rest?" turn — it reuses
  `confirmation_accepted` with a context-sensitive `input_hint`.
- A distinct `contact_form` (name/email/phone) input hint for when the
  customer isn't found in the CRM — `collecting_contact_info` currently always
  hints `email_form`; the agent's own message will ask for more details in
  that case and the customer can just type them into free text.
- A known, rare timing edge case: if a link's very first `GET` is somehow
  fired twice at the exact same instant (e.g. a double-mount in dev), one of
  the two responses can come back with an empty `messages` array for that
  single request (the underlying session was still being created) — a normal
  single page load never triggers this, but if it's ever seen, a retry/reload
  resolves it immediately.
