# Service Opportunity Integration — Frontend Integration Guide

> **This document supersedes all earlier versions.** The backend feature was
> rebuilt from scratch on a new branch (`crm-integrations`) with a simpler,
> corrected design. If anything you read elsewhere (old chat threads, an
> earlier copy of this file) conflicts with what's below, **this file wins.**

## 0. What actually shipped (read this first)

Backend now syncs ServiceTrade **locations** and **service requests**
("service opportunities" = open service requests that don't yet have a job)
into new platform tables, and exposes them as two new top-level routes:
**`GET /locations`** and **`GET /service-opportunities`**.

**What did NOT ship in this round — do not build UI assuming these exist:**
- ❌ No new calling agent / call type. There is no `service_opportunity_booking`
  call type, no new call trigger, no new dynamic variables, no new todo
  subject kind. Calling/booking automation is future work, not part of this build.
- ❌ No top-level `/contacts`, `/offices`, `/tags`, `/service-lines` routes.
  Those entities exist in the database (so locations/service-opportunities can
  reference them) but are only reachable **nested** inside `GET /locations/:id`
  and `GET /service-opportunities/:id`, or via the raw debug routes (§4).
- ❌ No assets sync. Assets are not a table — a service opportunity's `asset`
  field is just a raw passthrough JSON blob (whatever ServiceTrade embedded),
  not a resolved entity.
- ❌ No comments sync (ServiceTrade's `/comment` API has no bulk-list shape).

**The one non-obvious data fact that matters most for UI design:**
`service_opportunities.job_id` **will always be `null`** right now. A service
request only becomes a `service_opportunities` row when ServiceTrade reports
**no job at all** attached to it (the qualification rule is "no job AND no
appointment"). So don't design a "view the linked job" affordance expecting
it to be populated — there usually won't be one yet. `location_id` is the one
FK that's always present and reliable.

---

## 1. Concept

- **Location is the fundamental entity.** A location is a physical customer
  site (address, lat/lon, a primary contact, a general manager name). A
  customer can have many locations; a location can have many service
  opportunities.
- **A "service opportunity"** is a ServiceTrade service request that has
  neither a job nor an appointment yet — i.e. genuinely unbooked, ground-floor
  work. (Requests that already have a job, even an unscheduled one, are still
  synced into the backend's raw tables but are **not** surfaced as a service
  opportunity.)
- **Offices, contacts, tags, service lines, deficiencies, change orders,
  contracts, and service recurrences** are all real tables in the backend,
  used to enrich locations and service opportunities — but none of them has
  its own top-level list page yet. Treat them as read-only context that shows
  up nested inside a location or service opportunity, not as independent
  entities to build a list/detail page for.
- **One sync pipeline, extended** — there is still just the one existing CRM
  sync (`crm_sync`); it wasn't split into a second pipeline. It now also pulls
  locations and service requests, with a configurable time horizon for the
  service-request window (`week` / `month` / `3month`, default `month`).

---

## 2. New platform routes (use these — do not call `/integrations/servicetrade/*` from app UI)

Standard auth (`Authorization: Bearer <jwt>`), same convention as the existing
`GET /customers` / `GET /jobs` routes.

### 2.1 `GET /locations`

Query params: `search`, `customer_id`, `is_active` (`true`/`false`), `limit`, `offset`.

```json
{
  "locations": [
    {
      "id": 12,
      "company_id": 4,
      "customer_id": 4,
      "primary_contact_id": 3,
      "name": "Ruby Tuesday - #4722 Kinston",
      "lat": 35.264011,
      "lon": -77.64003,
      "phone": "+15308675309",
      "email": null,
      "general_manager_name": "Joe Guy",
      "address_line1": "3725 West Vernon Avenue",
      "city": "Kinston",
      "state": "NC",
      "zipcode": "28504",
      "country": "US",
      "taxable": false,
      "company": { "id": 37, "name": "Beer Knutz, LLC", "status": "active" },
      "brand": null,
      "is_active": true,
      "external_ref": "42",
      "source": "servicetrade",
      "additional_information": { "servicetrade_location_id": 42, "warnings": [] },
      "created_at": "2026-07-10T12:00:00.000Z",
      "updated_at": "2026-07-10T12:00:00.000Z"
    }
  ]
}
```

Notes:
- `phone` is normalized to **E.164** (`+1XXXXXXXXXX`), unlike most other phone
  fields in the app today — don't re-format it.
- `company` is a raw JSONB passthrough of ServiceTrade's lightweight company
  stub (`{id, name, status}`) — **not** the same as our own `customers` row.
  Use `customer_id` to link to the real customer record; treat `company` as
  read-only display context only.
- There is no `ref_number` field (if you saw one in an older draft of this
  doc, drop it — it isn't a real column).

### 2.2 `GET /locations/:id`

Same shape, plus resolved nested context:

```json
{
  "location": {
    "...": "all fields above, plus:",
    "primary_contact": { "id": 3, "first_name": "Joe", "last_name": "Guy", "phone": "+15308675309", "mobile": null, "alternate_phone": null, "email": "joe@barfood.com", "type": "management" },
    "offices": [{ "id": 2, "name": "Bartender's Friend Cleaning - Main Office", "phone": null, "email": null }],
    "tags": [{ "id": 1, "name": "VIP" }]
  }
}
```

`primary_contact` is `null` when a location has no primary contact.
`offices` and `tags` are always arrays (possibly empty) — a location can have
zero, one, or several of each.

### 2.3 `GET /service-opportunities`

Query params: `location_id`, `office_id` (filters by any office serving that
location, via the location↔office relationship), `job_id`, `status`, `limit`, `offset`.

```json
{
  "service_opportunities": [
    {
      "id": 5,
      "company_id": 4,
      "location_id": 12,
      "job_id": null,
      "deficiency_id": 2,
      "change_order_id": null,
      "contract_id": 1,
      "service_recurrence_id": 3,
      "service_line_id": 1,
      "status": "in_progress",
      "description": "Fire Suppression: 10.20 Per MOD Jason, another company, doing unrelated work, removed the piping...",
      "window_start": "2026-08-16T04:00:00.000Z",
      "window_end": "2026-08-16T04:00:00.000Z",
      "closed_on": null,
      "estimated_price": null,
      "duration": 0,
      "preferred_start_time": 0,
      "budget": null,
      "preferred_vendor": null,
      "asset": null,
      "visibility": ["public"],
      "external_ref": "34",
      "source": "servicetrade",
      "additional_information": { "servicetrade_service_request_id": 34, "warnings": [] },
      "created_at": "2026-07-13T10:00:00.000Z",
      "updated_at": "2026-07-13T10:00:00.000Z",
      "location_name": "Ruby Tuesday - #4722 Kinston",
      "job_status": null,
      "service_line_name": "Sprinkler"
    }
  ]
}
```

Remember: **`job_id` and `job_status` will be `null` for essentially every row**
right now (see §0). Design around `location_name` / `service_line_name` /
`description` / `window_start` / `window_end` as the primary display fields,
not "linked job" info.

### 2.4 `GET /service-opportunities/:id`

Same shape, plus:

```json
{
  "service_opportunity": {
    "...": "all fields above, plus:",
    "preferred_technicians": [{ "id": 9, "first_name": "Alex", "last_name": "Tech", "phone": "+19195551234" }]
  }
}
```

`preferred_technicians` is always an array (possibly empty).

---

## 3. Raw debug routes (`/integrations/servicetrade/*`) — for visibility/debugging only, never build app UI against these

- `GET /integrations/servicetrade/locations` — raw synced location rows.
- `GET /integrations/servicetrade/contacts` — raw contacts (sourced only from
  locations' embedded `primaryContact`; there's no dedicated contacts sync).
- `GET /integrations/servicetrade/offices` — raw offices (sourced only from
  locations' embedded `offices[]`).
- `GET /integrations/servicetrade/tags` — raw tags (sourced only from
  locations' embedded `tags[]`).
- `GET /integrations/servicetrade/service-requests` — raw synced service
  request rows (query: `status`, `page`, `perPage`). Note the path is
  `service-requests` (plural, hyphenated) — not `service-opportunities`; that
  name is reserved for the platform route in §2.3.
- `POST /integrations/servicetrade/sync?full=true&range=week|month|3month` —
  the **same existing sync route** as before (nothing new here — it was
  extended, not replaced). `range` controls how far out the service-request
  window search looks; defaults to `month`. Response contract unchanged:
  blocking mode returns `{ success, runId, counts }`; `stream=true` returns
  `{ runId, kind, streamToken, streamUrl, snapshotUrl }` for the existing SSE
  engine-progress viewer.
  - If you render engine progress generically (per `workflow-engine-frontend.md`),
    no special-casing is needed — the engine kind is still `crm_sync`, just
    with two additional states in its state machine:
    `started → authenticating → fetching_customers → fetching_locations →
    fetching_technicians → fetching_jobs → fetching_service_requests →
    normalizing → done|failed`.

---

## 4. Fields added to existing endpoints

- **`GET /jobs`** (and `/integrations/servicetrade/jobs`) rows gain a
  `location_id` (nullable integer) — resolves against `GET /locations`. In
  practice this will be populated for jobs ServiceTrade itself links to a
  location; it is unrelated to the `service_opportunities.job_id` gap in §0.
- Nothing else on existing endpoints changed.

---

## 5. What's explicitly NOT in this build (don't design UI expecting these)

- No calling agent, call type, call trigger, or dynamic call-outcome variables
  for service opportunities.
- No top-level `/contacts`, `/offices`, `/tags` list/detail pages — only
  nested read-only display inside a location or service opportunity.
- No assets, comments, deficiency/change-order/contract/service-recurrence
  detail pages — these exist in the DB purely to give service opportunities
  their FK context (`deficiency_id`, `change_order_id`, etc.) and have no API
  surface of their own yet beyond the id itself.
- No create/edit/delete UI for anything in this doc — every route above is
  read-only (`GET` only).
