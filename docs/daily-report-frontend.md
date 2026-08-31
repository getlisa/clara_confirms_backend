# Daily Operations Report — Frontend Guide

> **For the frontend agent.** A new settings surface (report recipients) plus
> two on-demand actions. Same conventions as `chat-link-status-frontend.md`.

Base URL: `VITE_API_URL` · Auth: `Authorization: Bearer <token>` on every endpoint below.

---

## 0. What shipped

Staff can now nominate people (with no platform login required) to receive a
daily email summarizing what happened with confirmations — how many customers
were reached, who confirmed, who asked to reschedule, and what's still
outstanding — with a full `.xlsx` workbook attached. Each recipient picks their
own delivery time; the report is company-scoped and covers `customer_confirmation`
outreach only (not technician calls).

There is no dashboard for this in the product today — the report exists only as
an emailed workbook. This doc covers the settings screen (add/edit/remove
recipients) and the two testing actions (`preview`, `send-now`).

---

## 1. `GET /reports/recipients` 🔒 — list

**Response `200`**
```json
{
  "recipients": [
    {
      "id": 7,
      "company_id": 8,
      "email": "ops@acme.test",
      "name": "Ops Team",
      "user_id": null,
      "report_type": "daily_operations",
      "send_at_local": "21:00",
      "enabled": true,
      "last_sent_for_date": "2026-08-18",
      "last_sent_at": "2026-08-18T21:00:04.112Z",
      "created_at": "2026-08-01T10:00:00.000Z",
      "updated_at": "2026-08-18T21:00:04.112Z"
    }
  ]
}
```

| field | note |
|---|---|
| `send_at_local` | always `HH:MM`, **on the hour or half-hour** — see §4 for why. |
| `enabled` | **defaults to `false` on creation.** A new recipient never fires until explicitly turned on — see §5. |
| `last_sent_for_date` | the **business day** last covered, not a timestamp. Use `last_sent_at` for "when did the email go out". |
| `user_id` | set only if this recipient is also a platform login; usually `null` — most recipients won't be. |

---

## 2. `POST /reports/recipients` 🔒 — create

**Request**
```json
{ "email": "ops@acme.test", "name": "Ops Team", "send_at_local": "21:00" }
```
`name` and `send_at_local` are optional (`send_at_local` defaults to `21:00`).
`enabled` is **not accepted here** — every new recipient is created disabled;
turn it on with a separate `PATCH` once reviewed.

**Response `201`** `{ "recipient": { ...as above } }`
**Response `400`** `{ "error": "A valid email is required" }` or the time-format message (§4)
**Response `409`** `{ "error": "A recipient with this email already exists for this report" }`

---

## 3. `PATCH /reports/recipients/:id` 🔒 — update

Any subset of `email`, `name`, `send_at_local`, `enabled`. This is how a
recipient actually gets turned on:
```json
{ "enabled": true }
```
**Response `200`** `{ "recipient": { ...updated } }` · **404** if not found · **409** on a duplicate email.

## `DELETE /reports/recipients/:id` 🔒

`{ "message": "Deleted" }` · 404 if not found.

---

## 4. The time picker — get this right, it's the part people misread

**Only offer `:00` and `:30`.** The sweep that actually sends runs every 15
minutes, so any other minute value would just fire up to 15 minutes late,
forever — the backend rejects anything else with a 400 rather than silently
rounding it.

**What the chosen time actually means** depends on the company's own business
hours close (`business_hours_end`, from Settings → Call Configuration — not an
endpoint this doc adds, just context): whichever business day had **already
finished** at the chosen time is the one the report covers.

Show a live hint under the picker as the user changes it — this is the single
most important thing to get across:

> *"9:00 PM → you'll get **that day's** report every evening."*
> *"7:00 AM → you'll get **the previous day's** report every morning, since
> the business day isn't over yet at 7 AM."*

Worked example, business close = 5:00 PM:

| time chosen | report covers |
|---|---|
| 9:00 PM | the day just finished |
| 11:59 PM | the day just finished |
| 1:00 AM | **yesterday** |
| 10:00 AM | **yesterday** (today isn't over yet) |

**No email on a weekend** (or any day `include_weekends` is off for). This is
not a bug to explain away defensively — say so plainly if you show a "last
sent" indicator: *"No report Sat/Sun — anything still open from Friday appears
in Monday's Awaiting Response sheet."* Nothing from a skipped day is lost, it
just waits.

---

## 5. `POST /reports/daily/preview` 🔒 — the numbers only, no send

For "here's what a report would say" in the settings UI, without generating a
workbook or sending anything.

**Request** `{ "date": "2026-08-17" }` — optional; defaults to yesterday (today's
business day isn't finished, so previewing it would be misleading).

**Response `200`**
```json
{
  "summary": {
    "business_date": "2026-08-17",
    "outreach_count": 12,
    "confirmed_count": 5,
    "rescheduled_count": 1,
    "cancelled_count": 0,
    "awaiting_response_count": 3,
    "action_items_count": 9,
    "confirmed_count_appointments_crosscheck": 5
  }
}
```
`confirmed_count_appointments_crosscheck` is an internal consistency guard —
if it ever differs from `confirmed_count`, that's a backend data question, not
something to reconcile or explain in the UI. Fine to omit from display entirely.

---

## 6. `POST /reports/daily/send-now` 🔒 — ⚠️ sends a real email

For "send me a copy right now" / testing a recipient's setup. **This delivers
an actual email with the actual attachment** to whatever address the recipient
row has — label the button accordingly (e.g. "Send test now" with a confirm
step), not as a harmless preview.

**Request** `{ "recipient_id": 7, "date": "2026-08-17" }` — `date` optional, same
default as preview.

**Response `200`** `{ "ok": true, "sent_to": "ops@acme.test", "sent": true, "businessDate": "2026-08-17", "summary": { ... } }`

Repeatable — it does **not** count as that day's scheduled send (no
`last_sent_for_date` stamp), so testing it never blocks or duplicates the real
delivery later that day.

---

## 7. Building the settings screen

**Suggested shape:** a simple list — email, name, send time, an enabled toggle,
delete — plus an "Add recipient" form. A "Send test now" action per row is
worth surfacing given §6's real-send behavior; make it unmistakably a real send.

**What to show for `last_sent_for_date`:** *"Last sent: Aug 18"* is enough; the
exact timestamp (`last_sent_at`) is only interesting for debugging a specific
delivery.

**The workbook itself is not previewable from the API** — `preview` only
returns headline counts, not the sheet-level detail. If a fuller in-app preview
is wanted later, that's a new endpoint, not something to construct client-side
from `preview`'s response.

---

## 8. Things to get right

**Don't let `enabled` default to true anywhere in the UI.** A recipient row
existing is not the same as it being live — the backend enforces `false` on
create specifically so a half-filled-out form can't start emailing someone.

**Never accept a time off the `:00`/`:30` grid** — validate client-side too, so
the rejection doesn't surprise someone after they've already saved.

**Don't build a "this report already includes yesterday's carry-forward"
toggle or similar** — the Awaiting Response sheet handles that automatically
and is not configurable per recipient; every recipient at a company sees the
same carry-forward state, just on their own delivery schedule.
