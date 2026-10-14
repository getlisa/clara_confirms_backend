# Agent prompt editor — Frontend Guide

> **For the frontend agent.** Admins can now edit the instructions their voice
> agent follows, per call type, from the platform. Saving updates the live
> Retell agent immediately; the very next call uses the new prompt. This doc is
> the full API contract plus the UI behaviour the backend expects.

Base URL: `VITE_API_URL` · Auth: `Authorization: Bearer <token>` on every endpoint.
🔒 = any authenticated user · 🔒👑 = **admin only** (`user.role === "admin"`, else `403`).

---

## 1. Concepts — read this first

### 1.1 What the user edits

Each call type (`customer_confirmation`, `technician_confirmation`, custom
types, …) has **one editable text: `general_prompt`**. It is the agent's whole
instruction set for that call type, *including the opening line* (the
`[Opening]` section at the top).

> **Do not build an editor for `begin_message`.** It is a legacy field and is
> not sent to Retell. The opening line lives inside `general_prompt`.

### 1.2 Managed blocks — shown, never edited

Two blocks are **added automatically** when the prompt is pushed to Retell.
They are *not* part of `general_prompt`, cannot be edited, and must be shown
read-only under the editor so the user understands the full prompt:

| key | when it is active | controlled by |
|---|---|---|
| `service_link` | `customer_confirmation` only — when the CRM supports service links **and** *"Email the service link after confirmation"* is on | `call_settings.service_link_enabled` |
| `read_only` | every call type — when the agent may not change appointments | `call_settings.agent_can_make_changes` (`false` ⇒ active) |

Turning those settings on/off updates the live agent directly (§9) and **never
touches the user's text**.

### 1.3 Customized vs default

- `prompt_customized: false` → the prompt is our default. It is kept up to date
  automatically when we improve the default prompt.
- `prompt_customized: true` → the user edited it. **Automatic updates skip it
  forever**, until the user clicks *Reset to default*.
- Saving text that is byte-identical to the default sets it back to `false`.

### 1.4 Versions and conflicts

Every save increments `prompt_version`. Send the version you loaded as
`expected_version`; if someone else saved in between you get **`409`** with the
current row instead of overwriting them (§8).

### 1.5 Retell sync

A save writes our DB first, then pushes to Retell **in the same request**. The
response tells you what happened in `retell_sync.status`:

| status | meaning | UI |
|---|---|---|
| `synced` | live agent updated | ✅ "Saved — live on your agent" |
| `unchanged` | Retell already had exactly this text | ✅ same as synced |
| `not_provisioned` | this company/call type has no Retell agent node yet (e.g. call type disabled, onboarding not finished) | ℹ️ "Saved. It will be used once this call type is active." |
| `failed` | saved in our DB, **Retell not updated** | ⚠️ banner + **Retry** button → §7 |

The call type row also carries `retell_synced_at` and `retell_sync_error` so a
failure is still visible after a page reload.

---

## 2. The call type object

Returned by every endpoint below as `call_type` (and in the list in §3).

```json
{
  "type": "customer_confirmation",
  "name": "Customer Confirmation",
  "description": "Call the end customer to confirm their upcoming appointment.",
  "is_custom": false,
  "enabled": true,
  "begin_message": "Hi {{location_name}}, …",
  "general_prompt": "[Opening]\nGreet on the JOB only — …",
  "voicemail_message": "Hi, this is {{representative_name}} …",
  "prompt_customized": true,
  "prompt_version": 7,
  "prompt_updated_at": "2026-10-14T17:52:10.112Z",
  "prompt_updated_by": 42,
  "retell_provisioned": true,
  "retell_synced_at": "2026-10-14T17:52:11.006Z",
  "retell_sync_error": null
}
```

| field | notes |
|---|---|
| `is_custom` | `true` = a user-created call **type** (deletable). Unrelated to prompt editing. |
| `prompt_customized` | see §1.3 — show a "Customized" badge when `true` |
| `prompt_updated_by` | user id; resolve to a name from your users list |
| `retell_provisioned` | `false` ⇒ saves will return `not_provisioned` |
| `retell_sync_error` | non-null ⇒ the last push failed; show the warning + Retry |

`prompt_updated_at` / `prompt_updated_by` are `null` until the first edit.

---

## 3. `GET /agent-settings/call-types` 🔒 — list (unchanged endpoint, new fields)

```json
{ "call_types": [ { …call type object… }, … ] }
```

Use it for the call-type picker. Show the *Customized* badge and a ⚠️ if
`retell_sync_error` is set.

---

## 4. `GET /agent-settings/call-types/:type/prompt` 🔒 — open the editor

Everything the editor screen needs, in one call.

