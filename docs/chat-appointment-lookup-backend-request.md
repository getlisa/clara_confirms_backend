# Chat Widget — Full Appointment List on Initial Load (Backend Request)

> **From the frontend, for the backend.** One field's scope needs to widen on
> an existing endpoint. No new route, no response shape change beyond that,
> and — see "Why this is safe" below — no risk to the "one card at a time"
> design `chat-cards-frontend.md` §2 established.

---

## 1. The problem

The confirmation chat widget logs every card-driven action (confirm /
reschedule / cancel / bulk-confirm) as a plain-text `{role:"system",
type:"action", content}` line (`chat-cards-frontend.md` §9) — e.g.:

```
Customer confirmed appointment #110727.
Customer confirmed 2 appointment(s): #110726, #110727.
```

These are deliberately generic server-side (`describeAction` in
`confirmation-agent/index.js`) — just a bare appointment id, no job/service/
date context. Customers found this vague, so the frontend now rewrites these
into fuller sentences by looking the referenced id(s) up against whatever
appointments the widget already has loaded, e.g.:

```
Customer confirmed the Fire Alarm Inspection visit scheduled for Friday, August 21, 2026 at 10:00 AM.
Customer confirmed 2 more visits: Fire Alarm Inspection (Thu, Aug 20); Sprinkler Test (Fri, Aug 21).
```

**This works reliably for anything that happened during the current
session** — every trigger call's `done` event already returns the full
job's appointment list (`chat-cards-frontend.md` §2: "every `done` SSE
event's `appointments` field... always the full list").

**It fails for anything from an earlier session.** `GET /chat-links/:token`'s
initial load returns only **one** appointment (§2: "the earliest one still
unconfirmed... `[]` if there's nothing upcoming"). If a customer reopens a
link whose history already has system-action lines about other appointments
on the job, and hasn't triggered any action yet in *this* session, those
ids aren't in the widget's data at all — the rewrite falls back to a plain
`"appointment #110899"` rather than a real description.

## 2. The ask

**Widen `GET /chat-links/:token`'s `appointments` field to return the full
job's appointment list — same shape, same sort order (soonest-first) — that
every trigger call's `done` event already returns, instead of restricting
it to one item.**

This isn't new computation: `buildAppointmentCards` already produces the
full list for every `done` event. The initial `GET` would just stop
truncating its own call to that same function down to `[0]` (or whatever
the current one-card selection logic is) before it goes on the wire.

## 3. Why this is safe — no UI/UX regression

The "one card at a time, don't show the wall of cards on the first turn"
rule (§2) is enforced **client-side**, not by the backend limiting the
array size. In `ChatWidgetPage.tsx`, `applyAppointments()` already stores
whatever array it's given in full (`setAppointments(next)`), but only ever
renders `next[0]` as a visible card in the timeline. The rest sit in memory
purely for lookups (`remainingUnconfirmed`, and now this enrichment) until
the "confirm the rest?" step (§8) reveals them.

Put differently: **the frontend already treats a full-list `appointments`
payload as safe to receive without rendering it all** — it does exactly
that on every single trigger call today. This change makes the initial load
consistent with every other call the endpoint already handles; it doesn't
introduce a new payload shape or a new frontend behavior to defend against.

## 4. What ships once this lands

**No frontend code changes required.** The lookup this enrichment already
uses (`appointmentsById` in `ChatWidgetPage.tsx`) is built directly from the
`appointments` state array, and `applyAppointments()` already accepts a
full-length array correctly (this is the exact code path every `done` event
already exercises). Widening the initial load's payload is the entire fix.

## 5. What this does NOT fix

An id can still fail to resolve if it refers to an appointment the company
has since deleted/purged from ServiceTrade, or (in principle) one that's
outside the job's own list of appointments entirely. The frontend's fallback
— render the original, unmodified backend sentence rather than a broken or
partial one — stays in place regardless; this change just makes it far less
likely to be needed for the common case (a customer reopening a link after
some time has passed).
