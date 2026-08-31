# Confirmation Recipients by Contact Type — Frontend Guide

> **For the frontend agent.** One new call setting plus one new lookup
> endpoint. Same conventions as `crm-comment-writeback-frontend.md`.

Base URL: `VITE_API_URL` · Auth: `Authorization: Bearer <token>` on everything below.

---

## 0. What shipped

Confirmations used to go to the **customer record** (`customers.phone` /
`customers.email`), plus any contacts a manager hand-picked for that customer.
A company can now instead nominate one or more **contact types** — the CRM's own
labels like `on-site`, `scheduling`, `property manager` — and confirmations go
to the contacts carrying them.

Backend is complete and off by default (`[]`). Nothing changes for any company
until someone selects types.

### Precedence (worth surfacing in the UI, it will otherwise confuse people)

1. **Contacts explicitly picked on a customer win.** If a customer has entries
   in its recipients picker, this setting is ignored for that customer.
2. Otherwise, contacts of that customer whose type matches the selection.
   These **replace** the customer-record recipient.
3. If no contact matches, it falls back to today's behaviour — the customer
   record. A company enabling this can never silently stop confirming jobs.

### Two behaviours to communicate

- **Fan-out cap of 5.** Each recipient gets their own call / chat link, and a
  broad selection can match dozens of contacts for one customer (59 in real
  data). Only the first 5 are contacted — account-primary contacts first, then
  reachable ones. The rest are reported as a `RECIPIENTS_TRUNCATED` todo, one
  per customer, so nothing is dropped silently.
- **Contacts with no phone or email are still selected** and produce the usual
  `MISSING_PHONE` / `MISSING_EMAIL` todos. Expect a bump in those when a
  company first switches this on — roughly half of matched contacts in real
  data have no phone.

---

## 1. The setting — `confirmation_contact_types`

`string[]`, default `[]`. Values are stored normalised (lower-cased, trimmed,
de-duplicated); send whatever the picker returns and the backend canonicalises.

```json
// GET /call-settings  → 200
{
  "call_settings": {
    "business_hours_start": "09:00",
    "…": "…",
    "confirmation_contact_types": ["on-site", "scheduling"]
  }
}
```

```json
// PATCH /call-settings
{ "confirmation_contact_types": ["on-site", "scheduling"] }

// → 400 when not an array of non-empty strings
{ "error": "confirmation_contact_types must be an array of strings" }
```

Send `[]` to turn it off.

---

## 2. New endpoint — `GET /call-settings/contact-types`

Options for the picker. **Do not hard-code a list**: these are free-text CRM
labels that differ per company (one company has 140 distinct values).

```json
// GET /call-settings/contact-types  → 200
{
  "contact_types": [
    { "type": "on-site",    "contact_count": 270 },
    { "type": "management", "contact_count": 212 },
    { "type": "financial",  "contact_count": 112 },
    { "type": "scheduling", "contact_count": 91  }
  ]
}
```

Sorted by `contact_count` descending. Already normalised, so a value from here
can go straight back in the PATCH.

---

## 3. Suggested UI

**Call Settings → "Who receives confirmations"**

- Control: multi-select / checkbox list from `GET /call-settings/contact-types`,
  each row showing `type` and `contact_count`.
- Label: *"Send confirmations to contacts tagged as…"*
- Help text: *"Leave empty to contact the customer's main phone and email.
  Contacts picked on an individual customer always take priority over this."*
- Default: nothing selected.

**Show the counts.** The labels come from the CRM and are inconsistent —
`maintenance` and `Maintenace` both exist, as do `on-site` and `onsite`. The
count is how a user spots the variants and selects each one they need. Case and
surrounding whitespace are already normalised away; genuine misspellings are
not, and can't be.

Worth a warning next to any selection whose `contact_count` is large — that is
the case that hits the cap of 5 and generates truncation todos.

---

## 4. Checklist

- [ ] Add `confirmation_contact_types: string[]` to the call-settings type.
- [ ] Add `getContactTypes()` to the API layer for the new endpoint.
- [ ] Multi-select in Call Settings, populated from that endpoint, showing counts.
- [ ] Handle the 400 error string above.
- [ ] State the precedence rule in help text — per-customer picks override this.
- [ ] (Optional) Surface `RECIPIENTS_TRUNCATED` todos in the existing todo list
      so users see who wasn't contacted.
