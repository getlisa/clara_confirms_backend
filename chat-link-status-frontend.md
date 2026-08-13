# Chat-Link Status & Monitoring — Frontend Guide

> **For the frontend agent.** One new list endpoint, plus a new field on two
> responses you already consume. Same conventions as
> `servicetrade-webhooks-frontend.md`.

Base URL: `VITE_API_URL` · Auth: `Authorization: Bearer <token>` on the monitoring endpoint.

---

## 0. What shipped

Every chat link now records where it stands in its life, so staff can answer
"did the customer ever open it, and did anything come of it?"

| status | meaning | set when |
|---|---|---|
| `sent` | delivered, nobody has opened it | on dispatch (email/SMS leg succeeds) |
| `in_progress` | the customer opened it; conversation is live | first time the link is opened |
| `ended` | an outcome came in and the agent closed the conversation | `end_conversation` fires |
| `expired` | the 24-hour window lapsed before the agent closed the conversation | background sweep, every ~2 minutes |

Alongside each, a timestamp: `sent_at`, `opened_at`, `ended_at`, `expired_at`.

`expired` does **not** mean nothing happened — see §4. A customer can confirm and
then close the tab, which never reaches `end_conversation`.

### `status` is NOT `state` — you need both, for different things

They look similar and are easy to confuse. They are not interchangeable.

| | `state` | `status` |
|---|---|---|
| answers | where the **conversation** is | where the **link** is in its life |
| values | `chat_started`, `confirmation_accepted`, `collecting_contact_info`, `service_link_sent`, `reschedule_needed`, `reschedule_pending_confirmation`, `canceled`, `chat_ended` | `sent`, `in_progress`, `ended`, `expired` |
| use it for | the widget's input control (`input_hint` is derived from it) | monitoring, dashboards, "what's outstanding" |

**Do not monitor on `state`.** It defaults to `chat_started` at *creation*, so a
link nobody has ever opened already reads as a started conversation. That is
exactly why this was added. `state` is unchanged and keeps driving the widget.

They can legitimately disagree — a real row today:

```
status: "in_progress"   state: "confirmation_accepted"
```

The customer confirmed (conversation state) but the chat is still open and has
not reached `end_conversation` (lifecycle). Both are correct.

---

## 1. `GET /chat-links` 🔒 — the monitoring list

**Query params** — all optional:

| param | notes |
|---|---|
| `status` | one of `sent`, `in_progress`, `ended`, `expired`. Anything else → `400` |
| `limit` | default `50`, clamped to `1..200` |
| `offset` | default `0` |

**Response `200`** — real data, company 9:

```json
{
  "chat_links": [
    {
      "id": 77,
      "status": "in_progress",
      "state": "chat_started",
      "call_type": "customer_confirmation",
      "created_at": "2026-08-12T21:58:08.432Z",
      "sent_at": "2026-08-12T21:58:08.432Z",
      "opened_at": "2026-08-12T21:59:01.248Z",
      "ended_at": null,
      "expired_at": null,
      "last_opened_at": "2026-08-12T21:59:01.248Z",
      "expires_at": "2026-08-13T21:58:08.396Z",
      "job_id": 33253,
      "appointment_id": 110802,
      "job_name": "Inspection Job #49354684",
      "job_number": "49354684",
      "customer_name": "First Lutheran Church",
      "location_name": "First Lutheran Church",
      "recipient_name": null,
      "recipient_email": null
    }
  ],
  "counts": { "sent": 0, "in_progress": 2, "ended": 1, "expired": 2 },
  "pagination": { "limit": 50, "offset": 0, "total": 5 }
}
```

### Field notes

| field | note |
|---|---|
| `counts` | **always all four keys, including zeros.** Unlike the webhook queue's counts, you never have to default a missing key. Note it counts the WHOLE company, not the filtered page — so the tab badges stay correct while a filter is applied. |
| `total` | respects the `status` filter; `counts` does not. Use `total` for pagination, `counts` for the tabs. |
| `opened_at` vs `last_opened_at` | `opened_at` is the **first** open and never changes — it's the "did they ever look" signal. `last_opened_at` moves on every view; use it for "last seen". |
| `recipient_name` / `recipient_email` | the nominated contact when the link went to one (migration 081), otherwise `null` — meaning it went to the customer record. |
| `location_name` | the site. Often more recognisable to staff than `customer_name`, which is a billing entity. |
| `job_number` | the CRM-facing reference. `job_id` is our internal id — don't show it. |
| `expires_at` | when the 24h window closes. Useful for an "expires in 3h" hint on `sent` / `in_progress` rows. |
| `outcome_comment_posted_at` | non-null only on `expired` rows, and only when that lapsed chat had actually reached an outcome that we then wrote back to the CRM. See §4. |
| `recipient_name` | the **person** the link was sent to, snapshotted at send. `null` is the common case and means the link went to the account's own email/phone — not that the data is missing. Never substitute `customer_name` here: see below. |

