# SMS/Chat channel for end-customer calls — Frontend Integration Guide

> Covers the frontend surfaces for the new **SMS/chat channel**: outbound
> customer confirmation, quotation follow-up, and service-opportunity
> follow-up calls can now go out as a text conversation instead of (or as a
> fallback to) a voice call, using the exact same conversation logic. Everything
> here is additive — every company defaults to voice-only, unchanged from today.

## 0. What shipped

Four scenarios, one mechanism:
1. **No-answer fallback** — once **every** voice retry is exhausted with no
   answer (not after the first miss), a single chat-link confirmation goes
   out instead, if the customer has `is_sms`/`is_email` on file.
2. **SMS-only companies** — superseded by per-customer channel flags (§2) —
   set every customer's `is_sms`/`is_email` instead of a company-wide setting
   to go text/email-first.
3. **Per-customer channels** — a customer can be voice-only, link-only
   (sms/email, alone or together), or voice-with-link-fallback (§2).
4. **Callback → voice** — when a customer says "call me back later," the
   follow-up is always another phone call — a callback only ever happens
   because the customer was just on a live voice call in the first place.

**Important caveat — read this first:** SMS is **not instantly available**.
Retell requires A2P 10DLC approval for a company's number to send/receive SMS,
which is a real compliance process taking **2–3+ weeks per company**, driven
manually (ops confirms approval, then flips a status flag — there's no
programmatic "is it ready yet" check). Until that status is `live` for a
company, **every** channel setting silently behaves as voice-only server-side
(a safety net) — so the UI must not let a company pick an SMS-dependent option
before it's actually ready; it would look like it worked but nothing would
change.

---

## Scope — what the frontend needs to build

**Required:**
- **Channel strategy setting + callback toggle** on the Call Settings page (§1).
- **SMS readiness indicator** wherever channel settings are shown, and used to
  gate the above (§1).
- **Per-customer override** on the customer detail page (§2).
- **"Call Now" vs "Text Now"** wherever `POST /calls/manual` is already wired (§3).

**Optional (nice-to-have):**
- A 📞/💬 channel indicator on call/todo/scheduled-call list views (§4).
- Rendering a chat transcript differently from a voice transcript (§4).

**NOT needed — handled entirely server-side:**
- Anything about *how* the conversation flows once started — same flow, same
  prompts, same tools as voice. The frontend doesn't need to know a chat
  session is happening any differently than a call, except for what's below.
- Deciding channel automatically for the four scenarios — the backend resolves
  this on every attempt; the frontend only sets preferences/overrides.

---

## 1. Channel strategy — `call_settings`

**Superseded for customer confirmations by §2's per-customer flags** — those
are now authoritative whenever a customer record exists. `channel_strategy`
remains as: the seed value for brand-new customers, and the fallback for call
types with no customer row to read flags from (e.g. quotation follow-up
targets without a linked customer). Keep the setting and its UI; just don't
expect changing it to move an existing customer's channel — Section 2 does.

Two new fields alongside the existing toggles (`service_link_enabled`,
`crm_comment_writeback_enabled`, etc.) on the same object.

### `GET /call-settings` / `PATCH /call-settings`
```json
{
  "channel_strategy": "voice_only",
  "sms_on_callback_enabled": false
}
```

| Field | Type | Values | Default |
|---|---|---|---|
| `channel_strategy` | string | `"voice_only"` \| `"sms_only"` \| `"voice_then_sms_fallback"` | `"voice_only"` |
| `sms_on_callback_enabled` | boolean | — | `false` |

**Suggested UI:** a 3-option select for `channel_strategy` —
*"Voice only"* / *"Text only"* / *"Voice, then text if no answer"* — plus a
separate toggle *"When a customer asks for a callback, follow up by text"* for
`sms_on_callback_enabled`. `PATCH` rejects invalid values with `400`.

