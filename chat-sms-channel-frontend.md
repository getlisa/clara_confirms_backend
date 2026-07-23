# SMS/Chat channel for end-customer calls — Frontend Integration Guide

> Covers the frontend surfaces for the new **SMS/chat channel**: outbound
> customer confirmation, quotation follow-up, and service-opportunity
> follow-up calls can now go out as a text conversation instead of (or as a
> fallback to) a voice call, using the exact same conversation logic. Everything
> here is additive — every company defaults to voice-only, unchanged from today.

## 0. What shipped

Four scenarios, one mechanism:
1. **No-answer fallback** — a voice call isn't picked up → the next retry goes
   out as SMS instead.
2. **SMS-only companies** — a company can go text-only for every outbound
   attempt.
3. **Per-customer preference** — an individual customer can be pinned to voice
   or SMS regardless of the company default.
4. **Callback → chat** — when a customer says "call me back later," the
   follow-up can go out as a text instead of another phone call.

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

## 2. Per-customer override — `customers`

### `GET /customers/:id` / `PATCH /customers/:id`
```json
{ "preferred_channel": null }
```
`preferred_channel`: `"voice"` | `"sms"` | `null` (null = use the company's
`channel_strategy`). `PATCH` rejects any other value with `400`.

**Suggested UI:** a dropdown on the customer detail page — *"Use company
default"* / *"Always call"* / *"Always text"*. This overrides the company
strategy for that customer on every future attempt (subject to the same SMS
readiness gate — if SMS isn't live, "Always text" has no effect yet).

---

## 3. Manual actions — "Call Now" vs "Text Now"

### `POST /calls/manual`
New optional field:
```json
{ "trigger_type": "scheduled_unconfirmed", "appointment_id": 123, "channel": "sms" }
```
`channel`: `"voice"` | `"sms"` (omit to let the backend resolve it the same way
the scheduler would). When the frontend already shows two distinct buttons,
send the explicit value — it always wins over any per-customer/company default.

---

## 4. Activity/timeline rendering

`channel` (`"voice"` | `"sms"`, default `"voice"`) is now present on:
- `GET /calls`, `GET /calls/:id`
- `GET /scheduled-calls`
- `GET /todos`

Suggest a small 📞/💬 indicator wherever these lists render. No other schema
change — a chat's `transcript` field is a **plain string** transcript (not the
array-of-turns / tool-call-annotated shape some voice transcript viewers may
assume); if there's a transcript viewer that renders raw structure, make sure
it degrades gracefully for a plain-text chat transcript.

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