**`recipient_name` is a person or nothing.** The customer record on this platform
is an *account*, not a human — every customer row has `first_name`/`last_name`
empty and a `full_name` like `"Holiday Inn Express-NE City"`, `"JACK LTR"` or
`"123 California Ave"`, and on 72 of 215 live jobs it is the same string as the
location. So when `recipient_name` is null, show the destination
(`recipient_email` / `recipient_phone`) or "sent to the account", and don't fall
back to `customer_name` as if it were the reader. The chat agent follows the same
rule: it greets `recipient_name` when there is one and opens without a name when
there isn't, rather than addressing an organisation as a person.

**Where the name comes from**, in order — you don't need to do any of this
yourself, the field is already resolved, but it explains why a link with no
nominated contact still shows a person:

1. the snapshot taken when the link was sent;
2. the nominated contact, if the link was addressed to one (rare — 1 link in 10);
3. **the delivery itself**: the send log says which address the email/SMS went
   to, and that address is matched back to a contact — email against
   `contacts.email`, a phone number against `contacts.mobile` or `contacts.phone`
   compared as digits (the log stores `+14026201781`, contacts store
   `402-620-1781`). This is what names most links. On current data it resolves 8
   of 10 that would otherwise be anonymous.

Null therefore means "we sent it somewhere we can't tie to a known contact" —
usually an address that exists on no contact record — not "we didn't look".

**No row is ever deleted** — an expired or ended link stays listed with its
timestamps, so the list is a history as well as a worklist.

---

## 2. The status field on responses you already use

`status` is now returned alongside `state` on:

- `GET /chat-links/:token` (public widget resolve)
- `POST /chat-links/:token/messages` → the `done` SSE event

Both are **additive** — nothing else about those payloads changed, and the widget
needs no update unless you want it. `input_hint` still derives from `state`.

---

## 3. `GET /chat-links/:id/messages` 🔒 — read the conversation

The chat equivalent of a call transcript. Calls had one in the Logs detail sheet;
chats showed only lifecycle timestamps. Now staff can read what was actually said.

`:id` is the **numeric chat-link id** from the list — never the token. The token is
the customer's credential for that conversation; treating it as a lookup key in
staff UI would leak the ability to *use* the chat. A non-numeric id → `400`; an id
belonging to another company → `404` (indistinguishable from "no such link", on
purpose).

**Response `200`** — real data, company 8, link 69:

```json
{
  "chat_link_id": 69,
  "status": "expired",
  "state": "confirmation_accepted",
  "outcome_comment_posted_at": "2026-08-13T13:45:09.521Z",
  "message_count": 10,
  "messages": [
    {
      "role": "agent",
      "content": "Hi JACK LTR, this request is regarding your upcoming appointment on Saturday, August 15, 2026 at 02:00 PM with Testing Enterprise regarding Basement Waterproofing / Basement / Crawlspace Management. Can you please confirm this appointment?",
      "created_at": "2026-08-11T17:31:40.292Z"
    },
    { "role": "user",  "content": "Yes", "created_at": "2026-08-11T17:31:52.891Z" },
    { "role": "agent", "content": "Great — thanks for confirming. …", "created_at": "2026-08-11T17:31:57.668Z" },
    {
      "role": "agent",
      "type": "service_link",
      "url": "https://app.servicetrade.com/…",
      "job_name": "Basement Waterproofing",
      "created_at": null
    }
  ]
}
```

### Field notes

| field | note |
|---|---|
| `role` | `"agent"` or `"user"`. There is no `"system"` — internal prompt scaffolding is stripped before you see it. |
| `type` | absent on normal messages. `"service_link"` marks a **card, not a sentence**: render the link the customer was handed, don't print `content`. This is the only `type` today; treat an unknown one as "skip". |
| `message_count` | the **raw** count and it will be larger than `messages.length` (10 vs 5 above). It includes tool calls and their results. Don't display it as "5 messages" — use `messages.length` for that, or don't show it at all. |
| `created_at` | **best-effort, and may be `null`.** See below. |

