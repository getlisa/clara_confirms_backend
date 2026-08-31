# Agentic Chat Confirmation Redesign — Backend Requirements

> **From the frontend, for the backend.** This covers `clara-agentic-chat-build-spec.md`'s
> backend surface only — not UI. Every claim below traces to a specific
> file:line in `clara_confirms_backend` read directly this session (four
> targeted research passes plus two claims re-verified by hand); nothing here
> is inferred from the spec's own wording about what "already exists."
> Several of the spec's own assumptions about existing tools/mechanisms
> turned out to be wrong or incomplete — those are called out explicitly
> rather than quietly worked around.

---

## 0. Summary

| # | Area | Spec section | Current state | Gap | Effort |
|---|---|---|---|---|---|
| A | All-appointments-upfront | S0, §7 | Payload already full-list; prompt forces single-appointment framing | Prompt rewrite (opening message + free-text "confirm the rest" flow) | **Small–Medium** |
| B | Confirm-all vs one-by-one | S6, §4.8 | Mostly works today | Two real `/end`-gate bugs once appointments act independently | **Small** |
| C | Per-appointment actions on any card | — | Already works | None | **None** |
| C+ | "Not now" freeze + re-engage via agent | — (new, frontend-only) | Already works | None — verified `decline_remaining_appointments`/`GOAL`/`done.appointments` are sufficient | **None** |
| D | Confirmer identity capture | §4.7, §5.3, §6 | Lookup only, no capture path | New schema/handler/DB work across 5 tools + new session storage | **Large** |
| E | Onsite expectations as card/modal data | §4.5, §8 | Narration-only; can't reach button clicks; content seeded for 1 company | New delivery mechanism + content-coverage decision | **Medium–Large** |
| F | Read-only / intent-capture mode | §9, §10.2 | Doesn't exist for chat at all | Net-new gating in tool registry + core actions | **Medium** |
| G | Tool-name assumptions | §5.3 | `get_appointments` doesn't exist for chat | Spec correction, not a backend gap | **None (doc fix)** |

Sections A–C can ship largely independently of D–F. See §5 for phasing.

---

## 1. All-appointments-upfront (spec S0, §7)

**What the spec wants:** the customer sees every upcoming appointment on
the job in one view from the first message, not just the soonest one.

**Already true — no payload change needed.** `GET /chat-links/:token` and
every action trigger's `done` event both return the **full** job appointment
list via `buildAppointmentCards` (`confirmation-agent/appointment-card.js:64-66`),
which maps `ctx.appointments.upcoming` with no truncation:

```js
function buildAppointmentCards(ctx, serviceLink = null) {
  return (ctx?.appointments?.upcoming || []).map((appt) => buildAppointmentCard(appt, ctx.job, serviceLink));
}
```

"One card at a time" is a **frontend rendering choice**, already confirmed
earlier this project — the widget stores the full array and only chooses to
render one card from it. The backend has never restricted this on the wire.

**What does need to change — the model is instructed to ignore the data it already has:**

- **`OPENING_MESSAGE`** (`graph/prompt.js:348-363`) explicitly tells the
  model to keep the first message to a single-appointment greeting:
  > "This is the first message — keep it SHORT... who you are, the visit's
  > date, and the reason for the visit... Do NOT include the job's
  > description/notes, onsite expectations, or a noise/access question here."

  and **`GOAL`** (`graph/prompt.js:372-389`) reinforces pursuing one target:
  > "Your primary goal is to confirm appointment #{goalAppointmentId} — the
  > earliest one still marked 'not yet confirmed.'"

  The model already receives the entire `upcoming` list every turn
  (`APPOINTMENT_DATA`, `graph/prompt.js:230-296`) — only the *instructions*
  force single-appointment framing. This needs rewriting to a job-level
  greeting ("here's everything scheduled on this job") once the frontend
  stops asking for a one-appointment opener.

