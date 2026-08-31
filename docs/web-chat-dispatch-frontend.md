# Automatic email confirmation via chat link — Frontend Integration Guide

> Covers a new **automatic dispatch channel**: instead of placing a voice call
> (or texting through Retell's SMS agent), the scheduler can now email a
> customer a link to the same stateful web-chat interface documented in
> `chat-link-widget-frontend.md`. The customer clicks the link, confirms/
> reschedules/cancels through that exact same chat UI, and the agent captures
> the outcome — no new conversation logic, only a new **automatic trigger**
> for it. Everything here is additive — every company defaults to
> `voice_only`, unchanged from today.

## 0. What shipped

- A third `channel_strategy` value, **`web_chat_only`** — when set, the
  scheduler's confirmation sweep (the same one that already places voice/SMS
  confirmation calls) emails the customer a chat link instead of dialing.
  Unlike SMS, this has **no A2P approval dependency at all** — it works the
  moment a company's email is configured (which it already is, SendGrid is
  already live for invite emails).
- A **contact-completeness check**: dispatch requires the customer to have an
  email on file. If missing, nothing is sent — a `MISSING_EMAIL` todo is
  created instead (mirrors the existing `MISSING_PHONE` todo you already
  handle), so a human fills in the email and the next scheduled sweep picks
  it up automatically.
- A **48-hour unopened-link watchdog** — if the emailed link is never opened,
  the system automatically falls back to a voice attempt. No frontend action
  needed for this; it's fully automatic, but see §3 for how it shows up in
  activity views.

---

## Scope — what the frontend needs to build

**Required:**
- A way to select `"web_chat_only"` in whatever UI already renders the
  `channel_strategy` select from `chat-sms-channel-frontend.md` §1 (§1 below).
- Handle the new `MISSING_EMAIL` todo type wherever `MISSING_PHONE` is already
  handled (§2).

**Optional (nice-to-have):**
- Show `"web_chat"` as a third channel option (alongside voice/SMS) in
  activity/timeline views, and surface the chat-link token so staff can open
  it themselves if needed (§3).

**NOT needed — handled entirely server-side:**
- The actual chat conversation the customer has after clicking the link —
  that's the exact same `GET/POST /chat-links/:token` contract already built;
  nothing new to build there.
- Deciding when to fall back to voice after an unopened link — fully
  automatic (§0).

---

## 1. Channel strategy — `call_settings`

Extends the existing select from `chat-sms-channel-frontend.md` §1 — same
fields, one more valid value, plus one new field:

### `GET /call-settings` / `PATCH /call-settings`
```json
{
  "channel_strategy": "web_chat_only",
  "chat_link_delivery_method": "email"
}
```

| Field | Type | Values | Default |
|---|---|---|---|
| `channel_strategy` | string | `"voice_only"` \| `"sms_only"` \| `"voice_then_sms_fallback"` \| `"web_chat_only"` | `"voice_only"` |
| `chat_link_delivery_method` | string | `"email"` \| `"sms"` \| `"both"` | `"email"` |

**Suggested UI:** add a 4th option to the existing `channel_strategy` select —
*"Chat link"* — with a sub-picker for `chat_link_delivery_method`. All three
values send the **same link** to the stateful `chat_links` web UI — no live
session until the customer actually opens it, regardless of medium:
- `"email"` emails the link (SendGrid).
- `"sms"` texts the link (Twilio) — a plain text message containing the URL,
  **not** the conversational Retell "Text Now" feature (`createSmsChat`) used
  elsewhere in the product. No Retell SMS/A2P approval needed for this — it's
  a separate, independent send.
- `"both"` sends both, independently (send whichever the customer has
  contact info for; if only one is present, that one goes out — not
  all-or-nothing).

`web_chat_only` has **no SMS/A2P dependency at all**, for any
`chat_link_delivery_method` value — that's the whole point of this channel
strategy.

---

## 2. Contact-completeness — `MISSING_EMAIL` / `MISSING_PHONE` todo

When `channel_strategy` is `web_chat_only` and a customer due for
confirmation is missing the contact info their company's
`chat_link_delivery_method` requires, dispatch is skipped and a todo is
created instead:
- `chat_link_delivery_method: "email"` and no email on file → `MISSING_EMAIL`.
- `chat_link_delivery_method: "sms"` and no phone on file → `MISSING_PHONE`
  (same todo type/shape as the existing voice/sms one, distinguished by its
  `notes` text mentioning the chat rather than a call).
- `chat_link_delivery_method: "both"` and *neither* email nor phone is on
  file → `MISSING_EMAIL` (if only one is missing, dispatch proceeds using
  whichever contact info is present — no todo).

### `GET /todos`
```json
{
  "id": 162,
  "type": "MISSING_EMAIL",
  "status": "open",
  "priority": "high",
  "notes": "Customer email not provided — confirmation chat link could not be sent.",
  "customer": { "id": 82449, "name": "Jane Doe", "phone": "+15551234567", "email": null },
  "job_id": "19123",
  "job_name": "WEBCHAT DISPATCH TEST"
}
```
**Suggested UI:** same treatment as `MISSING_PHONE` — surface it in the todos
list with a label like *"Missing email"*, and the resolution action is
editing the customer's email (`PATCH /customers/:id`, already-existing route,
already accepts `email`). Once filled in, the next scheduler sweep dispatches
automatically — no "retry" button needed, and re-opening the same todo won't
duplicate (the backend re-uses the existing open todo for the same job).

---

## 3. Activity/timeline rendering (optional)

`channel` (`chat-sms-channel-frontend.md` §4) now has a third possible value,
`"web_chat"`, on:
- `GET /scheduled-calls` — now also includes `chat_link_token` (string or
  `null`) alongside `channel`. One shared token regardless of
  `chat_link_delivery_method` — email and/or SMS just deliver the same
  link by different media. While the link is unopened, `retell_call_id` is
  `null` and `status` is `"completed"` (the email/text went out) — this is
  expected, not a stuck/broken state. Build the URL as
  `${FRONTEND_BASE_URL}/chat/${chat_link_token}` if you want to let staff
  open the link themselves (same pattern the existing "Send chat link"
  action already uses).
- `GET /todos` — a todo tied to a web_chat scheduled call still shows
  `channel: "web_chat"` the same way voice/SMS ones show their channel today.

If the link goes unopened for 48 hours (regardless of delivery method), the
system automatically schedules a voice fallback attempt — you'll see the
original `scheduled_calls` row flip to `status: "failed"`,
`failure_reason: "chat_link_unopened"`, and a new row appear with
`channel: "voice"`, `call_priority: "retry"`. No action needed; a 📞 icon on
the new row communicates what happened if you want to make it visible.

---

## 4. Not in this build
- A manual "send chat-link confirmation now" button — that's covered by the
  separate `POST /jobs/bulk-send-confirmation` request in
  `frontend-requested-changes-v2.md` §3, not part of this automatic-dispatch
  feature.
- Any change to the chat conversation itself — see
  `chat-link-widget-frontend.md`, untouched by this feature.