```json
{
  "call_type": { …call type object… },
  "default_prompt": "[Opening]\nGreet on the JOB only — …",
  "is_default": false,
  "managed_blocks": [
    {
      "key": "service_link",
      "title": "Service link (email after confirmation)",
      "active": true,
      "reason": "enabled",
      "controlled_by": "call_settings.service_link_enabled",
      "text": "━━━ SERVICE LINK (only AFTER the customer has confirmed at least one appointment) ━━━\n…"
    },
    {
      "key": "read_only",
      "title": "Read-only mode",
      "active": false,
      "reason": "setting_off",
      "controlled_by": "call_settings.agent_can_make_changes",
      "text": "[IMPORTANT: You are in read-only mode. …]"
    }
  ],
  "effective_prompt": "[Opening]\n… user text …\n\n━━━ SERVICE LINK …",
  "limits": { "min_chars": 20, "max_chars": 60000 }
}
```

| field | use it for |
|---|---|
| `default_prompt` | *Compare with default* (diff view) and to preview what *Reset* will write. `null` only if the type has no default. |
| `is_default` | hide *Reset to default* when `true` |
| `managed_blocks[]` | render read-only panels under the editor. `reason`: `enabled` · `setting_off` · `crm_unsupported` (CRM has no service link — say so, and do not link to the setting). When `active: false`, show the panel collapsed/greyed with "Not included — turn on *<setting>* to add it". |
| `effective_prompt` | a *Preview — what the agent receives* tab. Read-only. |
| `limits` | character counter + client-side guard |

`404` if the call type does not exist.

---

## 5. `POST /agent-settings/call-types/:type/prompt/validate` 🔒 — live validation

Dry run; saves nothing. Call it **debounced (~600 ms)** while the user types.

Request
```json
{ "general_prompt": "…current editor text…" }
```

Response `200`
```json
{
  "valid": true,
  "errors": [],
  "warnings": [
    {
      "code": "unknown_variables",
      "message": "These variables are not filled in on calls, so the agent would see them as literal text",
      "variables": ["customer_nmae"]
    },
    {
      "code": "default_variables_missing",
      "message": "The default prompt uses these variables and this version does not — the agent will not see that information",
      "variables": ["open_issue_details", "previsit_instructions"]
    }
  ]
}
```

**Errors** (block saving — disable *Save* while `valid: false`):

| code | when |
|---|---|
| `not_a_string` | body is not a string |
| `too_short` | trimmed text shorter than `limits.min_chars` |
| `too_long` | longer than `limits.max_chars` |

**Warnings** (show, do not block):

| code | extra field | suggested UI |
|---|---|---|
| `unknown_variables` | `variables[]` | highlight those `{{tokens}}` in the editor (likely typos) |
| `default_variables_missing` | `variables[]` | "The agent will no longer see: …". `job_id` / `next_appointment_id` missing is serious — the agent's booking tools need them; style that one as a strong warning. |
| `unbalanced_braces` | — | point at unmatched `{{` / `}}` |
| `contains_managed_section` | — | the user pasted a `━━━ SERVICE LINK` section in; tell them it is added automatically and offer to remove it |

---

## 6. Save — `PUT /agent-settings/call-types/:type/prompt` 🔒👑

Request
```json
{ "general_prompt": "…full new text…", "expected_version": 7 }
```

`expected_version` is optional but **always send it** (the `prompt_version` you
loaded). Omitting it disables conflict protection.

Response `200`
```json
{
  "call_type": { …updated call type object, prompt_version: 8… },
  "retell_sync": { "status": "synced", "synced_at": "2026-10-14T17:52:11.006Z" },
  "warnings": [ …same shape as §5… ]
}
```

`retell_sync` variants:
```json
{ "status": "synced",          "synced_at": "…" }
{ "status": "unchanged",       "synced_at": "…" }
{ "status": "not_provisioned" }
{ "status": "failed",          "error": "Retell API error: 503 …" }
```

Errors

| status | body | handle |
|---|---|---|
| `400` | `{ "error": "…", "code": "invalid_prompt", "validation": { "valid": false, "errors": […], "warnings": […] } }` | show `validation.errors` |
| `403` | `{ "error": "Only admins can edit the agent prompt" }` | hide/disable editing for non-admins up front (§13) |
| `404` | `{ "error": "Call type not found" }` | |
| `409` | `{ "error": "This prompt was changed by someone else since you opened it", "code": "version_conflict", "current": { …call type object… } }` | §8 |
| `500` | `{ "error": "Failed to update the agent prompt" }` | nothing was saved; let them retry |

> `PATCH /agent-settings/call-types/:type` with `general_prompt` (+ optional
> `expected_version`) behaves identically and returns the same
> `{ call_type, retell_sync, warnings }`. Prefer `PUT …/prompt` in the editor;
> keep `PATCH` for `enabled` / `name` / `description`. A change to `enabled`
> or `name` rebuilds the agent and returns `retell_sync` (`synced` / `failed`);
> a `description`-only change returns `retell_sync: null`.

---

## 7. Retry a failed sync — `POST /agent-settings/call-types/:type/prompt/sync` 🔒👑

No body. Pushes the **stored** prompt to Retell again (nothing is re-saved).

