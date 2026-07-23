# Shareable chat-widget links — Frontend Integration Guide

> Covers a **third** way to reach the same conversation flow, alongside voice
> and SMS: a shareable link for a specific job/appointment that opens a web
> chat interface (Retell's embeddable chat widget). This sidesteps the SMS
> A2P approval cost/timeline entirely — no phone number involved at all.
> Independent of the channel-strategy work in `chat-sms-channel-frontend.md`;
> this isn't part of that automatic voice/SMS resolution, it's a manually
> triggered "send a chat link" action.

## 0. What shipped (backend)

- `POST /chat-links/appointments/:id` and `POST /chat-links/jobs/:id` —
  authenticated (staff), generates (or reuses, if one already exists) an
  opaque, unguessable token for that specific job/appointment.
- `GET /chat-links/:token` — **public, no auth** — the token itself is the
  credential. Resolves the company's chat agent + the same job/appointment
  context (customer name, job name, dates, etc.) that voice/SMS calls use.
  CORS is intentionally wide-open on this one route only, since it's meant to
  be fetched from an anonymous customer's browser, potentially on a different
  domain than this API.

The chat itself runs via Retell's own embeddable **Chat Widget** — a single
script tag that calls Retell directly from the browser (no backend proxy for
the actual conversation once the page has the agent id + context).

---

## 1. What the frontend needs to build

1. A **"Send chat link"** action somewhere on the job/appointment views —
   calls `POST /chat-links/appointments/:id` (or `/jobs/:id`), gets back a
   `token`, and builds a shareable URL:
   `https://<your-frontend-domain>/chat/<token>`.
   **Delivery is out of scope for this backend feature** — how that URL
   reaches the customer (copy/paste, email, etc.) is a frontend/product
   decision, not something the backend sends.
2. A **chat page** at that route (`/chat/:token`) which, on load:
   - Calls `GET /chat-links/:token` against this API.
   - On success, renders Retell's chat widget using the returned `chat_agent_id`
     and `dynamic_variables`.
   - On `404`/`503`, shows an appropriate message (see §4).

---

## 2. Generating a link

### `POST /chat-links/appointments/:id`
### `POST /chat-links/jobs/:id`
Standard JWT auth (same as every other authenticated route). Optional body:
```json
{ "call_type": "customer_confirmation" }
```
`call_type` defaults to `"customer_confirmation"` if omitted — this is what
routes the conversation to the right subagent in the shared flow, same as the
`call_type` dynamic variable used for voice/SMS.

**Response `201`:**
```json
{ "token": "a4fce883dac4f97f82e182d1bc4451fce5e3964a27d68f99" }
```
Calling this again for the same job/appointment returns the **same token**
(idempotent) rather than minting a new one each time.

**Errors:** `404` if the job/appointment doesn't exist for this company; `422`
if the appointment is cancelled or its time has already passed (mirrors the
same validation `POST /calls/manual` already does).

---

## 3. Resolving a link (the public chat page calls this)

### `GET /chat-links/:token`
No auth header needed or expected — this is fetched from an anonymous
customer's browser.

**Response `200`:**
```json
{
  "ok": true,
  "chat_agent_id": "agent_f4a587a207f9f069dc01c7a3ae",
  "company_name": "Testing Enterprise",
  "job_name": "Construction Job #44399940",
  "customer_name": "JACK LTR",
  "dynamic_variables": {
    "call_type": "customer_confirmation",
    "customer_name": "JACK LTR",
    "customer_address": "7890 Jane Street, Vaughan, ON",
    "job_name": "Construction Job #44399940",
    "job_type": "construction",
    "job_date": "Thursday, July 23, 2026 at 09:30 AM",
    "appointment_id": "28976",
    "job_id": "6511"
  }
}
```
`dynamic_variables` is exactly the shape to hand to the chat widget's dynamic
context (§4) — same field names as voice/SMS use, so the shared conversation
flow behaves identically regardless of channel.

---

## 4. Embedding the widget

Retell's embeddable chat widget needs only a script tag — no chat backend
code to write on the frontend beyond wiring the two values above in:

```html
<script
  id="retell-widget"
  src="https://dashboard.retellai.com/retell-widget-v2.js"
  type="module"
  data-public-key="YOUR_RETELL_PUBLIC_KEY"
  data-agent-id="agent_f4a587a207f9f069dc01c7a3ae"
  data-dynamic='{"call_type":"customer_confirmation","customer_name":"JACK LTR", ...}'
></script>
```

- `data-public-key` — a **Retell Public Key**, obtained from the Retell
  dashboard's Public Keys settings. This is account-wide (not per-company —
  the `agent_id` is what scopes the conversation to the right company/agent),
  safe to ship client-side by design (distinct from the private API key), and
  needs to be set once as a frontend env var (e.g. `RETELL_PUBLIC_KEY`) — not
  something this backend serves.
- `data-agent-id` — the `chat_agent_id` from §3's response.
- `data-dynamic` — the `dynamic_variables` object from §3's response,
  JSON-stringified.
- Optional styling/behavior attributes (`data-title`, `data-color`,
  `data-auto-open`, etc.) are documented at
  `https://docs.retellai.com/deploy/chat-widget` if the page wants a custom look.

**One thing to verify once you have a public key:** Retell's own widget docs
don't explicitly confirm compatibility with a Conversation-Flow-based chat
agent (vs. a plain `retell-llm` one) — our chat agent *is* Conversation-Flow
based (deliberately, so it shares the exact voice flow). This was verified to
work correctly through Retell's REST chat API directly in backend testing,
but not yet through the widget's client-side path specifically — worth a
quick smoke test the first time this is wired up.

---

## 5. Error states to handle

| Response | Meaning | Suggested UI |
|---|---|---|
| `404` | Token doesn't exist (or has expired, once expiry is used) | "This chat link is no longer valid." |
| `503` | Token is valid but the company's chat agent isn't provisioned yet | "Chat isn't available for this yet — please call us instead." |

---

## 6. Not in this build
- Link expiry — the schema supports it (`expires_at`), but nothing sets it
  yet; every link is currently valid indefinitely until manually cleaned up.
- Revoking/rotating a link once shared.
- Any delivery mechanism (emailing the link, etc.) — link generation only.
- Rate limiting / abuse protection on the public resolve endpoint.
