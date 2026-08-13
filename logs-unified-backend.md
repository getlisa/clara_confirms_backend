# Frontend-Requested Backend Changes — Unified Logs (search, channel, location)

> Written from the frontend (`clara-confirms`), same convention as the other
> `*-frontend.md` / `*-backend.md` docs here. The Logs page is **built and
> shipped** against today's endpoints — everything below is what it can't do
> correctly without backend help, in priority order.

## Context — what shipped on the frontend

`/logs` is now one page showing **calls and chat links together**, newest first,
with a `Channel` column and filters for channel, chat lifecycle `status`, chat
conversation `state`, and call outcome. Plus a search box over recipient phone,
email, location name and customer name.

**There are exactly two channels: `call` and `chat`.** SMS is deliberately not a
third — a "text" is a text carrying a chat-link URL, the same conversation as an
emailed link, differing only in delivery. Retell's conversational SMS is disabled
for confirmations, so no live text exchange exists. A `calls` row with
`channel: 'sms'` or `'web_chat'` is therefore reported as **Chat**, and the
delivery medium is **not shown in the logs at all** — it isn't a channel, and
displaying it beside one reintroduces the split this collapses.

It does this by calling `GET /calls` and `GET /chat-links` separately, merging
client-side (`src/lib/logs.ts`). That works, but it forces four compromises the
backend can remove. **Items 1 and 2 are the ones that make the page wrong rather
than just limited.**

---

## 1. Server-side `search` on both list endpoints — the main ask

Neither `GET /calls` nor `GET /chat-links` accepts a search param today, so the
Logs search box **filters only the rows already fetched** (currently the most
recent 200 per source). Searching for a customer whose last activity was 300
rows ago silently returns nothing — the page says "No activity matches these
filters", which is indistinguishable from "that customer has no activity".

**Requested:** a `search` query param on both, matching case-insensitively
across the same four fields the UI advertises:

| field | `GET /calls` | `GET /chat-links` |
|---|---|---|
| recipient phone | `calls.to_number` | *needs item 3* |
| email | `customers.email` | `contacts.email` (recipient) |
| location name | *needs item 2* | `locations.name` |
| customer name | `customers.full_name` | `customers.full_name` |

**Phone matching must be digits-only on both sides.** Stored values are
inconsistent (`+19402324304` and `(402) 620-5042` both exist in real data), so a
plain `ILIKE '%...%'` misses. Something like
`regexp_replace(to_number, '\D', '', 'g') LIKE '%' || $digits || '%'` — the
frontend already normalises the query this way and it's the one behaviour worth
matching exactly, or the two disagree about what "matches".

Response shape unchanged; `total`/`counts` should respect `search` the same way
they respect the existing filters.

---

## 2. `location_name` on `GET /calls`

`GET /chat-links` returns `location_name` (joined via `jobs.location_id`), and
the doc for it rightly notes the site is *"often more recognisable to staff than
`customer_name`, which is a billing entity."* `GET /calls` has no such join, so
the Logs table's Location column is **permanently empty for every call row**,
and location search can only ever match chat links.

**Requested:** add `location_name` to `GET /calls`, joined the same way
(`scheduled_calls.job_id` → `jobs.location_id` → `locations.name`). The join
already exists in `db/calls.js`'s query for `scheduled_calls`, so this is one
more `LEFT JOIN`.

---

## 3. The send record on `GET /chat-links` — how it went out, to whom, and who sent it

A chat link goes out by **SMS or email**, to a **specific address or number**,
triggered either by **a person or the scheduler**. None of that is currently
readable from `GET /chat-links`, so the Logs detail sheet can't answer the
question staff actually ask when a confirmation doesn't land: *"was it emailed
or texted, to what, and did someone send it manually?"*

This matters more than it looks. Per `sms-link-masking-frontend.md`, a
carrier-blocked SMS is still reported as `sent: true` and raises no todo — so
"we texted it to this number at 14:02" is the only evidence available when a
customer says they never received anything.

**Note this is detail-sheet data, not a channel.** The logs show two channels
(Call / Chat) and deliberately don't put emailed-vs-texted in the Channel
column — that would reintroduce the split the two-channel model collapses. All
of the below renders in the chat-link detail sheet.

### 3a. Already recorded — just needs exposing

All of this exists on `scheduled_calls` and joins to a link via
`scheduled_calls.chat_link_token = chat_links.token`:

| requested field | source | note |
|---|---|---|
| `link_delivery` | `scheduled_calls.link_delivery` (migration 080) | `'email' \| 'sms' \| 'both' \| null` — the medium that carried the link |
| `recipient_phone` | `scheduled_calls.phone_number`, else contact `COALESCE(phone, mobile)` | the number it was texted to. `contacts.phone` is frequently `null` with the real number in `contacts.mobile` (confirmed against live `/customers/:id/contacts` data) |
| `recipient_email` | already returned | the address it was emailed to |