- **`STEP_3`** (`graph/prompt.js:553-568`, gated `d.showStep3 = d.counts.unconfirmed > 1`
  at `prompt.js:639`) is a **separate, still-live** "want to confirm the
  rest too?" flow for the **free-text conversation path** — distinct from
  the card-driven `propose_remaining_appointments` mechanism. If a customer
  types their way through the conversation instead of clicking cards, they
  will still hit the old one-at-a-time sequential ask even after the
  frontend ships the new carousel. This needs rewriting/removing too if the
  goal is "no more sequential ask," not just the card path.

- **`propose_remaining_appointments`** tool
  (`tools/handlers/propose-remaining-appointments.js`) is confirmed
  genuinely redundant under the new UX: it performs no DB write, never
  calls `markRemainingAddressed`, and nothing downstream reads whether it
  ran. Safe to simply stop triggering it — no removal urgency, no cleanup
  required elsewhere.

- **`computeInputHint`'s `confirmation_accepted` branch**
  (`services/chat-links.js:44-77`) currently returns quick-replies phrased
  for the old two-step reveal:
  ```js
  case "confirmation_accepted":
    return remainingUnconfirmed > 0
      ? { type: "quick_replies", options: ["Yes, confirm the rest", "No, just this one"] }
      : { type: "free_text" };
  ```
  This copy assumes the customer is being asked about "the rest" as a
  distinct follow-up — it needs rewriting (or the whole branch reconsidering)
  once every appointment is already visible and actionable from turn one.

---

## 2. Confirm-all vs one-by-one (spec S6, §4.8)

**What the spec wants:** a "confirm all" bulk action, plus the ability to
confirm/reschedule/cancel each appointment independently — no longer
sequential.

**Mostly already works.** `/end`'s 409 gate (`routes/chat-links.js:766-779`) is:

```js
if (r.ctx.ok && r.ctx.counts.unconfirmed > 0 && !r.link.remaining_addressed_at) {
  return res.status(409).json({ ok: false, error: "remaining_appointments_unaddressed", ... });
}
```

This is a **compound** check — `unconfirmed > 0` OR-composed with the
`remaining_addressed_at` stamp, not a pure workflow gate. A customer who
confirms every appointment individually (`confirm_appointment`, never
touching bulk-confirm) already satisfies it once `unconfirmed` naturally
reaches zero — verified `confirmAppointmentCore` and `buildCardTriggerArgs`
operate on any `appointment_id` with no "must be the primary appointment"
restriction anywhere.

**Two real bugs surface once appointments can be acted on independently:**

- **Gap 1 — a reschedule-only path can get permanently stuck.**
  `rescheduleAppointmentCore` (`actions.js:191-224`) resets
  `customer_confirmed: false` on the appointment it moves, by design (it
  genuinely does need re-confirming at the new time), and never calls
  `markRemainingAddressed`. Under the *old* UX this was masked — reschedule
  always triggers the forced "confirm the rest?" step, which always
  resolves via bulk-confirm or decline. Under the *new* UX, if that forced
  step is gone and a customer reschedules every appointment on a job
  one-by-one with nothing else, `unconfirmed` never reaches 0 and nothing
  ever stamps the gate — `/end` 409s forever with no way out.

- **Gap 2 — single-appointment cancel over-satisfies the gate.**
  `cancelAppointmentCore` (`actions.js:250-308`) stamps
  `remaining_addressed_at` **unconditionally**, regardless of `scope`
  (`actions.js:297`), on the documented assumption that "cancel closes the
  chat outright — nothing left to offer" (matches `chat-cards-frontend.md`
  §7 today). That assumption only holds under the old one-card-at-a-time
  UX. Under the new one, cancelling appointment #1 of 3 would silently
  stamp the gate for #2 and #3 too, even though nobody ever addressed them
  — `/end` would succeed and the chat would close with two appointments
  nobody was ever asked about.

**Recommendation** (implementation-level judgment, comfortable proposing
directly — not a product decision):

1. Scope the unconditional cancel-stamp to `scope: "entire_job"` only —
   a single-visit cancel (`appointment_only`) should no longer satisfy the
   gate on its own.
