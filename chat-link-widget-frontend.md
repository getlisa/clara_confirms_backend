# Chat links — Frontend Integration Guide

> Covers a **third** way to reach the same conversation flow, alongside voice
> and SMS: a shareable link for a specific job/appointment that opens **our
> own** full-page, ChatGPT-style chat interface — not Retell's widget. This
> sidesteps the SMS A2P approval cost/timeline entirely — no phone number, no
> Retell public key, no Retell script tag on the page at all. The frontend
> talks only to this backend; everything Retell-related (creating the chat
> session, sending messages, reading the transcript) happens server-side.
> Independent of the channel-strategy work in `chat-sms-channel-frontend.md`
> — this isn't part of that automatic voice/SMS resolution, it's a manually
> triggered "send a chat link" action (for now — see §6).

## 0. What shipped (backend)

- `POST /chat-links/appointments/:id` and `POST /chat-links/jobs/:id` —
  authenticated (staff), generates (or reuses) an opaque, unguessable token
  for that specific job/appointment.
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
the same job/appointment returns the same token rather than minting a new one.

**Errors:** `404` if the job/appointment doesn't exist for this company; `422`
if the appointment is cancelled or its time has already passed.

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
    { "role": "agent", "content": "Hi JACK LTR, this is Clara calling from Testing Enterprise. I'm reaching out about the Construction Job #44399940 job scheduled for Thursday, July 23, 2026 at 09:30 AM. Is now a good time to talk?", "created_at": 1784819388725 }
  ],
  "state": "chat_started",
  "input_hint": { "type": "quick_replies", "options": ["Yes", "No", "Reschedule", "Cancel"] }
}
```
`messages` only ever contains real chat turns (`role: "agent" | "user"`) —
internal tool-call/routing plumbing is already filtered out server-side.
Calling this again later (e.g. the customer reopens the link) resumes the
same conversation and returns the full history, not a fresh greeting.

### State reference
| State | Meaning |
|---|---|
| `chat_started` | Greeting sent, awaiting the customer's initial decision |
| `confirmation_accepted` | Customer confirmed the appointment |
| `collecting_contact_info` | Agent is resolving/collecting a contact for the service link |
| `service_link_sent` | Service link emailed + pasted into the chat |
| `reschedule_needed` | Customer wants to reschedule, no date picked yet |
| `reschedule_pending_confirmation` | New date picked and applied — needs reconfirmation later |
| `canceled` | Customer canceled |
| `chat_ended` | Session closed (inactivity timeout) |

### `input_hint` reference — what to render for the next input
| `type` | Fields | Render |
|---|---|---|
| `quick_replies` | `options: string[]` | Buttons instead of a text box — send the clicked label as `content` |
| `date_picker` | `min`, `max` (YYYY-MM-DD) | Calendar/time picker constrained to before the job/appointment's due date — send the picked value as a plain formatted string through the same `content` field (e.g. `"August 5th at 2pm"`) — the flow already parses natural-language dates, no special payload needed |
| `email_form` | — | Single email field |
| `free_text` | — | Normal chat input (default/fallback) |

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
| `404` | Token doesn't exist (or expired, once expiry is used) | "This chat link is no longer valid." |
| `503` | Token is valid but the company's chat agent isn't provisioned yet | "Chat isn't available for this yet — please call us instead." |

---

## 6. Not in this build
- Automatic re-engagement — right now a chat link is only ever created when
  staff explicitly click "Send chat link." Wiring `web_chat` into the same
  automatic scheduler/channel-strategy voice and SMS use (e.g. auto-emailing a
  new link when a rescheduled appointment needs reconfirmation) is a separate,
  larger piece of backend work, not yet built.
- Any delivery mechanism (emailing the link, etc.) — link generation only.
- Link expiry — the schema supports it (`expires_at`), but nothing sets it yet.
- Revoking/rotating a link once shared.
- Rate limiting / abuse protection on the public endpoints.
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
