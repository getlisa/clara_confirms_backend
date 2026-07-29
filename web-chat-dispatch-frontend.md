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
*"Chat link (email)"*. **Important:** only `chat_link_delivery_method: "email"`
is actually implemented server-side right now — `"sms"` and `"both"` are
accepted by the API (so you can build the 3-option control now without
another backend round-trip later) but currently dispatch by email regardless
of what's selected, with a warning logged server-side. Either hide `"sms"`/
`"both"` from the picker for now, or show them with a "coming soon" note —
your call; just don't imply they already work.

Unlike `sms_only`/`voice_then_sms_fallback`, **`web_chat_only` does not need
the `sms_status: "live"` gate** from `chat-sms-channel-frontend.md` §1 — it
has no SMS/A2P dependency, so don't disable it behind that same readiness
check.

---

## 2. Contact-completeness — `MISSING_EMAIL` todo

When `channel_strategy` is `web_chat_only` and a customer due for
confirmation has no email on file, dispatch is skipped and a todo is created
instead — same shape and lifecycle as the existing `MISSING_PHONE` todo you
already render.

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
  `null`) alongside `channel`. While the link is unopened, `retell_call_id` is
  `null` and `status` is `"completed"` (the email went out) — this is
  expected, not a stuck/broken state. If you want to let staff open the link
  themselves from this view, build the URL as
  `${FRONTEND_BASE_URL}/chat/${chat_link_token}` (same pattern the existing
  "Send chat link" action already uses).
- `GET /todos` — a todo tied to a web_chat scheduled call still shows
  `channel: "web_chat"` the same way voice/SMS ones show their channel today.

If an emailed link goes unopened for 48 hours, the system automatically
schedules a voice fallback attempt — you'll see the original `scheduled_calls`
row flip to `status: "failed"`, `failure_reason: "chat_link_unopened"`, and a
new row appear with `channel: "voice"`, `call_priority: "retry"`. No action
needed; a 📞 icon on the new row communicates what happened if you want to
make it visible.

---

## 4. Not in this build
- SMS delivery of the chat link — schema/setting accepts it (§1), dispatch
  code doesn't implement it yet.
- A manual "send chat-link confirmation now" button — that's covered by the
  separate `POST /jobs/bulk-send-confirmation` request in
  `frontend-requested-changes-v2.md` §3, not part of this automatic-dispatch
  feature.
- Any change to the chat conversation itself — see
  `chat-link-widget-frontend.md`, untouched by this feature.