**Gating on SMS readiness (important):** disable `"sms_only"` and
`"voice_then_sms_fallback"` in the select (and disable the callback toggle)
whenever the company's `sms_status` (see below) isn't `"live"`. The backend
will silently fall back to voice regardless, but the UI should prevent
selecting a state that looks configured but does nothing.

### SMS readiness — `GET /company` / `PATCH /company`
`company` now includes:
```json
{
  "sms_status": "not_configured",
  "chat_provisioned": true
}
```
| Field | Type | Values | Meaning |
|---|---|---|---|
| `sms_status` | string | `"not_configured"` \| `"pending_approval"` \| `"live"` | ops-controlled rollout state — see §0 caveat |
| `chat_provisioned` | boolean | — | whether Retell's chat-agent side is set up (informational; doesn't mean SMS can send) |

**Suggested UI:** a read-only pill next to the channel-strategy setting —
*"Not configured"* (gray) / *"Pending approval"* (amber) / *"Live"* (green).
`sms_status` is also `PATCH`-able (an ops/internal action, not something a
regular company admin should self-serve — gate this behind whatever
internal/admin surface makes sense; the backend doesn't currently restrict it
by role, so that gate needs to live in the frontend or be added later).

---

## 2. Per-customer channels — `customers`

**Breaking change:** `preferred_channel` is gone (migration 080). It's
replaced by three independent booleans, because a customer can now want more
than one channel at once — e.g. "text and email me" — which a single-valued
field couldn't express.

### `GET /customers/:id` / `PATCH /customers/:id`
```json
{ "is_voice": true, "is_sms": false, "is_email": false }
```
| Field | Type | Default | Meaning |
|---|---|---|---|
| `is_voice` | boolean | `true` | Reach this customer with a real phone call. |
| `is_sms` | boolean | `false` | Reach this customer by texting a confirmation link. |
| `is_email` | boolean | `false` | Reach this customer by emailing a confirmation link. |

**Combination rule — not a free-for-all:**
- `is_voice = true` → **voice only**, until every voice retry is exhausted.
  `is_sms`/`is_email` are then used as a one-time fallback — they never fire
  *alongside* a live voice attempt.
- `is_voice = false` → `is_sms` and `is_email` fire **simultaneously** (both
  are just delivery methods for the same chat-link confirmation — there's
  nothing to conflict).

**At least one flag must be true.** `PATCH` returns `400` if the resulting
state (existing values merged with whatever you send) would leave all three
false — a customer needs at least one contact channel. The error message
names the rule, so it's safe to surface directly.

