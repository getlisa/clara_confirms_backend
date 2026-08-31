# Pre-call context — test catalog

Tests for the change that **sends the entire job context up front instead of making the agent fetch it mid-conversation** (commit `89863af`).

Before: the voice agent could say nothing about the visit until `get_appointments` returned, and covered the round trip with "Let me pull up the appointments on this job." After: the dispatcher computes the job's appointment picture from the `jobCtx` it already builds and binds it as Retell dynamic variables at dispatch, so the opening line names the real service, date and technician immediately. Tool calls are still there — they just came off the critical path. Trimming them is a later pass.

```bash
npm test          # node --test "test/**/*.test.js"
```

**56 tests, no external services, no database.** Runtime ~200ms. Uses Node's built-in `node:test` — no new dependencies.


| File                                                                                 | Tests | Surface                                                                |
| ------------------------------------------------------------------------------------ | ----- | ---------------------------------------------------------------------- |
| [test/precall-context.dispatcher.test.js](test/precall-context.dispatcher.test.js)   | 23    | Voice — what reaches Retell as `retell_llm_dynamic_variables`          |
| [test/precall-context.chat-prompt.test.js](test/precall-context.chat-prompt.test.js) | 23    | Chat — the system prompt the LangGraph agent is rebuilt with each turn |
| [test/precall-context.variables.test.js](test/precall-context.variables.test.js)     | 10    | The contract between dispatcher, prompt template and variable catalog  |


---



## 1. Voice dispatch — `precall-context.dispatcher.test.js`

Drives the **real** `runDispatcher` end to end. Only the edges are faked (DB, Retell, chat-link delivery) via `require.cache` injection — `job-confirmation-context`, the spoken-date formatting and the variable-binding block are all the real code. Each test captures the `dynamicVariables` object that would have been handed to `retell.createCall`.

Fixtures are shaped the way `db/jobs.getJobById` returns rows (newest-first, `services[]` attached per appointment), so the context builder does its real work.

### The normal case


| Scenario                             | What must hold                                                                                                                                                                                                                                              |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3 upcoming, 1 already confirmed      | `upcoming_count="3"`, `unconfirmed_count="2"`, `all_upcoming_confirmed="false"`, `next_*` populated from the earliest visit, and a 3-line `upcoming_appointments` list with exact `#id date for service with tech (confirmed|not yet confirmed)` formatting |
| DB returns appointments newest-first | The list is re-sorted earliest-first, **and** `next_appointment_id` / `next_appointment_date` match the first line of the list — the pre-bound facts and the pre-rendered list can never disagree                                                           |




### Count branches the opening script keys off

The prompt picks different wording per count ("you have N upcoming appointments" vs naming the single visit vs "I don't see a visit booked"), so each branch is pinned.


| Scenario                                                      | What must hold                                                                                                     |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Exactly 1 upcoming                                            | `upcoming_count="1"`, single-line list                                                                             |
| Every upcoming already confirmed                              | `all_upcoming_confirmed="true"`, `unconfirmed_count="0"`, no `(not yet confirmed)` anywhere in the list            |
| Zero upcoming (only a completed past visit)                   | Counts are `"0"`; **no** `next_`* **variables and no** `upcoming_appointments` **are invented**                    |
| Mixed statuses — completed, cancelled, rescheduled, confirmed | Only future `rescheduled` + `confirmed` count as upcoming; a **cancelled** visit is never offered for confirmation |




### The 8-appointment cap

`upcoming_appointments` rides in every turn's context, so it is capped — but the *count* must stay truthful.


| Scenario                        | What must hold                                                               |
| ------------------------------- | ---------------------------------------------------------------------------- |
| Exactly 8 (boundary)            | All 8 listed, no truncation tail                                             |
| 9 (boundary + 1)                | 8 lines + `...plus 1 more — call get_appointments to see the rest.`          |
| 30 (recurring-service contract) | `upcoming_count="30"`, 8 lines + `...plus 22 more`, total payload under 2 kB |




### Missing fields on the next appointment


| Scenario                             | What must hold                                                                         |
| ------------------------------------ | -------------------------------------------------------------------------------------- |
| No technician assigned               | `next_technician=""` — not `"null"`, not `"undefined"`, and no `with null` in the list |
| Appointment has no service line      | Falls back to the job title; no `for null` in the list                                 |
| No service line **and** no job title | Falls back to the speakable `"your upcoming visit"`                                    |




### Degradation — when there is no context to send

The design contract is that a failure degrades to **blank**, which is the prompt's documented "fall back to `get_appointments`" signal. Blank is safe; a wrong value is not.


| Scenario                               | What must hold                                                                                                                                           |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Job not found / context fails to build | Every appointment variable is **absent**, a warning is logged, and the call still fires (`fired: 1`) — pre-binding must never be able to fail a dispatch |
| Synthetic job id (`quotation:44`)      | Job-context block skipped entirely; no appointment queries issued; `total_amount` still bound                                                            |
| `technician_confirmation` call type    | No job-level appointment context; its own single `appointment_id` still bound                                                                            |




