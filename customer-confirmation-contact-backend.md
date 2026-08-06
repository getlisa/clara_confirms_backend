# Frontend-Requested Backend Changes — Per-Customer Confirmation Recipients

> ✅ **IMPLEMENTED** (migration `081_confirmation_recipients.sql`). Everything
> in this doc shipped as proposed, with the deviations/decisions noted inline
> below in **bold callouts** — read those before wiring the frontend up, a
> couple of response shapes differ slightly from the original ask.
>
> Written from the frontend (`clara-confirms`), same convention as
> `frontend-requested-changes-v2.md`.

## Context

The ask: let a service manager pick, per customer, **which people** actually
receive the confirmation call/text/link — and more than one person can be
relevant at once (e.g. a property manager *and* the tenant should both
confirm). Today the dispatch path (`scheduler.js`, `manual-call.js`,
`channel-resolver.js`) always resolves to exactly one target:
`customers.phone` / `customers.email`. There is no `contact_id` anywhere in
that path, and no per-send override beyond a free-text `phone_number`/`email`
param on manual triggers.

This matters because `contacts` already models real people beyond the
customer record itself — e.g. a property manager, tenant, or site contact who
should also confirm, not just whoever's phone number happens to be on the
`customers` row. But there's currently no way to express "for this customer,
confirmations also go to contact #X and #Y" anywhere in the schema:
- `contacts` has no direct `customer_id` — it's linked via the
  `contact_companies` junction (and separately via `contact_locations`).
- `contacts.contact_role` (`primary`/`general`) is **account-wide**, not
  customer-scoped — it doesn't answer "who's primary *for this customer*."
- `jobs.primary_contact_id` and `locations.primary_contact_id` are job- and
  location-scoped, singular, and not a customer-level concept either way.

So this doc proposes the smallest addition that closes the gap: one boolean
and one contact-id array on `customers`, one new read endpoint to populate the
checklist, and the dispatch-side fan-out to actually honor a multi-recipient
list.

---

## 1. Two new `customers` columns

**Migration:**
- `customers.confirmation_include_customer BOOLEAN NOT NULL DEFAULT true`
- `customers.confirmation_contact_ids INTEGER[] NOT NULL DEFAULT '{}'`
  (Postgres integer array; a join table `customer_confirmation_contacts
  (customer_id, contact_id)` works equally well if an array column is awkward
  for your existing tooling — either shape is fine as long as it round-trips
  as a plain JSON array of ids in the API response.)

- `confirmation_include_customer: true` (default) — dispatch keeps sending to
  `customers.phone`/`customers.email` exactly as it does today, in addition
  to whatever's in `confirmation_contact_ids`.
- `confirmation_include_customer: false` — the customer's own phone/email is
  **not** a dispatch target; only the listed contacts receive it.
  **✅ Built as a hard `400`, not a silent no-op** — `PATCH /customers/:id`
  rejects `include_customer: false` + an empty `confirmation_contact_ids`
  with `{"error": "At least one confirmation recipient is required — include
  the customer or select at least one contact."}`. Same shape/precedent as
  the existing `is_voice`/`is_sms`/`is_email` "at least one channel" check.
- `confirmation_contact_ids: []` (default) — no extra recipients, unchanged
  from today's behavior.
- **✅ Built the ownership check** (was cheap) — every id in
  `confirmation_contact_ids` must resolve via `contact_companies` for *this*
  customer, or the whole PATCH is rejected with a `400` listing which id(s)
  didn't match: `{"error": "These contact ids are not linked to this
  customer: 8843, 9012"}`. Bad ids are never silently dropped from the saved
  array.

**Expose via the existing customer endpoints** — no new shape needed beyond
adding the two fields:
- `GET /customers/:id` → include both fields in the response alongside
  `is_voice`/`is_sms`/`is_email`.
- `PATCH /customers/:id` → accept `confirmation_include_customer: boolean`
  and/or `confirmation_contact_ids: number[]` in the body, same as any other
  customer field. The frontend PATCHes one field at a time per checkbox
  toggle (sending the full new array on a contact toggle, not a diff), so
  partial updates to either field independently must both work.

---

## 2. `GET /customers/:id/contacts` — new endpoint

Populates the recipients checklist on the Customers page — the list of people
who could additionally receive this customer's confirmations.

