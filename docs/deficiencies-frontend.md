# Deficiencies & the InspectPoint re-mapping — Frontend Guide

> **For the frontend agent.** Open deficiencies from InspectPoint now sync, link to
> a location, become service lines, and are exposed on the locations API. The
> InspectPoint → platform entity mapping also changed, which affects UI you may
> already have built. Same conventions as `inspectpoint-integration-frontend.md`.

Base URL: `VITE_API_URL` · Auth: `Authorization: Bearer <token>` on every endpoint below.

---

## 0. Read this first: the entity mapping changed

| InspectPoint | used to become | **now becomes** |
|---|---|---|
| Account | `customers` | reference data only, inside `customers.additional_information.inspectpoint_account` |
| **Building** | `locations` | **`customers` AND `locations`** (same `external_ref`, both tables) |
| inspection type | `service_lines` + `jobs.job_type` | **`jobs.job_type` only** |
| **Deficiency** | *(nothing)* | **`service_lines`** + the `deficiencies` table |

**Why Building became the customer:** every InspectPoint Account structurally has
no phone and no email — on 100% of rows. The Building is where `phone_number`
lives. So the entity we actually call was not the one stored as the customer.

**What this means for existing UI:**

- **The customer name is now the site name** (*"Wanderlust Doughnuts"*), not the
  billing account. Any screen presenting a customer-vs-site distinction for
  InspectPoint needs review — for these companies they are the same thing.
- For company 11 this took `customers` from **4 rows to 807**. Anything that
  counts, lists or paginates customers will look very different.
- `locations` is **unchanged and still populated** (807), and `jobs.location_id`
  still resolves. Nothing that reads locations breaks.
- The billing account is still available at
  `customers.additional_information.inspectpoint_account` → `{ id, name, billing_address1, … }`.

---

## 1. What a deficiency is

A fault an inspector recorded at a site — a failed check on a kitchen hood, a
missing certification tag, unsealed ductwork. It belongs to a **location**.

**Only unresolved deficiencies exist in the platform.** Resolved ones are never
stored, and a deficiency resolved upstream is *deleted* on the next sync. So you
never need to filter by `is_resolved` — but it is returned, and it is always `false`.

Live figures (Ultimate Fire, the only InspectPoint tenant):

| | |
|---|---|
| Open deficiencies | 436 |
| Locations with ≥1 | 91 of 807 |
| Most at one site | **29** |
| Median per affected site | 3 |

---

## 2. `GET /locations` 🔒 — per-row summary

Every location row gains `deficiency_summary`. Nothing else changed.

```json
{
  "locations": [
    { "id": 190527, "name": "Wanderlust Doughnuts",
      "deficiency_summary": { "open": 29, "by_status": { "unspecified": 29 } } }
  ],
  "pagination": { "total": 807, "limit": 50, "offset": 0, "totalPages": 17 }
}
```

`open` is always present — `0`, never `null`, so you can badge unconditionally.
`by_status` will essentially always be `{"unspecified": N}` — see §5.

The full array is deliberately **not** here: a site with 29 items in every page of
a 50-row list would grow the payload without bound.

---

## 3. `GET /locations/:id` 🔒 and `GET /locations/:id/deficiencies` 🔒

Detail returns the full array (capped 200); the dedicated endpoint pages and is
the only way to see resolved history (of which there is none — §1).

| query param | default | |
|---|---|---|
| `is_resolved` | `false` | `true` returns resolved only |
| `status` | — | rarely useful, see §5 |
| `limit` / `offset` | 100 / 0 | max 200 |

### The row shape