### Who the call is actually with


| Scenario                                             | What must hold                                                                                                                                             |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Row is for a confirmation contact (property manager) | `customer_name` is the **contact's** name; `customer_email`/`customer_phone` come from the recipient snapshot; **zero** extra customer lookups at dispatch |
| No recipient contact                                 | Falls back to the customer's own name, with email/phone re-read fresh (exactly one lookup)                                                                 |
| Customer has no email on file                        | `customer_email` is left unbound rather than set to a bogus value                                                                                          |
| Neither recipient nor customer name                  | `customer_name` omitted rather than bound blank                                                                                                            |




### Cross-cutting invariants


| Scenario                                      | What must hold                                                                                                                                                                                |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fully-populated job with past + future visits | Every variable is a **string** (Retell requirement) and **no raw ISO timestamp** appears in any value — the agent reads them aloud verbatim. Dates are in spoken form (`… at 10:00 AM`)       |
| Job with scheduling comments                  | Job-level context (`job_number`, `job_comments`) still rides along with the new appointment context                                                                                           |
| Same job, both paths                          | The pre-bound variables agree field-for-field with what `get_appointments` (`toAppointmentsPayload`) would return — the central risk of pre-binding is two sources of one fact drifting apart |
| Any dispatch                                  | Pre-binding adds **no extra query**: the context comes from the job read the dispatcher already did                                                                                           |


---



## 2. Chat prompt — `precall-context.chat-prompt.test.js`

The chat agent has **no** `get_appointments` **tool at all** — everything it can know is in the system prompt, rebuilt fresh from `jobCtx` every turn. `prompt.build` is pure, so these run against the real function with no stubs.

The recurring risk here is a prompt that reads plausibly but states something false: the wrong person's name, a count that contradicts the list beneath it, a phase branch that collapsed into another, or a literal `null`.

### Who the agent thinks it's talking to


| Scenario                          | What must hold                                                                      |
| --------------------------------- | ----------------------------------------------------------------------------------- |
| Conversation is with the customer | Greeting uses the customer's name                                                   |
| Conversation is with a contact    | Greeting uses the **contact's** name, and the customer's name appears nowhere in it |
| Nobody is named                   | Falls back to "the customer"; no `null` in the output                               |




### Contact info presented rather than asked for


| Scenario         | What must hold                                                                     |
| ---------------- | ---------------------------------------------------------------------------------- |
| Email on file    | "I have your email on file as …" instead of asking blind                           |
| No email on file | Explicitly instructs the agent to ask                                              |
| No phone on file | The optional phone line is dropped — the prompt must not contain the string `null` |
| Phone on file    | Offered as the `phone` argument to `resolve_service_link_contact`                  |




### The appointment picture


| Scenario                  | What must hold                                                                                                                                 |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 2 upcoming, one confirmed | Header count plus exact per-line format including confirmed state                                                                              |
| Job has past visits       | Listed with their **real status** (`completed`), not confirmed/not-confirmed wording, which only makes sense for something still ahead         |
| 12 upcoming               | Summarized by count, `...plus 11 more, scheduled through …`, pointed at `list_upcoming_appointments`; the middle of the list is not half-shown |
| Exactly 8 (boundary)      | Still listed in full                                                                                                                           |
| Zero upcoming             | Says so plainly                                                                                                                                |




### Which appointment to ask about


| Scenario                                             | What must hold                                                                                                                                               |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Earliest visit already confirmed, a later one is not | Targets the earliest **unconfirmed** one (`#12`), not `upcoming[0]` — happens when the customer confirmed the near visit by voice, then opens the chat later |
| Appointment carries a service description            | The verbatim opening greeting names the specific request, e.g. `regarding Sprinkler / Fire Protection (Fix the broken flanges)`                              |
| No per-appointment service detail                    | Greeting falls back to the job description                                                                                                                   |




### Phase branches

Covers the pre-existing bug this change fixed: `agentNode` never passed `state.phase` into `prompt.build`, so `no_appointment` / `all_confirmed` / `confirming` had all silently collapsed into one branch.


| Scenario                        | What must hold                                                                                                             |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| All three phases                | Each produces its own goal block, the other blocks are absent, and all three prompts differ                                |
| All-confirmed job, opening turn | Does **not** emit the verbatim "confirm this for me" greeting; instructs the agent not to ask as though nothing is on file |




### Other


| Scenario                                               | What must hold                                                                             |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Appointment already confirmed by a different recipient | That block overrides both the greeting and the goal — no re-asking                         |
| Company has service-line descriptions                  | Injected as a `SERVICE DETAILS` reference block, with the instruction not to force a match |
| No descriptions configured                             | Block omitted entirely rather than left empty                                              |
| Fully-populated prompt                                 | Contains no `undefined`, no `null`, no `[object Object]`, no raw ISO timestamp             |
| 1 / 2 / 5 / 8 upcoming                                 | The header count always equals the number of lines listed beneath it                       |
| Every branch                                           | The anti-hallucination rule and a defined way to end the conversation both survive         |