**Response:**
```json
{
  "contacts": [
    {
      "id": 8842,
      "name": "Maria Chen",
      "first_name": "Maria",
      "last_name": "Chen",
      "phone": "+14155550110",
      "mobile": "+14155550199",
      "alternate_phone": null,
      "email": "maria.chen@example.com",
      "contact_role": "primary"
    }
  ]
}
```
- Scope: contacts linked to this customer via `contact_companies` (matching
  how `JobDetail.contacts` already resolves customer-side people for a job —
  same `source: "contact"` population, just without the job-scoped `role`
  field since there's no job in play here).
- `contact_role` is the account-wide field described above — include it for
  display (e.g. a "Primary" badge) but the frontend won't treat it as
  authoritative for anything.
- Empty array (not 404) when a customer has no linked contacts — the "send to
  the customer's own phone/email" checkbox always remains available
  regardless.

---

## 3. Dispatch wiring — fan out to every selected recipient

The part that actually makes the setting do something, and the part that's
genuinely new complexity versus the single-contact version of this ask: a
send can now target **more than one person**, and voice and link-based
channels fan out differently.

In both:
- `scheduler.js` (nightly automatic sweep)
- `manual-call.js` (manual trigger from Inspections/job sheet)

resolve the recipient list first:

```
recipients = [
  ...(customer.confirmation_include_customer
        ? [{ phone: customer.phone, email: customer.email }]
        : []),
  ...confirmation_contacts.map(c => ({ phone: c.phone ?? c.mobile, email: c.email })),
]
```

Then, per channel (`is_voice`/`is_sms`/`is_email` still govern *which*
channels fire, unchanged):
- **`sms` / `web_chat` (link-send)** — straightforward fan-out: create/send
  one chat-link per recipient with a phone or email, same as sending N
  independent links today via the manual per-contact override. Each recipient
  gets their own token and can respond independently; treat them as
  independent conversations rather than trying to synchronize state across
  them.
- **`voice`** — a live call is inherently one-to-one, so "voice to 2
  recipients" means **two separate scheduled call attempts**, one per
  recipient's phone, not one call with multiple parties. This multiplies call
  volume/cost linearly with recipient count.

  > **✅ Decided: automatic sweep fans out (as above); manual "Call Now" does
  > not.** For the nightly sweep and `POST /jobs/bulk-send-confirmation`,
  > voice fans out exactly as proposed — N recipients = N scheduled calls,
  > queued hours apart via the normal dispatcher. For a **manual, synchronous**
  > "Call Now" click with no explicit `phone_number` override, though, we
  > decided that dialing several simultaneous LIVE calls from one button press
  > is a bigger cost/UX surprise than the same fan-out happening invisibly
  > overnight — so manual Call Now still dials **only the customer's own
  > number**, ignoring `confirmation_contact_ids` for that one action.
  > Manual "Text Now"/"Email Now" (link-send) DO fan out to every recipient,
  > same as the automatic path — see the `additionalRecipients` note below.

- Per-recipient skip semantics (`missing_phone`/`missing_email`) apply
  per-recipient, not to the whole customer — one recipient missing a phone
  shouldn't block sending to the others. Verified live: a customer with no
  email on file (but `is_email` selected) correctly got a `missing_email` todo
  and was skipped, while a linked contact who does have an email still queued
  and received its own confirmation email.
- The manual-trigger free-text `phone_number`/`email` override (already
  supported today) keeps taking precedence over the resolved recipient
  list when present — it's a one-off, more specific override that bypasses
  the customer's saved preferences entirely, and disables the recipient
  fan-out for that call (single-target, as before).

> **New in `POST /calls/manual`'s response:** an `additionalRecipients` array
> (only present when non-empty) reports any extra confirmation contacts
> queued alongside the primary target for a link-send — e.g.
> `[{ "recipientContactId": 8842, "scheduledCallId": 5821 }]`. The main
> response fields (`scheduledCall`, `dialed`, `chatLinkToken`, etc.) still
> describe only the primary target, exactly as documented elsewhere —
> `additionalRecipients` is purely additive, not a breaking shape change.

---

## Not requested in this pass

Other per-customer parameters that came up while scoping this but aren't part
of the current ask — noting them here so they're not lost, not requesting
them yet:

- **Do-not-contact / opt-out flag** — distinct from
  `confirmation_include_customer: false` with an empty contact list (which
  the frontend already allows, per §1 above) — this would be an explicit
  "don't send confirmations for this customer, ever" flag that also suppresses
  the nightly sweep from even attempting to resolve recipients, rather than
  resolving to an empty list every time.
- **Per-customer auto-schedule opt-out** — `call_settings.auto_schedule_enabled`
  is company-wide only; some customers may need to always be handled manually
  regardless of the company default.
- **Per-customer CRM comment writeback override** — same shape gap as above;
  `crm_comment_writeback_enabled` is company-wide, with no per-customer
  exception.
- **Per-customer max-attempts override** — if retry/backoff limits are
  configurable company-wide, a customer-level override for "try harder" or
  "give up sooner" customers.

None of these are blocking for the confirmation-recipients checklist —
flagging them as candidates for a future pass if/when they come up.
