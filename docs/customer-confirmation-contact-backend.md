# Frontend-Requested Backend Changes — Per-Customer Confirmation Recipients

> Written from the frontend (`clara-confirms`), same convention as
> `frontend-requested-changes-v2.md`: this describes what the backend needs to
> build, nothing here is implemented server-side yet. The frontend is
> proceeding to build its UI against this proposed contract immediately — the
> Customers page (`CustomersPage.tsx`'s "Customer Snapshot" sheet, and
> `CustomerDetailPage.tsx`) already has a multi-select recipients checklist
> wired up and calling `PATCH /customers/:id` with the two new fields below.
> Until the backend ships this, the "customer's own phone/email" checkbox
> still works (it maps to a plain boolean field), but the other-contacts list
> degrades to a "not available on this server yet" note (see
> `getCustomerContacts` in `src/lib/auth-api.ts`) rather than erroring.

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

**Separately discovered while scoping this**: every customer's
`is_voice`/`is_sms`/`is_email` currently sits at the same literal default
(`true`/`false`/`false` — voice only), regardless of the company's own
`call_settings.channel_strategy` (Settings → Channel). That default appears to
have been applied uniformly when the three flags replaced the old
single-valued `preferred_channel` (migration 080), rather than backfilled from
each company's actual chosen strategy. Practically, a company running
`sms_only` still has every customer individually flagged voice-only until
someone opens each one and fixes it by hand. §4 below covers this. (The
`channel_strategy` selector on the settings page previously also offered a
`web_chat_only` option; it's been removed there since the chat-link delivery
method it controlled — `chat_link_delivery_method` — applies whenever a link
send happens regardless of this strategy, not just under that one option. The
type only has three values now: `voice_only | sms_only |
voice_then_sms_fallback`.)

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
  **not** a dispatch target; only the listed contacts receive it. The
  frontend surfaces a warning when this is false and `confirmation_contact_ids`
  is also empty (nobody would receive anything), but does not block saving
  that state — treat it the same as today's "all three channels off" case if
  you'd rather reject it with a `400` than silently no-op.
- `confirmation_contact_ids: []` (default) — no extra recipients, unchanged
  from today's behavior.
- No validation requiring each referenced contact belong to this customer's
  own company/`contact_companies` linkage is assumed necessary from the
  frontend's side, but flagging it in case it's cheap to add as a safety net
  against cross-tenant mistakes.

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
  volume/cost linearly with recipient count — worth deciding whether that's
  actually desired for voice specifically, versus e.g. always falling back to
  link-send once more than one recipient is selected. Flagging this as a
  product decision rather than assuming the obvious fan-out is what you want;
  the frontend doesn't currently warn the user about this cost when they
  check multiple boxes with Call enabled.
- Per-recipient skip semantics (`missing_phone`/`missing_email`) apply
  per-recipient, not to the whole customer — one recipient missing a phone
  shouldn't block sending to the others.
- The manual-trigger free-text `phone_number`/`email` override (already
  supported today) should keep taking precedence over the resolved recipient
  list when present — it's a one-off, more specific override that bypasses
  the customer's saved preferences entirely.

---

## 4. `POST /customers/bulk-apply-channel-strategy` — new endpoint (replaces a frontend workaround)

The frontend has already shipped a stopgap for the default-drift problem
described above: Settings → Call Settings has an "Apply to all customers"
button (`CallSettings.tsx`, `handleApplyStrategyToCustomers`, behind a
confirmation dialog since it's a broad overwrite) that paginates through
every customer via `GET /customers` and issues an individual
`PATCH /customers/:id` with the flags computed from the company's current
`channel_strategy` AND `chat_link_delivery_method` (`channelStrategyToFlags`,
same file): `is_voice`/`is_sms` come from `channel_strategy` alone;
`is_email` comes from `chat_link_delivery_method` being `email`/`both`, since
no `channel_strategy` option involves email — without this, `is_email` would
be unreachable through the bulk action even when the company clearly wants
email as a delivery channel. **This applies
unconditionally to every customer, every time it's run** — including
customers who've had their channels individually customized via the
Customers page recipients checklist. That's a deliberate product choice (the
per-customer picker is for choosing *who* receives a confirmation, not for
overriding the company's *channel* strategy long-term), but it does mean
running this after enabling per-customer channel overrides will blow those
overrides away — worth deciding whether that's the behavior you want at the
database level too, or whether per-customer channel customization should be
exempted the way the frontend's very first version of this action did (only
touching customers still on the untouched default). Only a customer whose
flags already exactly equal the target is skipped, since that's a genuine
no-op write.

This works but doesn't scale: it's O(customers) individual round-trips from
the browser, serialized, with no server-side transaction — a page reload
mid-run just leaves the rest undone until re-triggered. A real bulk endpoint
would let this run as a single request:

**Request:** `POST /customers/bulk-apply-channel-strategy`, empty body — the
target flags are derived server-side from the company's own already-saved
`call_settings.channel_strategy` AND `chat_link_delivery_method`, not passed
in, so this can never drift from what dispatch actually honors.

**Response:**
```json
{ "scanned": 812, "updated": 630, "skipped": 182 }
```
- `updated`: every customer whose flags didn't already equal the target and
  got overwritten to match it — regardless of prior individual customization.
- `skipped`: customers already matching the target (a no-op either way).
- Runs as a single DB statement/transaction if feasible
  (`UPDATE customers SET is_voice=..., is_sms=..., is_email=... WHERE
  company_id=$1 AND NOT (is_voice=$2 AND is_sms=$3 AND is_email=$4)`) rather
  than row-by-row, given this is meant to run for on the order of hundreds to
  thousands of customers per company.

Once this exists, the frontend's `handleApplyStrategyToCustomers` loop can be
deleted in favor of one call to this endpoint.

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
