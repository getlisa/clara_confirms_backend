# Call & Chat Notification Emails — Frontend Guide

> **For the frontend agent.** A new settings surface (notification recipients with
> per-recipient outcome filters) plus a recording player on the call detail view.
> Same conventions as `daily-report-frontend.md`.

Base URL: `VITE_API_URL` · Auth: `Authorization: Bearer <token>` on every endpoint
below unless marked otherwise.

---

## 0. What shipped, and why

Ultimate Fire Protection will not let the outbound agent go live until **every
outbound call recording and transcript is reviewable** (CMAP-224). CMAP-226 is the
delivery mechanism: an email after each conversation carrying the recording,
transcript and summary.

So there are two new things:

1. **Notification emails** — after each outbound call/chat, an email to whichever
   addresses a company nominates. Each address chooses **which outcomes** are
   worth an email to them. The recording rides along as a **playable audio
   attachment**.
2. **A recording player in the portal** — `calls.recording_url` did not exist
   before this; Retell sent it on every call and the backend discarded it. It is
   now stored, and served through a proxy endpoint (§7).

Both are **off by default**. Every one of the 13 existing companies has
`enabled: false` and zero recipients, so nothing emails until someone opts in.

---

## 1. `GET /call-notifications` 🔒 — the whole settings card in one request

**Response `200`**
```json
{
  "settings": { "enabled": false },
  "recipients": [
    {
      "id": 7,
      "company_id": 8,
      "email": "erica@ultimatefire.test",
      "name": "Erica",
      "events": ["confirmed", "reschedule_requested", "cancellation_requested", "not_picked"],
      "enabled": true,
      "created_at": "2026-09-29T10:00:00.000Z",
      "updated_at": "2026-09-29T10:04:00.000Z"
    }
  ],
  "available_events": [
    { "key": "confirmed",              "label": "Appointment confirmed",  "description": "The customer confirmed the visit." },
    { "key": "reschedule_requested",   "label": "Reschedule requested",   "description": "The customer asked to move the visit." },
    { "key": "cancellation_requested", "label": "Cancellation requested", "description": "The customer asked to cancel the visit." },
    { "key": "appointment_needed",     "label": "Appointment needed",     "description": "No visit is booked yet and the customer gave no preferred time." },
    { "key": "unconfirmed",            "label": "Ended unconfirmed",      "description": "The customer answered but nothing was settled either way." },
    { "key": "voicemail",              "label": "Reached voicemail",      "description": "Voicemail picked up instead of a person." },
    { "key": "not_picked",             "label": "No answer / no reply",   "description": "Nobody picked up, or an SMS conversation got no reply." }
  ]
}
```

| field | note |
|---|---|
| `settings.enabled` | the company-wide master switch. While `false`, **nothing sends**, no matter what the recipient rows say. |
| `events` | the outcomes THIS recipient wants. Order is canonical, not insertion order — safe to compare two recipients' arrays directly. |
| `enabled` | **defaults to `false` on creation.** A new recipient never fires until explicitly turned on — see §3. |
| `available_events` | **render your checkboxes from this, not a hardcoded list.** Adding an event key server-side then needs no frontend release. |

**Render the card from this one call.** Don't assemble it from `/call-settings`.

---

## 2. `PATCH /call-notifications` 🔒 — the master switch

**Request** `{ "enabled": true }` → **`200`** `{ "settings": { "enabled": true } }`
**`400`** `{ "error": "enabled must be a boolean" }`

`call_notification_enabled` also appears in `GET /call-settings` because it lives
on that table — but **`PATCH /call-settings` will not accept it.** That route
whitelists its fields by explicit destructuring and this one is deliberately left
out, so there is a single write path for what is a live mailing list. Write it
here; read it from either.

---

## 3. Recipients CRUD 🔒

### `POST /call-notifications/recipients`
```json
{ "email": "erica@ultimatefire.test", "name": "Erica", "events": ["confirmed", "not_picked"] }
```
`name` and `events` are optional — **`events` omitted means all seven.**
`enabled` is **not accepted here**: every recipient is created disabled, and turned
on with a separate `PATCH` once reviewed.

**`201`** `{ "recipient": { ... } }`
**`400`** `{ "error": "A valid email is required" }`
**`400`** `{ "error": "Unknown event key(s): confrimed. Valid keys: confirmed, reschedule_requested, ..." }`
**`409`** `{ "error": "A recipient with this email already exists" }`