```json
{
  "id": 1183,
  "name": "Check operation of micro switch — No",
  "description": null,
  "status": null,
  "is_resolved": false,
  "opened_at": "2026-09-29T15:22:33.271Z",
  "source": "inspectpoint",
  "external_ref": "1000",
  "asset_type": "Asset",
  "resolution_status": "New",
  "service_line_id": 412,
  "inspection_ref": "1068",
  "detail": {
    "asset_details": {
      "System/Asset Type": "Asset",
      "Asset Type": "Kitchen Hood",
      "Asset Name": "Wonderless Donuts - Fire Suppression",
      "Manufacturer": "Annul R102",
      "Model": "R102",
      "Location of system cylinders": "Left of hood",
      "Question": "Check operation of micro switch",
      "Answer": "No"
    },
    "related_device": { "id": 661, "device_type": "equipment" },
    "inspection": {
      "id": 1068,
      "scheduled_date": "2026-09-29T09:00:00.000-04:00",
      "inspection_date": "2026-09-29T11:35:17.785-04:00",
      "generated_description": "Wonderless Donuts - Fire Suppression, Hood Cleaning",
      "frequency": "semiannual",
      "technician": { "id": 68, "name": "Ultimate Fire" }
    }
  }
}
```

| field | note |
|---|---|
| `name` | already the best available label — see §4 |
| `service_line_id` | a deficiency **is** a service line now; this is its catalog row |
| `inspection_ref` | the **InspectPoint** inspection id. **There is no platform job behind it** — do not link it to a job page (§6) |
| `detail` | **non-deterministic JSONB, passed through verbatim** — see §4 |

---

## 4. `detail.asset_details` has six shapes — never assume a key

This is the part to design carefully. `System/Asset Type` is the discriminator,
and the rest of the keys vary completely by type. Measured across all 436 rows:

| `System/Asset Type` | rows | always present | sometimes |
|---|---|---|---|
| `Inspection custom inspection` | 183 | Display Name, Question, Answer | — |
| `Asset` | 99 | Asset Type, Asset Name, Manufacturer, Model, Question, Answer | Location of system cylinders (98) |
| `Equipment` | 75 | Equipment type | Equipment Name (8), Address (5), Location (5), Answer (1) |
| `Inspection external form` | 66 | Display Name | — |
| `Fire Extinguisher` | 8 | Extinguisher Group Name, Question, Answer | Location, ID Number, Type, Manufacturer, Weight |
| `Fire Exit Sign` | 5 | Exit Sign Group Name, Location, Question, Answer | Model, Battery Type, Manufacturer |

The backend does **not** flatten this, on purpose: any fixed schema would fit one
shape and misrepresent the other five.

**Suggested rendering, in this order:**

1. **`Question` + `Answer` first** — this is the actual fault
   (`"Check operation of micro switch"` → `"No"`). Present on **295/436**, and the
   backend already composes it into `name`.
2. **Then the identifying keys for that type** — `Asset Name`/`Manufacturer`/`Model`
   for `Asset`, `Equipment type` for `Equipment`, the group name for extinguishers
   and exit signs.
3. **Then everything else as a generic key/value list.** New keys will appear
   without warning; iterate `Object.entries` rather than hardcoding a field list,
   so an unexpected key is shown rather than dropped.

**Do not put `System/Asset Type` in a prominent chip.** Four of the six values —
`Inspection custom inspection`, `Asset`, `Equipment`, `Inspection external form`,
**97% of rows** — are internal jargon that means nothing to a customer. Use it as
a grouping key or a muted label. Only `Fire Extinguisher` and `Fire Exit Sign`
(13 rows) read as real equipment.

`related_device` is present on 187/436 with `device_type ∈ {asset, equipment,
fire_extinguisher, fire_exit_sign}`.

---

## 5. Fields that look useful and are not

**`status` is null on 99% of rows.** InspectPoint's severity vocabulary
(`critical`, `impairment`, `non_critical`, …) is populated on **3 of 439**. So
`by_status` is `{"unspecified": N}` essentially always.

**Do not build severity-coloured badges, a "critical first" sort, or a severity
filter as a primary control** — they would be dead UI. And never render a null
`status` as *"Unknown"* or *"Normal"*: it is absent, not neutral, and inventing a
severity on a fire-safety record is the worst failure mode this panel has.