---



## 3. Variable contract — `precall-context.variables.test.js`

Three places have to agree about every dynamic variable:

1. `services/scheduler.js` binds it at dispatch — **conditionally**
2. `db/call-type-configs.js` references it as `{{name}}` in the prompt
3. `db/dynamic-variable-definitions.js` registers it in the catalog

(3) is not bookkeeping. `retell-flow.syncFlowForCompany` builds the flow's `default_dynamic_variables` from that catalog, and it is the only thing that gives an unbound variable an empty-string default. **A** `{{name}}` **referenced in a prompt but missing from the catalog renders as the literal text** `{{name}}` **whenever the dispatcher doesn't set it — spoken aloud to the customer.** Pre-binding made that reachable, because every new variable is conditional on there being a next appointment or an email on file.

### Registration


| Scenario                                                      | What must hold                                                                                                               |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| The 8 pre-bound appointment variables                         | All registered in the catalog                                                                                                |
| Every `{{placeholder}}` in the `customer_confirmation` prompt | Registered                                                                                                                   |
| Every `{{placeholder}}` in every built-in call type's prompt  | Registered                                                                                                                   |
| `begin_message` specifically                                  | Every placeholder registered — it is the first thing spoken, before any tool call or conditional prompt logic can compensate |




### Guardrails the change depends on

Pre-bound values are a call-start snapshot. That is only safe because the prompt carries two explicit rules; if either is edited away, the agent starts quoting stale counts after a write, or talks about appointments it was never given. Neither failure is visible in the dispatcher's output, so it's asserted on the prompt text.


| Scenario             | What must hold                                                                                                                     |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Staleness rule       | Prompt states the values do not update during the call, and requires `get_appointments` after any confirm/reschedule/cancel/create |
| Blank-value fallback | Prompt tells the agent to call `get_appointments` when `{{upcoming_count}}` is blank                                               |
| Latency goal         | STEP 1 no longer opens with a tool call, and `begin_message` carries the real service and date                                     |
| Truncated list       | Prompt tells the agent what to do past the `...plus N more` cutoff                                                                 |




### Catalog hygiene


| Scenario                                   | What must hold                                                                                                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Catalog well-formed                        | No duplicate names (the last seed would silently win), no duplicate `sort_order`, every entry has a description and a `resolved_from`                              |
| Appointment variables documented correctly | `resolved_from` says *live at dispatch* — if someone re-sources one from the queued row, the staleness bug this change reasoned its way around comes straight back |


---



## Bug found

The registration tests failed on first run. `{{next_service_line}}` and `{{next_appointment_date}}` were used in `begin_message` but never registered, and the dispatcher only sets them when the job **has** a next appointment. On a job with zero upcoming appointments — or whenever the job context failed to build — Retell had no default and the call would open by speaking the literal string `{{next_service_line}}` at the customer. `{{customer_email}}` in the new service-link step had the same gap.

This is exactly the failure mode the commit message describes guarding against ("unregistered, the fallback path would speak a literal `{{upcoming_count}}` aloud") — the six count variables were registered; these three were missed.

**Fixed** in [src/db/dynamic-variable-definitions.js](src/db/dynamic-variable-definitions.js): registered `next_appointment_date`, `next_service_line`, `customer_email`, `customer_phone`.

Also registered `is_chat_session` — a **separate, pre-existing** gap the same test surfaced. It's referenced throughout the prompt but has had no producer since the web-chat path moved to the LangGraph agent, so it was rendering literally on every voice call. Registering it resolves it to `""`, which reads as the correct "not a chat session" branch.

> **Deploying the catalog fix** needs `POST /admin/sync-tools` (reseeds the catalog) followed by `POST /admin/sync-flows` (pushes `default_dynamic_variables` to Retell). The change has no effect on live calls until the flow is re-synced.

---



## Not covered

Worth knowing before trusting a green run:

- **No live Retell round trip.** These assert on what is *handed to* `retell.createCall`, not on what Retell renders. Placeholder-substitution behaviour on Retell's side is inferred from `default_dynamic_variables`, not observed.
- **No real database.** `db.query` is routed by SQL substring. A schema change that breaks a real query is invisible here.
- **No model behaviour.** Whether the agent actually *obeys* the staleness rule or the blank-value fallback is asserted on prompt text only — that the instruction is present, not that it works.
- **Office-hours gating is bypassed** (`NODE_ENV=development`); it is unrelated to this change.
- **The chat agent's graph wiring** (`build.js` — `recompute_context`, service-line descriptions fetched into state) is not tested; only the prompt it produces is.