Note the 400 on a bad event key: unknown keys are **rejected, not dropped**. A
typo'd key stored silently would leave someone subscribed to nothing while the UI
showed the row as saved — indistinguishable from the feature being broken.
Duplicate detection is **case-insensitive** (`Erica@…` collides with `erica@…`).

### `PATCH /call-notifications/recipients/:id`
Any subset of `email`, `name`, `events`, `enabled`. This is how a recipient is
turned on:
```json
{ "enabled": true }
```
**`200`** `{ "recipient": { ...updated } }` · **404** if not found · **409** duplicate · **400** bad email / bad event key.

### `DELETE /call-notifications/recipients/:id`
`{ "message": "Deleted" }` · **404** if not found.

---

## 4. `POST /call-notifications/test` 🔒 — ⚠️ sends a real email

**Request** `{ "recipient_id": 7, "call_id": 142 }` — `call_id` optional; defaults to
the company's most recent analyzed call, preferring a **voice** call that has a
recording (a chat has no recording, which would make the test silent about the
very thing it exists to prove).

**Response `200`**
```json
{
  "ok": true,
  "sent_to": "erica@ultimatefire.test",
  "call_id": 142,
  "subject": "Clara Confirms · Outbound call — Ultimate Fire — Confirmed",
  "recording_attached": true,
  "attachment_bytes": 1842176,
  "recording_note": null
}
```
**`422`** `{ "error": "No analyzed call to send yet. Place a call first, or pass a call_id." }`

**Surface `recording_attached` and `recording_note` in the UI** — they are the
answer to "did the audio actually make it?", which is the point of the test. When
`recording_attached` is `false`, `recording_note` says why in plain language
(e.g. *"Recording is 94.4 MB, over the 12 MB email limit"*).

This **delivers an actual email with the actual attachment** to the recipient's
address. Label the button accordingly ("Send test now", with a confirm step) — not
as a harmless preview. It is deliberately repeatable and never consumes a real
notification.

---

## 5. `GET /call-notifications/history/:retell_call_id` 🔒

Delivery history for one conversation — useful on the call detail view.
```json
{ "sends": [
  { "id": 1, "email": "erica@ultimatefire.test", "event": "confirmed",
    "status": "sent", "attempts": 1, "recording_attached": true,
    "attachment_bytes": 1842176, "sent_at": "2026-09-29T15:01:12.000Z",
    "last_error": null, "next_attempt_at": "2026-09-29T15:00:05.000Z" }
] }
```
`status` is `pending` | `sent` | `failed`. See §6 for what `pending` means.

---

## 6. Delivery is ~1 minute behind the call, by design

The webhook only **queues**; a one-minute cron fetches the recording and sends.

This is not laziness — Retell types `recording_url` as optional and its S3 object
can lag the `call_analyzed` webhook by moments. Fetched inline, that lag would
cost the audio on that email *permanently*. Queued, it simply retries.

**What this means for your copy:**

- Say *"emailed shortly after each call"*, **not** "instantly".
- A `status: "pending"` row is normal for the first minute or two, and can stay
  pending for up to **~15 minutes** if the recording is slow to appear (retries at
  +1, +3, +7, then send at +15). Render it as *"Sending…"*, not as an error.
- After the retry budget is spent the email **goes out anyway**, with transcript
  and summary but no audio, and `recording_attached: false`. A notification that
  silently never arrives would be worse than one missing an attachment.

---

## 7. The recording player

`GET /calls` and `GET /calls/:id` gain **`has_recording: boolean`**.
`GET /calls/:id` additionally returns **`recording_stream_url`** when that is true:

```json
{ "call": {
  "id": 142,
  "has_recording": true,
  "recording_stream_url": "/calls/142/recording?token=eyJydW5JZCI6...abc123"
} }
```

Drop it straight into an audio element:
```html
<audio controls preload="metadata" :src="apiBase + call.recording_stream_url" />
```

**Why it isn't Retell's own URL.** Retell's URL is unauthenticated — anyone holding
it can replay a customer conversation. It never leaves the backend. This endpoint
proxies the bytes and forwards `Range` headers, so seeking works normally.

**Three things to get right:**

1. **The token expires in 30 minutes.** Re-read the call rather than caching this
   URL in a store. If playback 401s, re-fetch `GET /calls/:id`.
