# Ticket Update Contract — `PUT /api/ticket/update`

Frontend integration reference. Every key this endpoint accepts, which ones it silently
ignores, and the behaviours that will cost you an afternoon if nobody tells you first.

> **There is no request-schema validation on this route.** Unlike the read endpoints in the
> same servlet, `updateTicket` validates only `body.id`. Every other key is filtered
> implicitly against the ticket model — unknown keys are dropped without an error, so a
> typo just quietly does nothing.

**Source:** [`ticket.servlet.js:723`](../src/servlets/ticket/ticket.servlet.js#L723) →
`TicketModule.edit` → `addUpdate('UPDATE', …)` → `TicketModel.update`

---

## Contents

1. [How keys are classified](#1-how-keys-are-classified)
2. [Required headers](#2-required-headers)
3. [Minimal request](#3-minimal-request)
4. [Keys that persist](#4-keys-that-persist)
5. [Keys the server overrides](#5-keys-the-server-overrides)
6. [Sub-resource keys](#6-sub-resource-keys)
7. [Assignments (visits)](#7-assignments-visits)
8. [Overwrite protection](#8-overwrite-protection)
9. [Gotchas](#9-gotchas)
10. [Response shape](#10-response-shape)
11. [Error handling](#11-error-handling)

---

## 1. How keys are classified

Four states. Every key below carries one of these, because "the API accepts it" and "the API
stores it" are not the same thing here.

| State | Meaning |
|---|---|
| **PERSISTS** | Written to the `ticket` row exactly as you send it. |
| **OVERRIDDEN** | Accepted, then replaced by a server-derived value. Sending it is a no-op. |
| **ROUTED** | Not a ticket column. Stripped and handed to a sub-module. |
| **DROPPED** | Silently discarded. No error, no effect. |

---

## 2. Required headers

Hyphenated and lowercase — these are not camelCase. Missing or non-numeric `company-id` /
`user-id` fails the request before the body is even read.

| Header | Required | Notes |
|---|---|---|
| `company-id` | **yes** | Integer. Scopes every query; you cannot update another company's ticket. |
| `user-id` | **yes** | Integer. Becomes `updatedUserId` on the ticket and on every touched visit. |
| `timezone-offset` | recommended | Used by recurring-visit propagation. Omit it and `editRecurringEvent` maths drifts. |
| `timezonename` | optional | IANA name, e.g. `America/New_York`. |
| `request-from` | optional | Creation-source tag: web app, Android, iOS. |
| `api-version` | optional | — |
| `locale` | optional | Translates error messages. One of `en`, `es-MX`, `fr-CA`. |

---

## 3. Minimal request

Only `id` is mandatory in the body. Send just the fields you are actually changing — this is
a partial update at the column level, with one important exception ([`options`](#gotcha-01--options-is-a-full-overwrite-not-a-merge)).

### Smallest valid body

```json
{
  "id": 18423,
  "jobDescription": "Replace condenser fan motor"
}
```

### Realistic body — reschedule a visit and reassign the tech

```json
{
  "id": 18423,
  "jobDescription": "Replace condenser fan motor",
  "jobTypeId": 12,
  "workCodeId": 44,
  "buId": 3,
  "potentialRevenue": 1450.00,
  "estimateHours": "3.5",

  "assignments": {
    "update": [
      {
        "id": 99812,
        "ticketId": 18423,
        "startTime": "2026-09-14 09:00:00",
        "endTime":   "2026-09-14 12:30:00",
        "technicianId": 507,
        "assignmentStatusId": 2,
        "existingData": {
          "startTime": "2026-09-12 14:00:00",
          "endTime":   "2026-09-12 17:30:00",
          "technicianId": 488,
          "assignmentStatusId": 2
        }
      }
    ],
    "add": [
      {
        "startTime": "2026-09-15 08:00:00",
        "endTime":   "2026-09-15 10:00:00",
        "technicianId": 507,
        "assignmentStatusId": 1,
        "description": "Follow-up airflow check"
      }
    ],
    "delete": [ { "id": 99813 } ]
  },

  "assetIds":  { "add": [7781], "remove": [] },
  "jobTags":   { "add": [4], "delete": [9] }
}
```

### The `id` guard

**Always send `id`, never only `objectId`.** The endpoint first rejects any body without a
truthy `id`, and only afterwards falls back to `objectId` when parsing. That fallback is
unreachable — a body carrying just `objectId` is rejected with `Ticket id or details missing`.

---

## 4. Keys that persist

**PERSISTS** — these map to real `ticket` columns and are stored as sent. Anything not on
this list and not in the two sections below is dropped without comment.

| Key | Type | Notes |
|---|---|---|
| `jobDescription` | string | The job summary shown across dispatch views. |
| `jobTypeId` | int → JobType | Required by the schema — don't clear it. |
| `workCodeId` | int → WorkCode | Nullable. |
| `campaignId` | int → Campaign | Nullable. |
| `buId` | int → BusinessUnit | Nullable. |
| `customerId` | int → Customer | Required by the schema. |
| `serviceAddressId` | int → CustomerAddress | Required by the schema. |
| `potentialRevenue` | decimal | Plain number, no currency symbol. |
| `estimateHours` | **string** | String, not number. Send `"3.5"`, not `3.5`. |
| `cancelReason` | string | Free text. Not auto-cleared when a ticket reopens. |
| `options` | object (JSON) | Full-blob overwrite — see [gotcha 01](#gotcha-01--options-is-a-full-overwrite-not-a-merge). |
| `uniqueId` | string | External correlation id. |
| `readyForSync` | boolean | Drives QuickBooks sync eligibility. |
| `combinedFeatureFlag` | string | Internal flag blob. |
| `objectId` | string | Writable, but see the `id` guard above. |
| `isActive` | boolean | Writable on this route. Setting `false` hides the ticket everywhere. |
| `isDeleted` | boolean | Writable on this route. This is the soft-delete flag — do not send it from an edit form. |
| `createdBy` | string | Writable. Display-name string, not an id. |
| `updatedBy` | string | Writable. Display-name string, not an id. |

> **Never spread a fetched ticket straight back into the update body.**
> Unlike the visit path, this route does not filter non-mutable columns, so `isActive`,
> `isDeleted`, `createdBy` and `updatedBy` are all writable. A naive
> `{ ...ticketFromGet, jobDescription }` can soft-delete the ticket it was meant to edit.
> Build the patch from your dirty fields.

---

## 5. Keys the server overrides

**OVERRIDDEN** — accepted for backwards compatibility and then thrown away. Don't build UI
that expects these to stick, and don't send them to "fix" a stale value.

| Key | What actually happens |
|---|---|
| `jobStatusId` | **Always re-derived from the ticket's visit statuses.** A value that disagrees with the derived one is logged as `TICKET_EDIT: Ignoring client jobStatusId…` and discarded. Move a job's status by changing its visits' `assignmentStatusId`, never by patching the ticket. If the ticket has no visits at all, the previously saved status is kept. |
| `scheduledStartTime` | Recomputed as the earliest visit start. |
| `scheduledEndTime` | Recomputed as the latest visit end. |
| `ticketCompletionDate` | Honoured only when *all three* hold: the derived status resolves to `Complete`, the company has `singleInvoiceRestrict` enabled, and QBO or Web Connector is connected. Otherwise the server's own resolution wins. |
| `updatedUserId` | Forced to the `user-id` header. |
| `ticketNumber` | Generated on create only. Never reassigned on update. |
| `companyId` | Taken from the header and pinned in the `WHERE` clause. |
| `createdUserId` | Set on create only. |

---

## 6. Sub-resource keys

**ROUTED** — not ticket columns. Each is lifted out of the body and handed to its own
module, inside the same transaction as the ticket write.

| Key | Shape | Behaviour |
|---|---|---|
| `assignments` | `{ add[], update[], delete[] }` | Visits. See [section 7](#7-assignments-visits) — this is the bulk of any real payload. |
| `assetIds` | `{ add[], remove[] }` | Arrays of asset ids. De-duplicated server-side. Used by companies migrated to the asset model. |
| `equipments` | `int[]` | Legacy path for companies *not* yet migrated to assets. Full replace, not a patch. Pick `assetIds` or `equipments` per company — never both. |
| `serviceAgreements` | `int[]` | Full replace. A non-empty array also force-sets `options.isSAJob = true`. |
| `jobTags` | `{ add[], delete[] }` | Applied after the ticket write. |
| `editRecurringEvent` | object | Set `type: "THIS_WITH_FOLLOWING"` to propagate this edit to future occurrences; omit it entirely to edit only this occurrence. Requires `timezone-offset`. |
| `notes` | array — **DROPPED** | **Silently discarded on update.** Consumed only on create. Post notes through the notes endpoint. |
| `updateTicketDetails` | boolean — **DROPPED** | Deprecated. Status and duration are now always derived. Remove it from your payload. |
| `customFields` | — **DROPPED** | Not supported on this route at all. Use the dedicated custom-fields endpoint. |

---

## 7. Assignments (visits)

Three independent buckets, applied in a fixed order: **delete → add → update**. You can send
any combination in one request.

### Per-visit keys

| Key | `add` | `update` | Notes |
|---|---|---|---|
| `id` | — | **required** | Omit on `add`. |
| `startTime` | yes | yes | `YYYY-MM-DD HH:mm:ss`. Compared at second precision. |
| `endTime` | yes | yes | Same format. |
| `technicianId` | yes | yes | Changing this fires an assignment notification. |
| `assignmentStatusId` | yes | yes | This is what actually moves the parent ticket's status. |
| `description` | yes | yes | Visit-level note. |
| `travelTime` | yes | yes | Also recalculated in the background after the response. |
| `deviceId` | yes | yes | — |
| `options` | yes | yes | JSON blob. Full overwrite, same caveat as the ticket's. |
| `ticketId` | auto | recommended | Set automatically on `add`. On `update` it triggers the parent recompute. |
| `recurringAssignmentId` | auto | yes | Auto-generated on `add` when `editRecurringEvent` is present. |
| `assignmentStatusCFId` | yes | yes | Custom visit status. Only read when the company has `isAssignmentCustomStatusEnabled`; on `add` it defaults to the lowest-sorted custom status when omitted. |
| `existingData` | — | recommended | Overwrite guard. See [section 8](#8-overwrite-protection). |

### Deletes take objects, not ids

`assignments.delete` is an array of **objects carrying an `id`** — `[{ "id": 99813 }]`. A
bare `[99813]` reads as `undefined` and the delete fails. Deletes are soft; the visit is
deactivated, not removed.

### Keys stripped from visit updates

On the `update` path only, these are removed before the write, so sending them is harmless
but pointless: `status` and `location` (legacy names), plus `className`, `isActive`,
`isDeleted`, `createdUserId`, `companyId`, `createdBy`, `updatedBy`, `createdAt` and
`updatedAt`. This is the filtering the ticket-level path lacks.

---

## 8. Overwrite protection

Optimistic concurrency on visit updates, opted into per visit by sending `existingData`.
This is how the dispatch board avoids two dispatchers clobbering each other.

Put the values you originally loaded into `existingData`, and the new values at the top
level. For each key present in `existingData`, the update is allowed when *either* the new
value or the original value still matches what's in the database. If neither matches,
someone else changed that field while your form was open and the whole request is rejected.

**Compared keys:** whatever you include — in practice `startTime`, `endTime`,
`assignmentStatusId`, `technicianId` and `assignmentStatusCFId`. Timestamps are compared
with milliseconds zeroed, so sub-second differences never trip the guard.

**Rejection:**

```
HTTP 500
{
  "status": "error",
  "exception": { "error": {
    "code": "E104",
    "message": "Visit details were updated by another users while you
                were working on it. Please refresh to get the latest details."
  }}
}
```

> **`existingData` also decides which customer SMS goes out.**
> A changed `assignmentStatusId` sends the *update* template; a changed `startTime` sends
> the *reschedule* template. Omitting `existingData` entirely makes the server treat the
> edit as a brand-new visit and send the *create* template. So dropping it doesn't just lose
> the safety check — it sends your customer the wrong message.

---

## 9. Gotchas

Ranked by how often they actually bite. The first two are the ones to read before writing
any code against this endpoint.

### Gotcha 01 — `options` is a full overwrite, not a merge

The update path never reads the saved `options` before writing, so whatever you send
*replaces the entire JSON blob*. Every flag you leave out is destroyed:

- `notifyForPO` — purchase-order notification preference
- `jobStatusOverwritten` — manual status override marker
- `isSAJob` — service-agreement job flag
- `signatureMediaId` — the captured customer signature
- `approvedBy` — approval audit trail
- `isCompletionSet` — completion bookkeeping

**Do this:** read the ticket, spread the saved options, then override only your key —
`options: { ...saved.options, notifyForPO: true }`. Or leave `options` out of the body
entirely.

### Gotcha 02 — Typos fail silently

There is no request-schema validation on this route. Keys are filtered against the ticket
model, and anything unrecognised is dropped before the write. Send `jobDesciption` and you
get a `200 OK` with the old description still in place.

Because the response echoes the saved ticket, you can assert on it: compare the fields you
sent against `result` and surface a real failure to the user instead of a false success
toast.

### Gotcha 03 — There is no partial success

The whole request runs in one transaction, and any visit, equipment, asset or
service-agreement failure throws and rolls everything back — including the ticket columns
that had already applied. Treat the call as atomic: on error, nothing changed. Don't try to
reconcile a half-applied state.

### Gotcha 04 — Status is a read-only projection of visits

Worth restating because it reshapes the UI: a job-status dropdown that PUTs `jobStatusId`
does nothing. Status changes belong on the visit's `assignmentStatusId`, and the ticket's
status follows. Render the ticket status as derived, non-editable state.

---

## 10. Response shape

Always `HTTP 200` on success. The updated ticket comes back under `result`, with visit
changes attached.

```json
{
  "status": "success",
  "requestId": null,
  "result": {
    "id": 18423,
    "ticketNumber": "018423",
    "jobDescription": "Replace condenser fan motor",
    "jobStatusId": 2,
    "scheduledStartTime": "2026-09-14 09:00:00",
    "scheduledEndTime":   "2026-09-15 10:00:00",
    "options": { "...": "..." },

    "assignments":        [ "added + updated visits, full objects" ],
    "deletedAssignments": [ "only present if you deleted any" ],
    "serviceAgreements":  [ "only present if you sent any" ]
  },
  "meta": null
}
```

Note `result.jobStatusId` is the **derived** value, not what you sent.

> **Use `result.scheduledStartTime` and `result.jobStatusId` to refresh your local state.**
> They are the server's derived values and will differ from whatever you sent. Internal
> bookkeeping fields (`jobStatusUpdated`, `jobStatusName`, `assignmentActionDetails`,
> `postActionEvents`) are stripped before the response — don't build against them.

Notifications, SMS, travel-time recalculation, Google Calendar sync and search re-indexing
all run *after* the response is sent. A `200` means the data is committed, not that every
side effect has landed — so a list view refetched immediately may briefly show stale search
results.

---

## 11. Error handling

> **Branch on `exception.error.code`, never on the HTTP status.**
> Most failures on this route return `HTTP 500` with a meaningful code in the body. A 500
> here usually means "you sent something wrong", not "the server is broken".

| HTTP | `code` | Meaning | What the UI should do |
|---|---|---|---|
| 500 | `E104` | Overwrite conflict — someone edited this visit while your form was open. | Show the returned message and offer a refresh. Do not retry blindly. |
| 500 | `E101` | Business-rule block, e.g. mandatory checklist items missing on completion. | Surface the message verbatim — it names what's missing. |
| 500 | `E100` | Validation failure. | Surface the message and keep the form open. |
| 500 | `E501` | Database failure. | Generic retry. |
| 500 | `"500"` | Bare internal throw — includes `Ticket id or details missing`, `Ticket id missing or invalid`, `Unable to update assignment`, `Unable to link assets`, `Unable to find status`. | Read `description` for the real cause; the code carries no detail. |
| 401 | `401` | Auth failure or missing access token. | Re-authenticate. |

### Error envelope

```json
{
  "status": "error",
  "requestId": null,
  "exception": {
    "error": {
      "code": "E104",
      "description": "…localised message…",
      "message": "…localised message…",
      "extras": ""
    }
  }
}
```

`description` and `message` are the same string, already translated using the `locale`
header. They are written for end users, so they are safe to display directly.

---

*Source: `src/servlets/ticket/ticket.servlet.js` · `ticket.module.js` · `assignment.module.js`*