```json
{ "call_type": { … }, "retell_sync": { "status": "synced", "synced_at": "…" } }
```

Show this as the *Retry* action whenever `retell_sync.status === "failed"` or
`call_type.retell_sync_error` is non-null.

---

## 8. Conflicts (`409`)

Someone saved after this editor was opened. **Never auto-overwrite.** Show:

> "This prompt was changed by **<prompt_updated_by name>** at
> **<prompt_updated_at>**."  [View their version] [Keep editing mine]

- *View their version* → load `current.general_prompt` (keep the user's draft in
  a side panel / diff so nothing is lost).
- To save the user's text anyway, re-`PUT` with
  `expected_version: current.prompt_version` — an explicit, informed overwrite.

---

## 9. Reset to default — `POST /agent-settings/call-types/:type/prompt/reset` 🔒👑

Request (optional body)
```json
{ "expected_version": 8 }
```

Writes `default_prompt`, sets `prompt_customized: false` (automatic updates
resume), pushes to Retell. Response and errors exactly as §6.

Always confirm first: *"Replace your prompt with the default? Your current
version stays in History and can be restored."*

---

## 10. History — revisions

### `GET /agent-settings/call-types/:type/prompt/revisions?limit=50` 🔒

Newest first. `limit` 1–200, default 50.

```json
{
  "revisions": [
    {
      "id": 1312,
      "type": "customer_confirmation",
      "version": 8,
      "general_prompt": "…",
      "prompt_customized": true,
      "source": "edit",
      "created_by": 42,
      "created_at": "2026-10-14T17:52:10.112Z"
    }
  ]
}
```

`source`: `edit` (a save) · `reset` (reset to default) · `restore` (restored an
older revision). History starts with the first save after this release —
older versions do not exist.

### `POST /agent-settings/call-types/:type/prompt/revisions/:revisionId/restore` 🔒👑

Request (optional body): `{ "expected_version": 9 }`

Makes that revision's text the current prompt **as a new version** (history is
append-only) and pushes it to Retell. Response and errors as §6, plus `404`
`{ "error": "Revision not found" }` and `400 { "error": "Invalid revision id" }`.

---

## 11. Variables for autocomplete — `GET /dynamic-variables` 🔒 (existing)

```json
{
  "dynamic_variables": [
    { "name": "customer_name", "description": "Customer's full name.", "default_value": "", "resolved_from": "…", "enabled": true, "sort_order": 30, "updated_at": "…" }
  ]
}
```

Offer `{{name}}` autocomplete when the user types `{{`, with `description` as
the hint. This is the same list `unknown_variables` checks against.

---

## 12. Service-link setting now updates the live agent — `PATCH /call-settings` (existing, new field)

When `service_link_enabled` (or `agent_can_make_changes`) changes, the backend
now **waits** for the live agent to be updated before responding, and tells
you how it went:

```json
{
  "call_settings": { …, "service_link_enabled": true },
  "retell_sync": { "status": "synced" }
}
```

| `retell_sync.status` | meaning |
|---|---|
| `synced` | the confirmation prompt gained/lost the SERVICE LINK block and the service-link tools were added/removed |
| `skipped` | nothing agent-related changed (e.g. only business hours) |
| `failed` | setting saved, live agent **not** updated — `error` has the reason; show a warning and let them toggle again |

Because it now waits for Retell, this request can take a few seconds when one
of those two toggles changes — show a spinner on the toggle, don't optimistic-
flip it.

---

## 13. Screen checklist

1. **Call type list** — badge *Customized* (`prompt_customized`), ⚠️ when
   `retell_sync_error`.
2. **Editor** (`GET …/prompt`)
   - monospace textarea for `general_prompt`, character counter vs `limits`
   - `{{` autocomplete (§11), highlight unknown variables (§5)
   - debounced validate (§5); *Save* disabled while invalid or unchanged
   - read-only **managed block** panels under the editor (§1.2, §4)
   - tabs: *Edit* · *Preview — what the agent receives* (`effective_prompt`) ·
     *Compare with default* (diff `general_prompt` vs `default_prompt`)
   - actions: *Save* (👑), *Reset to default* (👑, hidden when `is_default`),
     *History* (§10), *Retry sync* (👑, only when failed)
   - warn on navigate-away with unsaved changes
3. **After save** — toast from `retell_sync.status` (§1.5); refresh
   `effective_prompt` by re-calling `GET …/prompt`.
4. **Non-admins** — read-only view of the same screen (no Save/Reset/Restore/
   Retry); the backend returns `403` for them anyway.

---

## 14. Don'ts

- Don't edit or send `begin_message` from the editor — it is not used.
- Don't let users edit the managed blocks or paste them into the prompt.
- Don't fire-and-forget the save: wait for the response, because
  `retell_sync` is the only way to know the live agent changed.
- Don't treat `failed` as "not saved" — the DB has it; only Retell is behind.
- Don't silently retry a `409`.