2. **It is not `authenticate`-guarded** — an HTML5 `<audio>` element cannot set an
   `Authorization` header, so the signed query token *is* the auth. Same pattern as
   the SSE stream in `routes/engines.js`. Do not add a Bearer header to it.
3. Use `has_recording` for the list view (it is on `GET /calls` rows too); only
   `GET /calls/:id` mints a `recording_stream_url`.

**404** `{ "error": "No recording for this call" }` — chats never have one, and
calls from before this shipped have no stored URL.
**401** `{ "error": "Invalid or expired recording token" }`

---

## 8. What the email itself looks like

So in-app copy matches reality:

- **Subject:** `Clara Confirms · Outbound call — Ultimate Fire — Confirmed`
  (`Outbound chat` for SMS; prefixed `[TEST] ` for test calls). The literal word
  **"Outbound"** is load-bearing — Ultimate Fire already receives inbound
  answering-service mail from a different system into the same inbox, and that
  token is what makes a mail rule possible (CMAP-226).
- **Body:** outcome, customer, site, job, phone, when (company timezone), duration,
  channel, sentiment → summary → the full transcript as speaker turns.
- **Attachments:** the audio (`.wav`/`.mp3`, voice only) and the complete transcript
  as `.txt`. The transcript is inline too, truncated past ~12 KB with the `.txt`
  holding all of it.
- **No Retell link anywhere**, including as a fallback when the audio is missing.

### Be honest about "plays in the email"

The audio is a real attachment, so the mail client uses its own player. That is
**not uniform**:

| client | what the recipient gets |
|---|---|
| Gmail web + mobile | attachment chip with a play button, plays in place |
| Apple Mail (macOS/iOS) | inline player in the message body |
| Outlook web | attachment preview with a player |
| **Outlook desktop (Windows)** | **no inline player** — click opens the default audio app |

If you write helper text, *"the recording is attached, and most email apps will
play it right in the message"* is accurate. *"Plays in your inbox"* over-promises
for Outlook desktop.

An `<audio>` tag in the HTML was considered and rejected — Gmail and Outlook strip
it, so it would work only in Apple Mail.

---

## 9. Building the settings screen

**Suggested shape:** a master toggle at the top, then a recipient list — email,
name, a compact scenario summary, an enabled toggle, delete — plus "Add recipient"
and a per-row "Send test now".

For the scenario picker, a checkbox group from `available_events` using `label` for
the caption and `description` as helper text. In the collapsed row, *"4 of 7
outcomes"* or a short chip list reads better than seven checkboxes per row.

**Make the master switch's precedence visible.** While `settings.enabled` is
`false`, show the recipient rows as inert (dimmed, with a note) — otherwise a row
reading "enabled" while nothing sends looks like a bug.

---

## 10. Things to get right

**Never default `enabled` to true anywhere in the UI**, for recipients or the
master switch. The backend forces `false` on create specifically so a half-filled
form cannot start emailing a real inbox.

**Render scenarios from `available_events`.** A hardcoded list drifts the moment a
key is added, and a recipient's stored `events` may contain a key your build does
not know — render unknown keys by their raw key rather than dropping them.

**Don't build a "notify me about everything" shortcut that writes all seven keys
and then hides the picker.** An empty `events` array is valid and means "nothing,
for now" — a recipient in that state should read as such, not as broken.

**Don't treat `pending` as failure**, and don't add a client-side retry for it —
see §6. The cron owns retries; a UI retry would risk a duplicate email, which the
backend's unique index is there to prevent.

**`POST /test` is a real send.** Never wire it to a hover-preview or an autosave.

---

## 11. Not in scope here

- **Merging the outbound and inbound portals** — the other half of CMAP-224
  (Maxwell's "ideally in the same portal"). This ships recording review on the
  outbound portal only.
- **Inbound (Ashley) notifications** — a different system entirely.
- Per-recipient quiet hours or digesting. Every subscribed outcome sends its own
  email; if volume becomes a problem, the answer is narrowing `events`, not a new
  batching mode.

---

## 12. One open item for you

**The portal deep link.** The email's "Open in portal" button currently points at
`${FRONTEND_URL}/logs?call=<id>`, a placeholder in a single constant
(`buildPortalUrl` in `src/services/call-notification/email.js`). Tell me the real
route for a call's detail view — or the query param the Logs page reads to open its
detail sheet — and I will correct that one line. It is the only place the backend
assumes the app's own URL shape.
