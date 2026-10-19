# Arrival time — how Clara tells customers when the tech arrives — Frontend Guide

> **For the frontend agent.** A new setting on the **Call settings** page. Each company picks
> how Clara states the visit time on calls and in chat. Today Clara always gives a window
> ("between 11 AM and 12 PM"). A customer asked for this instead: *"Your appointment is
> scheduled for 11:00 AM. Please note that our technicians may arrive up to 30 minutes before
> or after your scheduled appointment time."* The backend builds the exact sentence, so the UI
> only edits three fields and shows a live preview.

Base URL: `VITE_API_URL` · Auth: `Authorization: Bearer <token>` · gate on `user.permissions`
(`team-access-frontend.md`).

## 1. The three styles

| `arrival_time_style` | Clara says (sample 11:00 AM visit) | Minutes used |
|---|---|---|
| `window` (default, today's behaviour) | "The technician is expected to arrive between 11 AM and 12 PM." | window = time − *before* → time + *after* (default 0 / 60) |
| `scheduled_with_tolerance` | "Your appointment is scheduled for 11 AM. Please note that our technicians may arrive up to 30 minutes before or after your scheduled appointment time." | the tolerance either side. Unequal values are said separately: "up to 15 minutes before or up to 1 hour after" |
| `scheduled_only` | "Your appointment is scheduled for 11 AM." | not used |

The setting applies to **voice calls and chat**. It's company-wide.

## 2. API

### Read: `GET /call-settings` (`data.read`, existing endpoint)

Three new fields on the existing response:

```json
{ "call_settings": { "...": "...", "arrival_time_style": "window", "arrival_minutes_before": 0, "arrival_minutes_after": 60 } }
```

### Save: `PATCH /call-settings` (`settings.edit`, existing endpoint)

```json
{ "arrival_time_style": "scheduled_with_tolerance", "arrival_minutes_before": 30, "arrival_minutes_after": 30 }
```

- Any subset of the three fields can be sent.
- Minutes are whole numbers from **0 to 240**.
- `400` with an `error` message for an unknown style or invalid minutes. Show it next to the field.

### Preview: `GET /call-settings/arrival-preview?style=&minutes_before=&minutes_after=` (`data.read`)

Returns the exact sentence for a sample 11:00 AM visit, built by the same code the agents use.
Omitted params fall back to the saved values.

```json
{
  "style": "scheduled_with_tolerance",
  "minutes_before": 30,
  "minutes_after": 30,
  "sample_time": "11:00 AM",
  "statement": "Your appointment is scheduled for 11 AM. Please note that our technicians may arrive up to 30 minutes before or after your scheduled appointment time.",
  "label": "11 AM (±30 min)"
}
```

`400` for an invalid style or minutes (same rules as PATCH).

## 3. UI — Call settings → "Arrival time"

```
Arrival time
How should Clara tell customers when the technician will arrive?

( ) Arrival window
      Arrive between [ 0 ] min before and [ 60 ] min after the scheduled time
(•) Scheduled time, with arrival tolerance
      Technicians may arrive up to [ 30 ] min before and [ 30 ] min after
( ) Scheduled time only

Preview — what Clara will say:
┌──────────────────────────────────────────────────────────────────────┐
│ "Your appointment is scheduled for 11 AM. Please note that our        │
│  technicians may arrive up to 30 minutes before or after your         │
│  scheduled appointment time."                                         │
└──────────────────────────────────────────────────────────────────────┘
                                                            [ Save ]
```

- **Radio group** for `arrival_time_style`. Show the two minute inputs only under the selected
  option that uses them: both under **window** and **tolerance**, none under **scheduled time only**.
- **Minute inputs:** number fields, step 5, min 0, max 240. Suggested defaults when switching
  style: window 0 / 60, tolerance 30 / 30. Keep the user's values if they already changed
  them.
- **Preview:** call `/arrival-preview` with the current form values, debounced about 300 ms,
  on every change (including before saving). Render `statement` in quotes. Never build the
  sentence on the client.
- **Save:** PATCH only the three fields. Success toast: "Saved. Clara will use this on new
  calls and chats."
- Without `settings.edit`, show the section read-only: the selected option, the values and
  the preview, with no inputs or Save.

## 4. Elsewhere in the UI

- The chat appointment card's existing `arrival_window_label` now follows the setting:
  - window: "between 11 AM and 12 PM";
  - tolerance: "11 AM (±30 min)";
  - scheduled only: "11 AM".

  Render it as-is. It's never null when there's a time.
- No other screens change.

## 5. Don'ts

- Don't compute arrival text in the frontend. Always use the preview endpoint.
- Don't label the tolerance style as a "window". The customer explicitly asked for the
  scheduled time, not a range.