`null` for links created outside the dispatcher (a manual "copy link" with no
`scheduled_calls` row). The UI renders absent values as *"Not recorded"* rather
than guessing or showing a bare dash — please don't substitute a default like
`'email'`, since a wrong medium is worse than an admitted gap.

`recipient_phone` also unblocks phone search for chat rows (item 1): without it,
searching a number can only ever match calls.

### 3b. Not recorded anywhere — needs a column

**Manual vs automatic is not currently distinguishable.** I checked for it:
there is no `origin` / `triggered_by` / `is_manual` column on `scheduled_calls`
or `chat_links`. The nearest thing is `bypass_office_hours`, which
`manual-call.js` sets from `immediate === true` — so it's an unreliable proxy: a
manual send scheduled for later (`immediate: false`) records exactly the same
value as a scheduler send.

**Requested:**

- **`origin`** — `'manual' | 'scheduler'`, on `scheduled_calls` (and surfaced on
  the chat-link row). Set `'manual'` in `manual-call.js`, `'scheduler'` in
  `scheduler.js`. A default of `'scheduler'` for existing rows is fine and
  honest — everything historical came from the sweep unless someone clicked.
- **`triggered_by_user_id` / `triggered_by_name`** — which staff member clicked
  send, when `origin` is `'manual'`. This is the part that makes manual sends
  genuinely auditable rather than just labelled; without it "manual" can't
  answer *who*.

The frontend is already typed and rendering for all of it
(`ChatLinkListItem.link_delivery` / `recipient_phone` / `origin` /
`triggered_by_name`), showing "Not recorded" until each field arrives — so
these can land independently, in any order, with no frontend change.

Worth applying the same `origin` treatment to **calls** eventually, for the same
reason: a manually-dialled call and a swept one are indistinguishable in the
logs today. Not requested now, since the immediate ask is chat links.

---

## 4. `GET /logs` — one merged, correctly-paginated endpoint

The structural problem: **two independently-paginated sources cannot be merged
into a correctly-paginated list client-side.** Page 2 of a merge of two separate
`LIMIT 50` queries is not the continuation of page 1. The page works around this
by fetching a 200-row window per source, merging, and paging over that — and
says so in the footer ("Showing the most recent 200 per channel") rather than
implying it's the full history. But it means:

- older activity is unreachable however you filter or search,
- the entry count is a count of the window, not of what exists,
- two extra round trips on every load.

**Requested (lower priority than 1–3 — those make today's page correct; this
makes it complete):** a single endpoint returning both sources as one ordered,
paginated list.

```
GET /logs?channel=call|chat&status=…&state=…&outcome=…&search=…&limit=50&offset=0
```

```json
{
  "logs": [
    {
      "source": "call",
      "id": 1234,
      "timestamp": "2026-08-13T10:00:00.000Z",
      "channel": "call",
      "job_name": "Inspection Job #49354684",
      "job_number": "49354684",
      "customer_name": "First Lutheran Church",
      "location_name": "First Lutheran Church",
      "recipient_name": null,
      "recipient_phone": "+19402324304",
      "recipient_email": "office@flc.org",
      "call": { "…the existing GET /calls row…" }
    },
    {
      "source": "chat",
      "id": 77,
      "timestamp": "2026-08-13T09:00:00.000Z",
      "channel": "chat",
      "…shared fields as above…": null,
      "chat_link": { "…the existing GET /chat-links row, including the §3 send-record fields…" }
    }
  ],
  "counts": { "call": 812, "chat": 141 },
  "pagination": { "limit": 50, "offset": 0, "total": 953 }
}
```

Notes on the shape, so it drops into what's already built:

- **Keep the nested source object.** The frontend's `LogRow` is exactly this —
  shared fields hoisted for the table, plus the full original record for the
  detail sheet. Flattening everything into one row loses the call transcript and
  the chat timestamps.
- **`timestamp` should be one column you can sort on** — `calls.created_at` and
  `chat_links.created_at`. A `UNION ALL` over the two with a computed `source`
  and shared aliases, ordered once, is enough; it does not need a new table.
- **Don't invent a shared status enum.** A call's outcome (`confirmed` /
  `voicemail`) and a chat link's lifecycle (`sent` / `in_progress` / `ended` /
  `expired`) are different axes and the UI renders them per source. Merging them
  into one vocabulary would lose information.
- **`is_test`**: calls have it, chat links don't. The page currently treats test
  mode as a calls-only view. If `/logs` takes an `is_test` param, chat links
  should be excluded when it's `true` rather than shown alongside test calls.

---

## Not requested

- A staff-facing chat transcript endpoint. The Logs detail sheet shows a chat
  link's lifecycle timestamps only; there's no equivalent of the call
  transcript. Say if one exists and I'll wire it up.
- Any change to `GET /chat-links/:token` or the SSE contract — the widget is
  unaffected by all of the above.
- Realtime/streaming logs. Per `chat-link-status-frontend.md` §4, a refresh on
  view is enough; the page does not poll.
