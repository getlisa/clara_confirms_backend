# Pre-visit instructions by job type — Frontend Guide

> **For the frontend agent.** A company can now author instructions the
> *customer* must act on before the technician arrives, scoped to a job type.
> The agent delivers them at the end of a confirmation call or chat. This is a
> new CRUD surface — same conventions as `deficiencies-frontend.md`.

Base URL: `VITE_API_URL` · Auth: `Authorization: Bearer <token>` on every endpoint.

---

## 1. What this is, and what it is not

The driving example, from the Ultimate Fire kickoff:

> **Fire suppression:** appliances must be turned off when the technician
> arrives. The team can't inspect with fryers on.

These are **preconditions**. If one is not done, the visit cannot go ahead.
That makes them different from the two things they sit next to in the UI and in
the agent's prompt — worth keeping distinct in the interface too:

| | what it is | who acts |
|---|---|---|
| **Pre-visit instructions** (this doc) | must be done *before* the visit, or it fails | the **customer**, before the visit |
| Open items / deficiencies | optional repair work being *offered* | the company, if the customer accepts |
| Onsite expectations | what to *expect* during the visit (noise, access) | nobody — it is narration |

Do not merge these into one "site notes" panel. The agent is explicitly
forbidden from presenting a pre-visit instruction as optional, and the UI
should not imply otherwise either.

---

## 2. `GET /job-type-instructions/job-types` 🔒 — **use this for the picker**

The single most important endpoint here. Job types are **CRM free text**, not a
fixed enum, and an instruction written against a value that no job carries will
never fire.

```json
{
  "job_types": [
    { "job_type": "fire suppression",       "label": "Fire Suppression",       "job_count": 469 },
    { "job_type": "semi annual inspection", "label": "Semi Annual Inspection", "job_count": 375 },
    { "job_type": "hood cleaning",          "label": "Hood Cleaning",          "job_count": 284 },
    { "job_type": "dole ripening room",     "label": "DOLE Ripening Room",     "job_count": 210 },
    { "job_type": "fire extinguishers",     "label": "Fire Extinguishers",     "job_count": 136 }
  ]
}
```

- **Show `label`, submit either** — the backend normalises on write, so
  `"Fire Suppression"`, `"fire suppression"` and `"  FIRE SUPPRESSION  "` all
  resolve to the same key.
- **Show `job_count`.** It is how a user tells a real job type from a stray one.
- Free text is still accepted on `POST`. Prefer the picker, and if you do allow
  a typed value, warn when it is not in this list — it will silently never
  match. There is no error for this; it just never fires.

### The one asymmetry to surface

The available job types depend on the CRM, because `jobs.job_type` means
different things:

| CRM | `job_type` holds | so an instruction can be scoped to |
|---|---|---|
| **InspectPoint** | the inspection/system type | `Fire Suppression`, `Hood Cleaning` — exactly the ticket's example |
| **ServiceTrade** | a generic category slug | `inspection`, `installation`, `service_call` — **not** a specific system |

On ServiceTrade a user can write "for all inspections…" but **cannot** express
"for fire suppression inspections only" — that distinction lives in service
lines there, which this feature does not key on. Don't promise finer scoping
than the picker offers; the picker is the honest answer in both cases.

---

## 3. `GET /job-type-instructions` 🔒

Returns the same rows twice — flat, and grouped ready for display.

| query param | |
|---|---|
| `job_type` | filter to one type (any casing) |
| `active` | `true` for only active rows; default returns both |

```json
{
  "instructions": [
    { "id": 1, "company_id": 11,
      "job_type": "fire suppression", "job_type_label": "Fire Suppression",
      "instruction": "All cooking appliances must be switched off before the technician arrives — the system cannot be inspected with fryers or burners running",
      "requires_acknowledgement": true, "sort_order": 0, "active": true,
      "created_at": "2026-10-01T15:36:27.000Z", "updated_at": "2026-10-01T15:36:27.000Z" }
  ],
  "by_job_type": [
    { "job_type": "fire suppression", "job_type_label": "Fire Suppression",
      "instructions": [ /* same objects */ ] }
  ]
}
```

`job_type` is the **match key** (normalised); `job_type_label` is the **display
form** and is what you should render. `job_type_label` always has a value — it
falls back to the key rather than coming back null.

---

## 4. Create, update, delete 🔒

### `POST /job-type-instructions` → **201**

```json
{ "job_type": "Fire Suppression",
  "instruction": "All cooking appliances must be switched off before the technician arrives",
  "requires_acknowledgement": true,
  "sort_order": 0 }
```

Only `job_type` and `instruction` are required.

| status | when |
|---|---|
| **400** | `job_type is required` · `instruction is required` · `instruction must be 400 characters or fewer` |
| **409** | `This instruction already exists for that job type` — same text on the same job type, **matched case-insensitively** |

The 400s and the 409 both carry a human-readable `error` string; show it
directly rather than a generic failure.

**The 400-character cap is real and worth surfacing as a live counter.** All
instructions for one job type are concatenated into a single agent variable
capped at 500 characters total, so one long entry crowds out the others.

### `PATCH /job-type-instructions/:id` → 200

Any subset of `job_type`, `instruction`, `requires_acknowledgement`,
`sort_order`, `active`. Returns the updated row. **404** if it is not this
company's. Same **409** as above.

### `DELETE /job-type-instructions/:id` → **204**, or 404

`active: false` via PATCH is the softer option: the agent stops delivering it
immediately, but it stays visible and restorable in the UI. Prefer offering
both — a deactivate toggle and a delete.

---

## 5. `requires_acknowledgement` — what it actually changes

| | the agent |
|---|---|
| `false` | **states** it and moves on |
| `true` | **asks** and will not continue until it gets a clear yes; a vague reply or silence is not accepted. In chat the answer is recorded for staff. |

Label it in those terms — *"Require the customer to confirm"* — not as a
priority or severity. It is about whether the agent waits, nothing else.

Use `true` sparingly. Every flagged instruction is another thing the call cannot
end without, and the fryers case is the one that genuinely earns it.

---

## 6. When the customer actually hears this

Delivered **last**, after the appointment is settled and after the arrival
window — never in the opening message. Deliberate: it is the one thing in the
conversation the customer must act on themselves days later, so it is what the
agent leaves them with.

**Skipped entirely when the visit is cancelled** and nothing is rebooked.

Worth saying in the UI, because it sets expectations about where these appear in
a transcript — near the end, not up front.

---

## 7. Things to get right

**Don't require a job type to have jobs.** A company may legitimately prepare an
instruction for a type that is seasonal or not yet synced. Warn, don't block.

**Don't invent a severity, priority or category.** There is no such field and
the agent has no notion of one. `requires_acknowledgement` is the only
modifier.

**Don't offer rich text, links, or placeholders.** The instruction is read aloud
verbatim by a voice agent. Markdown, URLs and `{{variables}}` would be spoken
as punctuation. Plain sentences only.

**Expect zero.** Every company starts with none, and the feature is optional by
design — the empty state is the common case, not an error. Make the empty state
explain what this is for, with the fryers example.

**`sort_order` controls spoken order** within a job type, not display priority.
If you expose drag-to-reorder, that is what it changes.

---

## 8. Not in scope

- **Scoping by service line** (§2) — would be needed for ServiceTrade parity.
- **Recording whether the customer complied.** The agent waits for a yes on a
  flagged instruction, and in chat reports it for staff, but there is no field
  on the job that says "the site confirmed the fryers would be off". Same
  missing write-back as CMAP-229.
- **Per-location overrides.** These are company-wide per job type; a single site
  cannot have its own.
