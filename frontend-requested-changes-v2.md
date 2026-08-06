# Frontend-Requested Backend Changes — v2 (Service Manager Confirmation Platform)

> This doc is the reverse of the other `*-frontend.md` docs in this repo: it's
> written **from the frontend** (`clara-confirms`) describing what it needs from
> the backend to finish a full product rebuild around chat-link-based
> confirmations. Nothing here is implemented yet — this is the requested
> contract. The frontend is proceeding to build its UI against these shapes
> immediately, so implementing them unblocks real (not mocked) data.

## Context

The product is pivoting from manual-call confirmation to an AI-chat-link
confirmation flow (see `chat-link-widget-frontend.md` for the existing,
already-shipped single-conversation contract). Three frontend surfaces need
data that doesn't exist yet:

1. An **Audit Logs** page showing the live status of every outstanding/active/
   ended chat-link conversation across all customers — today, only a
   single-token contract exists (`GET /chat-links/:token`), with no way to list
   multiple conversations at once.
2. A **per-conversation "Post to CRM"** action on that page — today,
   `crm_comment_writeback_enabled` (`crm-comment-writeback-frontend.md`) is a
   **company-wide** setting only; there's no way to trigger or confirm a post
   for one specific conversation.
3. A **bulk "send confirmation" action** from the Inspections page — today,
   the frontend can create a chat-link (`POST /chat-links/:kind/:id`, per
   `chat-link-widget-frontend.md`) but the only frontend usage of that
   (`SendChatLinkButton`) just copies the resulting URL to the clipboard. There's
   no bulk version, and no endpoint that actually dispatches the link by email
   or SMS.
4. **Dashboard stats** (`BACKEND_CHANGES.md` §8, `GET /dashboard/stats`) are
   call-centric (from the old manual-calling workflow) and have no chat-link-
   based "reached" / "responded" metrics for the new workflow.
5. One **prompt fix**: the initial chat-link `quick_replies` currently include
   a 4th "No" option (`["Yes", "No", "Reschedule", "Cancel"]`) redundant with
   "Cancel" — please drop it to `["Yes", "Reschedule", "Cancel"]`.

---

## 1. `GET /chat-links` — list endpoint (new)

Returns a page of chat-link conversations with their current status, for a
real-time monitoring table (poll every 10–15s from the frontend; SSE/websocket
would be nicer long-term but polling is fine for v1).