2. For the reschedule gap, either (a) keep `unconfirmed`'s current
   semantics (a bare reschedule still counts as unconfirmed, matching
   today's behavior) and give the frontend an explicit "I'm done for now"
   action that calls the already-existing `decline_remaining_appointments`
   trigger when a customer tries to end a conversation with only
   reschedules pending, or (b) redefine what counts as "terminal" for gate
   purposes. (a) is less invasive and reuses a trigger that already exists
   and already works correctly.

---

## 3. Per-appointment actions already generalize — no change needed

Verified directly: `confirmAppointmentCore` (`actions.js:72-111`) and
`buildCardTriggerArgs` (`routes/chat-links.js`) key everything off
`appointment_id` + `companyId`. Nothing anywhere checks "is this the
primary/current appointment for this conversation." Confirm, reschedule,
and cancel already work correctly for any appointment on the job, called
from any card in an all-appointments-upfront view. No backend change
required for this part of the redesign.

---

## 3a. "Not now" freezes the list; re-engaging goes back through the agent — shipped frontend-only, no backend change needed

**New frontend behavior**, not in the original spec, added in response to a
UX gap report: clicking "Not now" now raises a confirmation warning first
(previously it acted immediately), and once confirmed, the appointment list
that was showing **freezes** — every card greys out and its buttons become
inert (same visual treatment as the old resolved/disabled state,
`AppointmentCard.tsx`'s `disabled` prop). The customer can no longer act on
those cards directly. To confirm/reschedule/cancel any of the ones left
open, they have to explicitly ask again — either a button ("I'd like to
handle these now") or just typing — which sends a normal chat turn and, once
the agent replies, reveals a **fresh, live** list of whatever's still open.

**Verified this needs no backend work**, on two points:

- `declineRemainingCore` (`actions.js:432-436`, the `decline_remaining_appointments`
  trigger "Not now" already calls) only stamps `chat_links.remaining_addressed_at`
  — it never calls `setStateByToken`. `chat_links.state` stays whatever it
  already was (typically `confirmation_accepted` after an earlier confirm),
  so `computeInputHint` keeps returning `free_text` and the input box never
  gets locked out by this trigger. The re-engagement path (typing, or the
  button sending a canned message) has nothing structural in its way.
- `GOAL` (`graph/prompt.js:398-411`, injected on every turn) already reads:
  *"Guide them through confirming, rescheduling, or cancelling whichever one
  they raise, in whatever order they bring it up — there is no single
  required target."* Combined with `APPOINTMENT_DATA` always injecting the
  full appointment list every turn, and `done`'s `appointments` field always
  being fresh regardless of what the model says or calls
  (`chat-cards-frontend.md` §1/§9), a generic "I'd like to handle these now"
  message is enough for the agent to respond usefully and for the frontend
  to rebuild an accurate, live list from that turn's `done` event — no new
  tool, trigger, or prompt section needed.

Flagging this here per your ask to keep the backend doc current, not
because anything needs building.

---

## 4. Confirmer identity capture (spec §4.7, §5.3, §6)

**What the spec wants:** capture who is confirming — first name, last name,
role (`management`/`on_site`/`billing`/`scheduling`/`owner`/`other`), a
confirmed email, optional phone — once per session, at the first
confirming action, then reuse it silently for every subsequent
confirm/reschedule/cancel/create and for the service-link contact.

**This is the biggest gap the spec's own wording undersells.** §5.3 frames
it as "(Preferred) extend `confirm_appointment` / `confirm_job_appointments`
... to accept a `confirmed_by` object" — reads like a schema tweak. It is
not. Concretely:

- **Today's only "who confirmed" mechanism is a lookup, not a capture.**
  `resolveConfirmerLabel` (`tools/confirmer-label.js:29-33`):
  ```js
  async function resolveConfirmerLabel(companyId, recipientContactId) {
    if (!recipientContactId) return "the customer";
    const contact = await resolveContact(companyId, recipientContactId);
    return contact?.name || "the customer";
  }
  ```
  It derives a label purely from whichever platform contact the chat link
  was originally addressed to (or the send-event delivery address). There
  is no existing path anywhere for a customer to type a fresh name/role
  during the conversation and have it recorded.

- **None of the 5 mutating tools have any identity field today** — verified
  full zod schemas for `confirm_appointment`, `confirm_job_appointments`,
  `reschedule_appointment`, `cancel_appointment`, `create_appointment`.
  Adding `confirmed_by` means: a new schema field **+** a handler change to
  read it **+** an `actions.js` core-function change to thread it through
  **+** a DB-write change, repeated across all 5 — roughly 6 files, not one.

- **`confirmation_events.actor_name`** (`migrations/097_confirmation_events.sql`)
  is a single `TEXT` column. Role/email/phone need a migration — either 3
  new columns, or a documented sub-shape inside the existing `details`
  JSONB (which today has a contractually-reserved shape per event type:
  `{from,to}` for reschedule, `{reason,scope}` for cancel — adding
  `confirmed_by` there needs the same documentation discipline).

- **Storage location doesn't fit "captured once, applies to every
  appointment on the job."** `appointments.additional_information`
  (`migrations/026`) is per-appointment JSONB — today's `confirmed_by_label`/
  `confirmed_by_thread_id` pattern already has to be re-stamped on every
  appointment a call touches (`actions.js:86-90`, `144-150`). There is no
  existing job-level or session-level place a `confirmed_by` object could
  live once and implicitly cover the whole job.

- **`resolve_service_link_contact`'s existing `first_name`/`last_name`/
  `role`/`phone` fields are not a reusable identity-capture mechanism**,
  despite superficially matching the shape needed. Confirmed narrow for
  three concrete reasons: (1) gated to fire only on a `need_more_info`
  follow-up, never as a pre-step; (2) only reachable in the `confirming`/
  `all_confirmed` phases, structurally downstream of a confirmation having
  already happened; (3) it performs a real **ServiceTrade contact
  creation** — repurposing it for general identity capture risks creating
  spurious CRM contacts for every confirmer. Its `role` is also an
  unconstrained free string, not the spec's closed enum.

- **No existing "resolve once, auto-inject into every later tool call"
  mechanism is visible to tool handlers.** `ctx.cardTriggerArgs` is a
  per-request channel the *frontend* re-sends on every click, not
  server-persisted. LangGraph's own checkpointed state (`ConfirmationState`,
  `graph/build.js:41-54`) genuinely does persist across turns, but tool
  handlers never read it — only `agentNode`'s prompt-building does.

**Recommendation:** the codebase already has one pattern that does exactly
what's needed — `chat_links.recipient_*` columns, resolved fresh into `ctx`
on every single turn via `resolveRecipient` (`index.js:62-106`), the same
way `recipientName` already reaches every tool handler without the model
ever having to pass it as an argument. Follow that shape:

1. New storage keyed by `chat_links.token` — either new columns on
   `chat_links`, or a small dedicated table (e.g. `confirmer_identities`) —
   for `first_name`, `last_name`, `role`, `email`, `phone`.
2. A single new capture point (a tool the identity-sheet UI's first submit
   calls, or a plain REST endpoint) that writes it once.
3. Thread the resolved value into `ctx.confirmedBy` on every subsequent
   turn, the same way `recipientName`/`recipientEmail`/`recipientPhone`
   already are.
4. Every existing action-tool handler reads `ctx.confirmedBy` (already has
   the plumbing to read `ctx.*`) instead of needing a new model-supplied
   argument.

This is structurally guaranteed — every handler picks it up automatically —
rather than relying on the model remembering to pass an identity object on
every single tool call, which is meaningfully less reliable. Flagging this
as a **recommendation**, not asserting it as decided: the spec's own §10.5
explicitly leaves "which backend approach" open.

---

## 5. Onsite expectations as card/modal data (spec §4.5, §8)

**What the spec wants:** every confirmation shows access/noise/duration
content (16 variants, keyed by service × property type × frequency),
rendered in the detail modal and repeated in the confirmation
acknowledgement — described as "required content, not optional."

**Structural blocker — verified directly, this cannot work as-is with a
card/button UI.** `afterTools` (`graph/build.js:213-229`) routes any
card-triggered turn straight to `END`, never back to the model for
narration:

```js
const prior = messages[i - 1];
...
return parseCardTrigger(priorContent) ? END : "recompute_context";
```

Onsite-expectations content is currently delivered **only** as model
narration during a normal conversational loop-back
(`ONSITE_EXPECTATIONS`, `graph/prompt.js:391-421`, fired "once a visit is
actually confirmed... via `confirm_appointment` or `reschedule_appointment`
succeed[ing]"). Card-triggered turns are deliberately narrowed to exactly
`thinking → tool_call → tool_result → done` with all stray narration
suppressed (documented in `chat-cards-frontend.md` itself). **Concretely:
today, clicking Confirm on a card delivers zero onsite-expectations text —
it only reaches the customer if they type "yes" instead.** A rich
carousel/modal UI — the spec's entire premise — cannot depend on this
mechanism; it needs the content as data, not narration.

**Content coverage gap — verified directly in the migration.** The near-exact
16-variant copy library the spec's Appendix B describes already exists:

```sql
-- migrations/084_service_line_descriptions.sql
CREATE TABLE service_line_descriptions (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  ...
  UNIQUE (company_id, title)
);

INSERT INTO service_line_descriptions (company_id, title, description) VALUES
(9, 'Annual Fire Alarm (Apartments/Hotels)', $desc$We will need to sound off...$desc$),
...
```

All 16 rows are seeded for **company_id = 9 only** — every other company
has zero rows. The wording is close enough to the spec's Appendix B that
this table is almost certainly its actual source. The table's own
`UNIQUE(company_id, title)` confirms this is meant as per-company
admin-authored content, not a shared default library.

**Matching is deliberately soft, not the spec's proposed deterministic
lookup.** The migration's own comment is explicit:

> "Matching which description applies to a given appointment is left to
> the agent's own judgment from the appointment's real service line/job
> text — there's no property-type or frequency field anywhere in this
> schema (or in ServiceTrade's data) to match on precisely, and building
> one wasn't wanted."

This is the opposite of the spec's Appendix C, which proposes a
deterministic `onsite_copy[service_set][property_type][frequency]` key.

**Recommendation, with an open decision flagged rather than resolved:**
expose onsite-expectations as a resolved field on the appointment card
payload (computed server-side per appointment), since narration
structurally can't reach a button click. Two viable ways to get there —
this is a product call, not mine to make:

- **(a)** Keep the existing soft LLM-judgment matching, but run it as a
  one-off server-side resolution per appointment (rather than inline
  conversational narration) and attach the result to the card response.
  Reuses existing content/logic almost as-is.
- **(b)** Build the deterministic 3-axis lookup from spec Appendix C.
  Requires new schema (property type, frequency aren't tracked fields
  today per the migration comment) and full content coverage per company.

Either way, the company-9-only seeding is a **separate** product decision:
seed this content for every company, or keep today's graceful fallback
(general-terms-only language when nothing matches) as the default for
companies without it.

---

## 6. Read-only / intent-capture mode (spec §9, §10.2)

**What the spec describes:** an optional deployment mode where the chat
only captures intent (fires `report_customer_intent`, collects identity/
date/scope/reason for the human to inherit) and never actually mutates
data — confirm/reschedule/cancel calls skipped entirely.

**Does not exist for chat today, in any form.** `call_settings.agent_can_make_changes`
exists (`src/db/call-settings.js`, default `true`) but has **zero
references anywhere in `src/confirmation-agent/`** (confirmed via a full
directory grep). It only:

- Gates whether write tools are **registered with Retell** for voice
  (`services/retell-tools.js:64,74-76`) — a structural exclusion, but for a
  different channel.
- Indirectly reaches chat through the best-effort ServiceTrade **CRM
  mirror** on reschedule/cancel (`services/servicetrade-appointments.js:44-46`,
  called from `actions.js`) — but this only skips the CRM sync, never the
  platform-DB write the customer-facing "confirmed" state is based on.
  `confirmAppointmentCore` writes `customer_confirmed: true`
  unconditionally with no gate check at all.
- Is explicitly documented as **not applying to Copilot** either
  (`copilot/graph/prompt.js:34`).

**`report_customer_intent` itself already exists and already fires
"silently and early" per prompt design** (`prompt.js:433`) — that part of
the spec's requirement is already shipped, not new. But it's a soft prompt
instruction, not a `tool_choice`-forced guarantee the way exclusive-turn
tools are — worth noting if the spec wants a hard guarantee that it always
fires before any action tool.

**What building this for chat requires:** a new gate threaded into
`registry.js`'s phase/tool-gating (withhold `confirm_appointment`,
`confirm_job_appointments`, `reschedule_appointment`, `cancel_appointment`,
`create_appointment` from the model entirely when the mode is on) and/or
no-op'ing the writes inside `actions.js`'s core functions. This is
genuinely new work — there's no half-built version of this to extend.

---

## 7. Spec assumptions to correct — not backend gaps

- **`get_appointments`** — the spec's assumed fetch tool — **does not exist
  for chat.** Confirmed voice/Retell-only (`db/tool-definitions.js:11-13`,
  `routes/retell-tools.js:168`). Chat's actual architecture injects the
  full appointment list directly into the system prompt on every turn, by
  deliberate design:
  > "Appointment facts are injected directly into the system prompt from
  > `state.jobCtx` on every agent invocation — no `get_appointments` tool
  > is needed." (`graph/build.js:15-18`)
  > "This removes 'forgot to call the tool' as a failure mode entirely."
  > (`graph/prompt.js:6-12`)

  `list_upcoming_appointments` (which chat does have) is **not** a rename
  of `get_appointments` — it's a narrow overflow/pagination fallback for
  jobs with more than 8 upcoming appointments (`MAX_INLINE_UPCOMING`), not
  a general-purpose fetch tool. The spec's §5.1 rule ("if `upcoming_count`
  is blank, call `get_appointments(job_id)` before rendering anything") is
  a voice-agent-shaped instruction that doesn't map onto chat's actual
  mechanism and should be corrected in the spec rather than implemented
  as-is.

- **`create_appointment`** exists and is already scoped correctly —
  bound only in the `no_appointment` phase
  (`tools/handlers/create-appointment.js`, `registry.js`), matching the
  spec's S5 exactly. No gap here.

---

## 8. Phasing recommendation

1. **§1 (all-appointments-upfront) + §2's two gate fixes** ship largely
   independently of everything else and unblock the core UX change. No
   payload contract changes; this is prompt rewrites (opening message,
   `STEP_3`, `computeInputHint`) plus two small, well-scoped bug fixes.
2. **§4 (confirmer identity)** is the next-biggest, self-contained piece —
   new storage + a capture point + threading into `ctx`, then handler
   updates across the 5 action tools. Doesn't block §1/§2.
3. **§5 (onsite-expectations-as-data)** and **§6 (read-only mode)** both
   hinge on open product questions (content coverage across companies,
   deterministic vs. soft matching, whether read-only mode is even in
   scope for this launch) — hold off starting backend work here until
   those are resolved (see §9 below).

---

## 9. Open decisions this doc doesn't resolve

The spec's own §10 lists these as needing a product/eng call — restated
here against the specific backend sections they block, rather than
assumed:

- **§10.3 (real availability)** — affects whether reschedule's date-time
  picker can show bookable slots; no backend inventory/availability system
  was found or assumed in this research. Separate investigation if pursued.
- **§10.4 (identity timing)** — affects §4's capture-point design (at
  first confirm vs. an upfront verification step) but not its storage
  shape.
- **§10.5 (`confirmed_by` storage approach)** — §4 above gives a
  recommendation, but the spec explicitly leaves the final call open.
- **§10.2 (live vs. read-only)** — directly gates whether §6 needs building
  at all.
- **§10.1 (channel)**, **§10.6 (silence handling)**, **§10.7 (async
  session lifecycle)** — not investigated in this pass; flagged only
  because they're listed as still-open in the source spec.