**Why `created_at` can be null.** The conversation itself is stored without
per-message timestamps; times are borrowed from the turn log by matching message
text in order. Unmatched messages — service-link cards always, and anything
written before the turn log existed — keep `null`. Render those without a
timestamp rather than falling back to "now" or to the link's `sent_at`, and never
sort on this field: `messages` is already in true order.

**Empty is a valid answer.** A link nobody opened returns `{ "messages": [],
"message_count": 0 }`. Show "not opened yet", not an error. Reading a conversation
is a pure read — it never starts one, never marks the link opened, and never
advances `status`, so staff can look freely.

**No pagination.** Real conversations average ~800 characters, longest seen 2,243.

---

## 4. An `expired` chat can still have a CRM comment

This looks like a bug in the UI and isn't, so it's worth handling deliberately.

A customer confirms in chat, then closes the tab. The confirmation is real — the
appointment is confirmed in ServiceTrade — but `end_conversation` never fires, so
the link sits `in_progress` until the sweep lapses it to `expired`. The comment
that normally summarises the conversation for the office is posted *by*
`end_conversation`, so it never went out.

That's now closed: when a chat expires, if it had reached a **confirm, reschedule
or cancel**, the summary comment is posted to ServiceTrade and
`outcome_comment_posted_at` is stamped.

Verified on real data: link 69 above had confirmed appointment 110735 and no
comment had ever reached the CRM. It has one now.

**For the UI:**

- **The status stays `expired`.** The link genuinely lapsed and the customer never
  got a proper close — folding it into `ended` would understate lapses. Show
  something like *"Expired — outcome recorded"* when
  `outcome_comment_posted_at` is non-null.
- **Don't use `state` to decide whether an outcome happened.** `state` records
  **intent**, not result: saying "yes" sets `confirmation_accepted` before
  anything is written to the CRM, and it stays set even if the write then failed.
  A live example — links 69 and 70 both read `state: "confirmation_accepted"`, but
  only 69 actually confirmed anything; 70's customer said yes and the chat
  produced nothing. `outcome_comment_posted_at` is the field that means "an
  outcome really landed".
- **A chat-booked new appointment is deliberately excluded.** If the only thing
  that happened was `create_appointment`, no expiry comment is posted — a product
  decision, not a gap.
- `null` on an `expired` row means there was nothing to report. That's the common
  case.

---

## 5. Building the view

**Suggested shape:** four tabs driven by `counts`, defaulting to `in_progress`
(the actionable one), with `sent` next. `ended` and `expired` are history.

**What each status should surface:**

- **sent** — "delivered HH:MM, not opened yet". If `expires_at` is close, that's
  the nudge-worthy set. This is where a resend button belongs.
- **in_progress** — "opened HH:MM". Pair with `state` for detail: a row that is
  `in_progress` + `confirmation_accepted` has confirmed but not finished; one
  that is `in_progress` + `chat_started` has opened and said nothing.
- **ended** — done. Show `ended_at`.
- **expired** — lapsed. Worth showing whether it was ever opened (`opened_at`
  non-null), because "sent and ignored" and "opened and abandoned" are different
  problems and want different follow-ups. Check
  `outcome_comment_posted_at` too — an abandoned chat that nevertheless confirmed
  needs no follow-up at all (§4).

**Timings to expect:** `expired` is applied by a sweep on the ~2-minute
dispatcher tick, so a link can read `in_progress` for up to about two minutes
past its `expires_at`. Compare against `expires_at` if you want to show it as
lapsed immediately.

---

## 6. Things to get right

**Never show `state` as the status.** It's the conversation's internal machine
and its vocabulary is not customer- or staff-facing.

**Don't infer "opened" from `last_opened_at` alone.** A staff member previewing
the link would move it. `status === "in_progress"` is the signal.

**`ended` is terminal.** A chat that reached an outcome is never later shown as
expired, even after its link lapses — so don't sort or group in a way that
implies otherwise.

**No polling loop needed for freshness.** Status changes are driven by real
events (dispatch, open, `end_conversation`) plus the sweep. A refresh on view
and after any action is enough; if you do poll, 30s is plenty.