**Query params** (all optional, AND-combined):
- `state`: `open | in_progress | ended` — a 3-bucket simplification of the
  existing granular `ChatLinkState` (`chat-link-widget-frontend.md` §"State
  reference"). Suggested mapping:
  - `open` → `chat_started` (link created, customer hasn't replied yet)
  - `in_progress` → `confirmation_accepted | collecting_contact_info |
    reschedule_needed | reschedule_pending_confirmation`
  - `ended` → `service_link_sent | canceled | chat_ended` (anything with a
    final resolution, or timed out)
- `outcome`: `confirmed | rescheduled | canceled` — only meaningful once
  `state=ended`.
- `job_id`, `appointment_id`, `customer_id` — scope to one entity. Note a confirmation conversation is job-scoped: an `appointment_id` filter matches the link's originating appointment, not every appointment the conversation actually covered.
- `created_after`, `created_before` — ISO date range.
- `limit`, `offset` — pagination.

**Response:**
```json
{
  "chat_links": [
    {
      "token": "abc123",
      "job_id": 44417109,
      "appointment_id": 9981,
      "customer_id": 552,
      "customer_name": "Jack LTR",
      "job_name": "Construction Job #44417109",
      "state": "in_progress",
      "raw_state": "reschedule_needed",
      "outcome": null,
      "crm_posted": false,
      "created_at": "2026-07-29T14:02:00Z",
      "updated_at": "2026-07-29T14:05:12Z"
    }
  ],
  "total": 214
}
```
- `raw_state` included alongside the bucketed `state` so the frontend can show
  more granular detail on hover/expand if useful, without the list endpoint
  losing information.
- `outcome` is `null` until `state=ended` and a resolution is known.

---

## 2. `POST /chat-links/:token/post-to-crm` — per-conversation action (new)

Distinct from the company-level `PATCH /call-settings` toggle
(`crm-comment-writeback-frontend.md`) — this is a manual, per-conversation
trigger a service manager clicks on the Audit Logs page for one specific
ended conversation.

**Request:** `POST /chat-links/:token/post-to-crm`, empty body.

**Response:**
```json
{ "posted": true, "crm_comment_id": "st_comment_9981" }
```

**Rules:**
- Only valid once the conversation's `state` is `ended` with a resolved
  `outcome` (confirmed/rescheduled/canceled) — `409` otherwise.
- Idempotent: calling it again on an already-posted conversation returns the
  same `crm_comment_id` rather than duplicating the comment.
- Posts to the same target entities described in
  `crm-comment-writeback-frontend.md` (appointment + parent job for
  confirmation flows).
- Relationship to the existing company-level toggle: if
  `crm_comment_writeback_enabled` is on, the backend may auto-post on
  conversation end and this endpoint just reflects/confirms that (`posted:
  true` already, `crm_posted: true` in the list response) — if it's off, this
  endpoint is the only way a comment gets posted, on-demand, per conversation.

---

## 3. `POST /jobs/bulk-send-confirmation` — ✅ DONE (shape differs from the ask — see below)

Called from the Inspections & Jobs page after a service manager selects one
or more customers/jobs/appointments and clicks "Send Confirmation." Full
contract in `frontend-implementation-guide.md` §12.7 — summary of what
differs from the original request:

`{type:"job"}` is the natural unit now that one conversation covers **all** of a
job's upcoming appointments. `{type:"appointment"}` items de-duplicate to their
parent job — selecting three appointments of the same job yields ONE row, so
that's reported in `results` keyed by the job rather than silently dropping rows.

**Request** (built as requested):
```json
{
  "items": [
    { "type": "job", "id": 44417109 },
    { "type": "appointment", "id": 9981 }
  ]
}
```

**Response — QUEUES rather than sends,** unlike the original ask. This route
reuses the exact same per-job enqueue logic the automatic nightly sweep uses
(`scheduler.enqueueJobConfirmation` in the backend), so the two paths can
never diverge on channel resolution, contact-completeness gating, or dedupe.
That means the row still goes through the normal dispatcher — respecting
office hours and per-tenant concurrency caps — rather than sending inline
within this request. Consequently there's no `token`/`sent_via` per item (those
only exist once actually dispatched, not at queue time):
```json
{
  "results": [
    { "type": "job", "id": 44417109, "requestedAs": "job", "status": "queued",
      "channel": "voice", "scheduled_call_id": 5821, "scheduled_at": "2026-08-05T14:00:00Z" },
    { "type": "job", "id": 51002, "requestedAs": "appointment", "status": "skipped", "reason": "missing_email", "channel": "web_chat" }
  ]
}
```
- Channel per item comes from the target customer's `is_voice`/`is_sms`/`is_email`
  flags (see the new `chat-sms-channel-frontend.md` §2 — this shipped alongside
  this endpoint, replacing the old single-valued `preferred_channel`), not a
  fixed "email and/or SMS depending on what's available" rule.
- Partial success is expected and fine — report per-item status rather than
  failing the whole batch. `status`: `"queued"` | `"skipped"` | `"failed"`;
  `reason` on skip/fail: `missing_phone`, `missing_email`, `already_queued`,
  `no_upcoming_appointment`, `appointment_not_found`, `invalid_item`.

---

## 4. Dashboard stats additions — extend `GET /dashboard/stats`

Add a `chat_links` block to the existing response (`BACKEND_CHANGES.md` §8),
computed the same way the existing `calls` block is period-scoped:

```json
{
  "chat_links": {
    "sent_this_period": 42,
    "responded_this_period": 31,
    "total_sent_all_time": 1204
  }
}
```
- `sent_this_period` / `responded_this_period` respect the existing `period`
  query param (`today|week|month|all`).
- `total_sent_all_time` is always all-time regardless of the requested
  `period`, so the frontend can show "total customers reached to date" as a
  fixed card alongside the period-scoped ones.
- No change needed to `jobs.due_soon` — it already accepts an arbitrary day
  count, so the frontend will just call it twice (`due_soon=7`, `due_soon=30`)
  for "upcoming this week / this month" cards. Flagging here only so it's not
  mistaken for a gap.

---

## 5. Prompt fix: drop the "No" quick reply — ✅ DONE

The initial `quick_replies` `input_hint` at `chat_started` was
`["Yes", "No", "Reschedule", "Cancel"]`; it is now
`["Yes", "Reschedule", "Cancel"]` — "No" and "Cancel" mean the same thing here
and having both is confusing for the customer and for a frontend trying to
render a clean 3-button choice.

Extra reason it had to go: with job-centric confirmations a bare "No" is now
genuinely ambiguous — no to *which* appointment? Note `quick_replies` is also
state-dependent now, and at `confirmation_accepted` it can be
`["Yes, confirm the rest", "No, just this one"]`, where "No" *is* unambiguous
and is therefore kept. See `chat-link-widget-frontend.md`.

---

## Not requested in this pass

- Websocket/SSE for the chat-links list (polling is fine for v1).
- Any change to the existing single-token `GET/POST /chat-links/:token`
  turn-by-turn contract — that flow already matches the product spec.
- CRM connection management — out of scope, covered elsewhere.