**Suggested UI:** three checkboxes/toggles on the customer detail page —
*"Call"* / *"Text"* / *"Email"* — with the mutual-exclusivity rule enforced
in copy, not by disabling checkboxes (e.g. a note: "Text and Email are only
used if Call is off, or after we've tried calling and gotten no answer").
`is_sms` is still subject to the same SMS-readiness gate as before — if the
company's SMS isn't `"live"`, an `is_sms`-only customer degrades to voice
server-side (never silently to nothing).

---

## 3. Manual actions — "Call Now" / "Text Now" / "Email Now"

### `POST /calls/manual`
New optional field:
```json
{ "trigger_type": "scheduled_unconfirmed", "appointment_id": 123, "channel": "sms" }
```

> **The conversation is job-scoped.** `appointment_id` identifies the trigger, but the agent discusses every upcoming appointment on the parent job and confirms the **next** one first — which may not be the appointment you passed, if a sooner one exists on the same job. It also offers to confirm the remaining appointments before ending.

`channel`: `"voice"` | `"sms"` | `"web_chat"` (omit to let the backend resolve
it the same way the scheduler would). When the frontend already shows
distinct buttons, send the explicit value — it always wins over any
per-customer/company default.

**`"web_chat"` — "Email Now":** instead of dialing/texting, this sends the
customer a link to the same stateful chat interface from
`chat-link-widget-frontend.md`, by whichever medium the company's
`chat_link_delivery_method` setting specifies (`chat-sms-channel-frontend.md`
§1 / `web-chat-dispatch-frontend.md` §1):
- `"email"`: emails the link (SendGrid).
- `"sms"`: texts the link (Twilio) — a plain text with the URL, **not** the
  conversational Retell "Text Now" feature (`createSmsChat`) used elsewhere.
  No Retell SMS/A2P dependency for this leg.
- `"both"`: sends both, independently.

It has no SMS/A2P dependency at all, for any delivery method — that's the
whole point of this channel. On success:
```json
{ "ok": true, "emailSent": true, "smsSent": false, "chatLinkToken": "3a90f7a5…", "dialed": false, "retellCallId": null }
```
`dialed`/`retellCallId` stay `false`/`null` for this channel regardless of
delivery method — that's normal, not a failure, they only ever apply to
voice/SMS-conversation channels. Use `emailSent`/`smsSent`/`chatLinkToken`
instead to know what went out (note: both booleans reflect the row
completing, not a per-medium delivery receipt — a coarse signal, same as the
existing single-medium behavior). If the customer is missing the contact
info the configured delivery method needs, this returns a 422:
```json
{ "ok": false, "status": 422, "code": "missing_email", "subject": "customer", "error": "No customer email on file. Pass email to send a chat-link confirmation to a specific address." }
```
`code` is `"missing_email"` (method `"email"`), `"missing_phone"` (method
`"sms"`, mirrors the existing voice/SMS `missing_phone` code), or
`"missing_contact_info"` (method `"both"`, neither email nor phone on file).

**Important — this will be the common case, not the exception:** for
ServiceTrade-synced customers, `customers.email` is essentially always empty
(the real email lives on a separate ServiceTrade *Contact*, which isn't
synced into this table) — the same way a meaningful fraction of customers
have no phone either. **Don't just show a dead-end error** — the same
`phone_number`/`email` override fields "Call Now"/"Text Now" already support
work here too:
```json
{ "trigger_type": "scheduled_unconfirmed", "appointment_id": 123, "channel": "web_chat", "email": "jack@example.com", "phone_number": "+15551234567" }
```
Pass whichever the configured delivery method needs (or both, for `"both"`).
When present, this sends to that address/number for this one confirmation —
it does **not** get written back to the customer record (a one-time
override, not a data edit). Suggested UI: on `missing_email`/`missing_phone`/
`missing_contact_info`, prompt for the address/number inline and resubmit
with it, rather than a bare error toast — this is the expected happy path
for a lot of real customers, not a rare failure.

---

## 4. Activity/timeline rendering

`channel` (`"voice"` | `"sms"` | `"web_chat"`, default `"voice"`) is now
present on:
- `GET /calls`, `GET /calls/:id`
- `GET /scheduled-calls` — also includes `chat_link_token` for `"web_chat"`
  rows (see `web-chat-dispatch-frontend.md` §3 for what a `"web_chat"` row
  looks like while the link is still unopened — that's expected, not stuck).
- `GET /todos`

Suggest a small 📞/💬/✉️ indicator wherever these lists render. No other
schema change — a chat's `transcript` field is a **plain string** transcript
(not the array-of-turns / tool-call-annotated shape some voice transcript
viewers may assume); if there's a transcript viewer that renders raw
structure, make sure it degrades gracefully for a plain-text chat transcript
(and for `"web_chat"` rows, there may be no transcript at all until the
customer actually opens the link).

---

## 5. Not in this build
- SMS enablement itself is an operational process (A2P approval), not a
  frontend flow — there's no "request SMS approval" button to build.
- Technician confirmation calls remain voice-only — no channel controls for
  the technician-facing trigger.
- Inbound SMS handling (a customer texting in cold) — replies to an existing
  conversation "just work" via Retell; there's nothing to build for it here.
- A resend/retry button for a specific chat message — retries/fallbacks are
  handled by the same automatic scheduling as voice.
