# CRM Comment Write-Back — Frontend Integration Guide

> Covers the **new per-company toggle** that controls whether Clara posts a
> summary comment back to ServiceTrade after a call. Everything here is additive
> — it's one new boolean field on the existing Call Settings API. No other
> endpoint changed shape.

## 0. What shipped

After an **answered** call, the backend can post a short comment onto the
corresponding ServiceTrade entity summarizing the outcome (e.g. *"the customer
confirmed the appointment"* + the call summary). This is now gated by a
**per-company setting the user controls from the UI** — not an environment flag.

- **Confirmation calls** → comment on the **appointment** and its **parent job**.
- **Service-opportunity follow-up calls** → comment on each **service request**.
- **Voicemail / no-answer calls never post.** Unclear outcomes are skipped.

The whole feature is **off by default**; each company opts in via this toggle.

---

## 1. The setting — `crm_comment_writeback_enabled`

A new boolean field on the existing **Call Settings** object.

### `GET /call-settings`

The response's `call_settings` object now includes the field:

```json
{
  "call_settings": {
    "business_hours_start": "09:00",
    "business_hours_end": "17:00",
    "max_attempts": 3,
    "voicemail_behavior": "leave",
    "include_weekends": false,
    "alert_days_before": 2,
    "voicemail_message": "…",
    "agent_can_make_changes": true,
    "auto_schedule_enabled": true,
    "auto_dispatch_enabled": true,
    "crm_comment_writeback_enabled": false
  }
}
```

- Type: `boolean`. **Default `false`.**
- Older companies that never saved settings also read back `false`.

### `PATCH /call-settings`

Send the field to toggle it (standard JWT auth, same as the other settings):

```json
{ "crm_comment_writeback_enabled": true }
```

- Must be a `boolean`, else `400 { "error": "crm_comment_writeback_enabled must be a boolean" }`.
- Response is the full updated `call_settings` object (same shape as `GET`).
- You can send it alongside any other call-settings fields in the same PATCH.

---

## 2. Suggested UI

Add a toggle on the **Call Settings** page, near `agent_can_make_changes`
(both govern how the agent interacts with the CRM):

- **Label:** "Post call summaries to ServiceTrade"
- **Help text:** "After an answered call, add a comment to the appointment / job
  (or service request) in ServiceTrade noting whether the customer confirmed,
  cancelled, rescheduled, booked, or declined — with the call summary. Voicemails
  and unanswered calls are never posted."
- **Control:** on/off switch bound to `crm_comment_writeback_enabled`.
- **Default:** off. Persist via `PATCH /call-settings`.

Optional: only show the toggle when the company has a connected ServiceTrade
integration (if the frontend already knows the CRM connection state). If shown
without a connection, the toggle still saves fine — it just has no effect until
a CRM is connected.

---

## 3. Behavior notes (so the UI can set expectations)

- **Per company.** Turning it on affects only that company's calls.
- **Answered calls only.** Voicemail and no-answer calls never post a comment,
  regardless of the toggle.
- **Which outcomes post:** confirmed / cancelled / reschedule-requested
  (confirmation calls) and booked / declined (service-opportunity calls).
  Ambiguous outcomes (e.g. "needs to check") post nothing.
- **Only synced entities.** Comments are only written to entities that came from
  ServiceTrade; manually-created / test records are skipped automatically.
- **Idempotent.** Re-processing the same call won't duplicate a comment.
- No new page or route is required — this is a single field on an existing page.

---

## 4. Not in this build
- No per-call override — this is a company-level setting only.
- Comment visibility (who in ServiceTrade sees the comment) is a backend/deploy
  concern, not exposed in the UI.
- No CRM connection management here — this guide only covers the toggle.