**`resolution_status` is populated on 100%** but is `"New"` on every row today.
Safe to display, not yet useful to filter on.

**`ref_number` is null on essentially every row** — don't offer search on it.

**`description` is usually null** — only 105/436 have `notes` behind it.

---

## 6. Coverage caveats — surface these, don't hide them

**ServiceTrade sites show nothing.** 105 ServiceTrade deficiencies exist with no
location link, so `deficiency_summary.open` is `0` for every ServiceTrade
location. That is **not** "this site is clean". If you can tell which CRM a
company uses, suppress the panel entirely for ServiceTrade rather than showing a
reassuring zero.

**`inspection_ref` has no platform job.** The inspections that raise deficiencies
are `Completed` / `Waiting for Review`, and the platform's `jobs` table
deliberately holds only open work. Show the reference and the details from
`detail.inspection`; do not build a link.

**Data refreshes on CRM sync, not live.** A fault resolved upstream five minutes
ago still shows until the next sync.

**The upstream endpoint is deprecated.** The backend uses InspectPoint's v1
`/deficiencies` because v2 cannot link a deficiency to a site (2% coverage vs
100%). If it is withdrawn the data goes stale and the backend logs loudly — but
the UI would show stale-but-plausible data. A "last synced" indicator near the
panel is worth having.

---

## 7. Statuses can now be `unknown` or `in_progress`

Two new values exist on `jobs.status` and `appointments.status`:

- **`in_progress`** — a visit the technician has started. Previously mis-reported
  as `scheduled` because the constraint had no such value.
- **`unknown`** — the CRM reported a state we could not interpret. It is
  deliberately **inert**: excluded from confirmation sweeps and never offered as a
  call target, so an unreadable upstream state cannot trigger a customer call.

**Render both rather than treating an unexpected value as an error.** `unknown` is
best shown neutrally (*"Status unavailable"*), not as a failure — it means our
mapping is behind InspectPoint's, which is a backend concern, not a user's.

---

## 8. Building the UI

**Location list:** a count badge from `deficiency_summary.open`, only when `> 0`.
No severity colour (§5).

**Location detail:** a panel titled *"Open items from last inspection"* — the
heading matters, because it supplies the context that makes an item read as a
*finding* rather than a question. Each row: `name` prominently, `asset_type` muted,
`opened_at` as relative age. Expand to show `detail` per §4.

**Sort by `opened_at` descending.** Not by severity — there isn't any.

**Collapse past ~10 items.** Median is 3 but one site has 29.

**Empty state:** *"No open items recorded"* — and per §6, do not show the panel at
all for ServiceTrade companies.

---

## 9. Things to get right

**Never show a price.** There is no price field and there must not be one —
CMAP-228 forbids quoting repair pricing, and the agent is built to the same rule.

**Don't merge this panel with pre-visit instructions**
(`previsit-instructions-frontend.md`). An open item is optional repair work
being *offered*; a pre-visit instruction is a *precondition* the customer must
meet or the visit fails. The agent keeps them apart deliberately, and the UI
should too.

**Never assume an `asset_details` key exists.** Six shapes, and InspectPoint can
add a seventh without telling us.

**Don't dedupe client-side.** The backend collapses the same fault re-reported by
successive inspections (60 of 436 were duplicates). Repeats you still see are a
backend bug worth reporting, not something to paper over in the view.

**Don't treat a 0 customer/site distinction as a bug** for InspectPoint
companies — after the re-map they genuinely are the same entity (§0).

---

## 10. Not in scope

- **Resolving a deficiency from the UI** — read-only; there is no write-back to
  InspectPoint, so a user marking something fixed would silently diverge from the CRM.
- **ServiceTrade deficiency linkage** (§6).
- **CMAP-229** — the *"Appointment & Deficiency Repair Confirmed"* status, the
  write-back side of this conversation. Until it exists, the agent can offer a
  repair and nothing records the customer saying yes.
