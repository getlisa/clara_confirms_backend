# CSV / Excel Import — Frontend Guide

> **For the frontend agent.** This is a new way for a company to get jobs into
> Clara **without any CRM at all**: they upload a spreadsheet of upcoming
> visits and the confirmation agent calls/texts those customers exactly as it
> does for a ServiceTrade or InspectPoint company.
>
> Read `docs/workflow-engine-frontend.md` first — this feature reuses the
> engine run + SSE progress contract described there verbatim, and this doc
> does not repeat it.
>
> **Status:** backend is implemented and unit-tested; the migration has not yet
> been applied to any environment. §10 lists what is deliberately not built
> yet, so you don't design around something that doesn't exist.

Base URL: `VITE_API_URL`. Auth header: `Authorization: Bearer <token>` on every
endpoint below.

---

## 0. The one thing that will bite you: this is NOT a multipart upload

Every other file-ish endpoint you've built probably used `FormData`. This one
takes the **file's raw bytes as the request body**:

```ts
await fetch(`${API}/imports/csv?filename=${encodeURIComponent(file.name)}`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}` },
  body: file,                 // the File object itself — NOT FormData
});
```

Do **not** set `Content-Type` yourself; the browser sets it from the `File`, and
the server ignores it and dispatches on the filename extension instead. Do
**not** wrap it in `FormData` — the server would then store the multipart
envelope as if it were the spreadsheet and reject it as unreadable.

Why it's built this way: no multipart dependency on the backend, and a binary
`.xlsx` survives without base64's 33% inflation, which matters because the
platform caps a request body at roughly 4.5 MB.

**The filename is required** and must carry a real extension — it is the only
thing that decides whether the file is parsed as CSV or Excel.

---

## 1. What the user is uploading

One row = **one visit to confirm**. A customer with three visits this week
uploads three rows.

### Required columns

The file is **rejected whole** (HTTP 422) if any of these is missing. Column
names are matched case- and spacing-insensitively against an alias list, so
users do not have to rename their export.

| What it is | Accepted headers (any one) |
|---|---|
| **Reference** — the row's unique id | `Visit ID`, `Visit Number`, `Work Order`, `WO #`, `Reference`, `Ticket`, `Appointment ID`, `Job Number`, `Document Number`, … |
| **Customer name** | `Customer`, `Customer Name`, `Client`, `Client Name`, `Account`, `Name`, `Company` |
| **Phone or email** (at least one) | `Phone`, `Mobile`, `Cell`, `Telephone` / `Email`, `Email Address` |
| **Scheduled date** | `Scheduled`, `Scheduled Date`, `Date`, `Appointment Date`, `Service Date`, `Due Date` |

### Optional columns

| What it is | Accepted headers |
|---|---|
| Job grouping (see below) | `Job Number`, `Job #`, `Parent Job`, `Master Job` |
| Time (if not in the date column) | `Scheduled Time`, `Time`, `Start Time`, `Appointment Time` |
| End time | `End`, `End Time`, `Scheduled End`, `Finish Time` |
| Duration in minutes | `Duration`, `Duration (mins)`, `Length` |
| Service description | `Service`, `Description`, `Job Description`, `Job Type` |
| Technician | `Technician`, `Tech`, `Assigned To` |
| Address | `Address`, `Street`, `Service Address`, `Site Address` |
| City / State / Zip | `City`, `State`/`Province`, `Zip`/`Postal Code` |
| Site contact person | `Contact`, `Contact Name`, `Site Contact` |

### Everything else is kept, not rejected

Any column the importer doesn't recognise is preserved verbatim against that
visit. An unknown column is **never** a reason for the upload to fail, so
there's no need to warn the user about extra columns — though the preview
response does list them (`preview.unknownColumns`), which is worth showing as
a quiet "these columns were kept but not interpreted" note.

### When the names don't match

The tables above are a fixed dictionary, and real exports routinely use names
that aren't in it. That is **not** an error state to design around — it's the
normal path into the column-mapping screen (§2b), which is where most first
uploads will go. Don't treat the header lists above as something the customer
must conform to; treat them as the cases that skip the mapping step.

### Multi-visit jobs

By default **each row becomes its own job**. If the file has a separate job
column (`Job Number` alongside a distinct `Work Order`, say), rows sharing that
value are grouped under one job — which is what makes the agent able to say
"you have two more visits on this job, shall I confirm those too?".

---

## 2. Upload

```
POST /imports/csv?filename=<name>[&dryRun=true][&dateOrder=MDY|DMY]
body: <raw file bytes>
```

### 2.1 Success — `202 Accepted`

The import has **already run** by the time this returns; the stream fields are
there so you can replay progress, not because you need to wait for a queue.

```json
{
  "importId": "17",
  "preview": {
    "totalRows": 128,
    "usableRows": 126,
    "errorRows": 2,
    "errors": [
      { "row": 14, "column": "Phone", "message": "Could not read the phone number \"n/a\"." }
    ],
    "dateOrder": "MDY",
    "unknownColumns": ["Gate Code", "PO Number"],
    "warnings": []
  },
  "import": { /* the import record — see §4 */ },
  "runId": "204",
  "kind": "csv_import",
  "streamToken": "…",
  "streamUrl": "/engines/204/stream?token=…",
  "snapshotUrl": "/engines/204"
}
```

**Two different error caps — don't share one constant between them.**
`preview.errors` is capped at **50** entries; the stored import record's
`errors` (§4) is capped at **500**. In both cases `errorRows` carries the true
count, so compare against the array length rather than assuming.

### 2.2 Dry run — `200 OK`

With `?dryRun=true` the file is validated and stored but **nothing is written
to the customer's data**. Use this for a "check my file" step before
committing.

```json
{ "importId": "17", "dryRun": true, "preview": { /* same shape as above */ } }
```

The `importId` stays usable — a dry run can be committed later by calling
reprocess (§5) on it, so the user doesn't have to re-upload.

### 2.3 Whole-file rejection — `422 Unprocessable Entity`

```json
{ "error": "The file is missing a work order / reference number. Found columns: Customer, Phone, Scheduled" }
```

**Nothing is stored** on a 422 — there's no import record to show afterwards.
The `error` string is written for the end user and names both what's missing
and what was actually found, so render it directly rather than substituting
your own copy.

### 2.4 Other failures

| Status | When | Body |
|---|---|---|
| `400` | no `filename` param, or an empty body | `{ "error": "…" }` |
| `413` | file over 4 MB | `{ "error": "That file is larger than the 4 MB limit…" }` |
| `500` | unexpected | `{ "error": "…" }` |

---

## 2b. Column mapping — the screen that makes this usable

Automatic matching is a **fixed dictionary**, not fuzzy matching or AI: each
field has a list of accepted header spellings, compared after lowercasing and
turning `. _ - /` into spaces. `Phone`, `Cell Phone`, `Customer_Phone` all
match. `Contact Mobile`, `Appointment Ref`, `Client Company` — a real customer
export — **do not**, and that's the common case, not the edge case.

So the upload can fail in a way the user can actually fix. When it does, the
`422` carries everything a mapping screen needs, and you should open one rather
than showing an error:

```json
{
  "error": "The file is missing a customer name, a scheduled date …",
  "code": "UNMAPPED_COLUMNS",
  "mappingRequired": true,
  "headers": ["Appointment Ref", "Client Company", "Contact Mobile", "Visit Day"],
  "suggestedMapping": { "reference": "Appointment Ref", "phone": "Contact Mobile" },
  "suggestions": [ { "field": "phone", "header": "Contact Mobile", "confidence": 0.76 } ],
  "missing": ["customerName", "scheduledAt", "phone"],
  "unmappedHeaders": ["Account Code"],
  "targetFields": [
    {
      "field": "phone", "label": "Phone", "requirement": "one-of:contact",
      "hint": "Used to call or text. Map a phone, an email, or both.",
      "example": "(555) 123-4567",
      "columns": [
        { "header": "Contact Mobile", "confidence": 0.76 },
        { "header": "Account Code", "confidence": 0 }
      ]
    }
  ]
}
```

**Branch on `code === "UNMAPPED_COLUMNS"`, not on the message text.**

### Building the screen

- `targetFields` is your list of drop targets, in a sensible display order.
  Each carries a `label`, a `hint` worth showing as helper text, an `example`,
  and `requirement`.
- `requirement` is three-valued, not a boolean:
  - `required` — must be mapped
  - `one-of:<group>` — at least one field in the group. `one-of:contact`
    (phone/email) and `one-of:schedule` (scheduledAt, or scheduledDate) are the
    two groups today. Validate the **group**, not the individual field, or
    you'll demand an email from someone who gave you a phone.
  - `optional`
- `columns` is **every** column in the file, ranked for that field. Use it to
  order the dropdown — but always allow any column for any field. Our scoring
  knows nothing about their business.
- `suggestedMapping` pre-fills the form. Treat it as a draft, never as
  confirmed: `missing` reflects what's *confirmed*, so it will still list
  fields that have a suggestion sitting in them.
- `unmappedHeaders` are columns nothing claimed. They're kept on the visit
  regardless, so show them as "kept, not interpreted" rather than a problem.

Drag-and-drop works well here (columns on the left, fields on the right), but a
`<select>` per field is a perfectly good first version and far less work — the
`columns` ranking does the heavy lifting either way.

### Submitting it

Re-upload the same file with the mapping as a JSON query param:

```ts
const mapping = { reference: "Appointment Ref", customerName: "Client Company",
                  phone: "Contact Mobile", scheduledDate: "Visit Day" };

await fetch(`${API}/imports/csv?filename=${encodeURIComponent(file.name)}`
          + `&mapping=${encodeURIComponent(JSON.stringify(mapping))}`,
  { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: file });
```

It's a query param because the body is already the file. A malformed value is a
`400` rather than being ignored — silently dropping a mapping the user just
drew would import the wrong columns.

### It is remembered

A mapping the user explicitly supplies is **saved as that company's default and
applied automatically to their next upload**, so a weekly export needs mapping
exactly once. Consequences for the UI:

- Most uploads after the first should go straight through with no mapping step.
- Our own suggestions are **never** auto-saved — only a mapping the user sent.
- `GET /imports/csv/mapping` → `{ mapping, sourceHeaders, updatedAt, targetFields }`
  lets a Settings screen show and edit the saved mapping with no file in hand.
  `sourceHeaders` are the columns it was drawn against, so you can warn when a
  new file's headers have drifted.
- `PUT /imports/csv/mapping` with `{ mapping, sourceHeaders }` saves it directly.
- Each import records the mapping it actually used, as `import.columnMapping` —
  that's what answers "why did March's file put the phone in the wrong place?"

### Two things worth surfacing in the UI

**Duration units are two separate fields.** `Duration (minutes)` and
`Duration (hours)` both exist because a column called `Est. Hours` mapped onto
minutes would turn a 2-hour visit into a 2-minute one, silently. Make the unit
obvious at the point of choosing.

**`Parent job number` is optional and changes behaviour.** Unmapped, each row
becomes its own job. Mapped, rows sharing that value group into one job — which
is what lets the agent offer to confirm a customer's other visits. Worth a
sentence of helper text.

---

## 3. The date-format conversation — the one real UX requirement

`03/04/2026` is 3 April in most of the world and 4 March in the US, and a
spreadsheet carries no indication which was meant. Getting it wrong books a
technician on the wrong day, so **the backend refuses to guess**.

It resolves the question once for the whole file:

- If any date in the column has a part over 12 (`25/12/2026`), that proves the
  order and **every** row is read that way. No prompt.
- If the file contains dates proving *both* orders, it is rejected as
  self-contradictory (422). The message quotes both offending cells.
- If every date could be read either way, it is rejected (422) **and you must
  ask the user**.

### The flow you need to build

1. Upload normally.
2. On a 422 whose `error` matches `/can't tell which you meant/`, show a
   day-first / month-first chooser rather than a generic error. Showing a few
   sample dates from the file helps the user answer.
3. Re-upload the same file with `&dateOrder=MDY` or `&dateOrder=DMY`.

A good touch: once a company has answered, remember their choice client-side
and send `dateOrder` pre-emptively on their next upload. The backend still only
uses it when the file is genuinely ambiguous, so sending it always is harmless.

ISO dates (`2026-03-04`) are never ambiguous — worth mentioning in your upload
help text as the way to avoid the question entirely.

---

## 4. The import record

Returned by `GET /imports/csv/:id`, `GET /imports/csv`, and inside the upload
response as `import`.

```json
{
  "id": "17",
  "companyId": 12,
  "uploadedBy": 55,
  "uploadedByEmail": "ops@acme.test",
  "filename": "march-visits.csv",
  "fileSize": 48213,
  "contentAvailable": true,
  "contentPurgedAt": null,
  "status": "completed",
  "engineRunId": "204",
  "dateOrder": "MDY",
  "columnMapping": { "phone": "Contact Mobile" },
  "totalRows": 128,
  "importedRows": 126,
  "errorRows": 2,
  "errors": [ { "row": 14, "column": "Phone", "message": "…" } ],
  "error": null,
  "createdAt": "2026-09-22T10:04:00.000Z",
  "startedAt": "2026-09-22T10:04:01.000Z",
  "finishedAt": "2026-09-22T10:04:09.000Z"
}
```

- `status` — `pending` | `running` | `completed` | `failed`. A dry run stays
  `pending`.
- `errors` — **per-row** problems on an otherwise successful import. `row` is
  the line number as the user sees it in Excel (header is row 1), so it's
  directly quotable: *"Row 14: …"*.
- `error` — a single **whole-file** failure message, set only when `status` is
  `failed`. `errors` and `error` are different things; don't conflate them.
- The stored `errors` list is capped at 500 entries while `errorRows` keeps the
  true count — so render "showing first 500 of 1,204 problems" when they differ.

- `uploadedByEmail` — captured at upload time so the archive still names who
  ran it after that user is removed. `uploadedBy` can go null; this won't.
- `contentAvailable` — **false once the file has been purged** (see below).
  Gate any "run again" button on it.
- `columnMapping` — the mapping this particular import used.

### Retention: 30 days

The uploaded file and its per-row detail are deleted 30 days after upload; the
**summary row is kept indefinitely**, so the archive list stays complete. After
the purge, `contentAvailable` is `false`, `GET /imports/csv/:id/rows` returns
an empty list, and reprocess returns `410`. Show those rows as "file no longer
stored — upload again to re-import" rather than offering a re-run that can't work.

### Other reads

```
GET /imports/csv             → { "imports": [ …, … ] }  // newest first, ?limit= (max 100)
GET /imports/csv/:id         → { "import": { … } }      // 404 if not this company's
GET /imports/csv/:id/rows    → { "rows": […], "contentAvailable", "errorRows" }
```

`…/rows` is the spreadsheet as we actually read it — each entry has
`rowNumber`, the original cells (`payload`), the typed interpretation
(`mapped`), and `error`. Add `?onlyErrors=true` for the error report: showing
the user's own cells next to the reason is the difference between an
actionable report and "something was wrong with row 14". Supports `limit`
(max 2000) and `offset`.

---

## 5. Reprocess

```
POST /imports/csv/:id/reprocess
body: { "dateOrder": "MDY" }   // optional
```

Re-runs the import from the file already stored — no re-upload. Returns `202`
with the same envelope as §2.1.

Three things it's for:

1. **Committing a dry run** without asking the user to pick the file again.
2. **Fixing a date misread** — re-run with the correct `dateOrder`.
3. **Retrying a failed run.**

Safe to call repeatedly: every write is an upsert keyed on the row's reference,
so re-running converges rather than duplicating.

`409` if that import is currently `running`.

---

## 6. Progress (SSE)

Identical to the contract in `docs/workflow-engine-frontend.md` §3.4 — connect
to `streamUrl` from the upload response. Engine `kind` is `csv_import`.

**States**, in order:

```
parsing → mapping → staging → writing_customers → writing_locations
        → writing_contacts → writing_jobs → writing_appointments → done | failed
```

`staging` writes the raw layer — every row as it was read, before anything
reaches the customer's data. That's what backs `…/rows` and the error report.

**Sub-events:**

| Event | Payload | Meaning |
|---|---|---|
| `mapped` | `{ total, usable, errors, dateOrder }` | validation finished — good for a "126 of 128 rows OK" line |
| `entity_done` | `{ entity, count }` | one table written; `entity` is `csv_import_rows` (the raw layer) then `customers`/`locations`/`contacts`/`jobs`/`appointments` |
| `warning` | `{ code, message }` | non-fatal, e.g. a duplicate column, or visits that couldn't be linked to a job |

Because the work completes **before** the HTTP response returns, a small
import is often already `done` when you connect. The stream replays from the
beginning, so you'll still get the full sequence — don't treat an
already-finished run as an error.

For a file of a few hundred rows this is fast enough that a simple spinner is
fine; the stream is worth wiring for larger files where the stage labels are
genuinely reassuring.

---

## 7. What lands in the product afterwards

Imported rows become ordinary `jobs` and `appointments` with `source: "csv"`.
They appear on the dashboard, in job lists, and in the confirmation sweep
**exactly like CRM-sourced ones** — no screen needs a CSV-specific branch.

Two consequences worth knowing:

- **Imported customers are voice-only by default.** `is_sms` and `is_email`
  default to `false`. If the company wants texts or chat links, someone must
  turn those on per customer — surfacing that after an import ("126 customers
  imported, all set to voice — change channels?") would save a support ticket.
- **A technician name only attaches if it matches someone already on the
  roster.** Unmatched names leave the visit unattributed rather than creating a
  technician, so a typo doesn't pollute the roster. Consider showing how many
  visits ended up unattributed.

---

## 8. Re-uploading: what changes and what doesn't

Companies will re-upload a refreshed export regularly, so this matters.

- Rows are matched on their **reference**, so an edited row updates in place
  rather than duplicating.
- **A visit the customer already confirmed or rescheduled is protected** — a
  re-upload will not move its time or reset its status. A nightly export is
  stale by construction and must not silently undo an agreement made on a call.
  If the office genuinely needs to move a confirmed visit, that's a deliberate
  action in the UI, not a side effect of an upload.
- **A visit missing from a later file is left alone**, never auto-cancelled — a
  partial export looks identical to a real cancellation. Stale rows simply age
  out. Don't build UI that implies an upload "syncs" or "replaces" the
  schedule; it adds and updates only.

That last point is worth reflecting in your wording: call the action **"Import
visits"**, not "Sync" — the latter sets an expectation the backend deliberately
does not meet.

---

## 9. Suggested UI

**Settings → Integrations.** A "CSV / Spreadsheet" tile alongside the CRM
tiles, for companies with no CRM. It should carry a short "download a template"
link — a two-row example CSV with the required headers prevents most 422s.

**The import screen:**

1. Drop zone (`.csv`, `.xlsx`) with the 4 MB limit stated up front.
2. On drop → upload with `dryRun=true`.
3. **If `422` with `code: "UNMAPPED_COLUMNS"`** → the mapping step (§2b),
   pre-filled from `suggestedMapping`. Re-submit with `&mapping=…`. Expect this
   on most *first* uploads and almost never afterwards, since the mapping is
   remembered.
4. Show the preview: total rows, how many are usable, the error table
   (row / column / message), the resolved mapping (`preview.mapping`, as
   "Phone ← Contact Mobile"), and the unrecognised columns.
5. Primary action **"Import 126 visits"**; secondary "Cancel". The primary
   calls reprocess (§5) on the dry-run's `importId`.
6. Progress via SSE, then a result summary with a link to the job list.

Showing the resolved mapping at step 4 matters even when nothing needed
mapping: it's the user's only chance to notice that their "Job Number" column
was read as the visit reference before 400 visits land in the wrong shape.

**Import history.** A table from `GET /imports/csv` — filename, when, status,
"126 of 128 imported". Row click opens the error detail. Failed and dry-run
rows both need a "Run again" action.

**Error presentation.** Group by message rather than listing 200 rows
individually — *"18 rows: Could not read the phone number"* is far more
actionable than eighteen near-identical lines, and the user usually fixes one
column, not eighteen cells.

---

## 10. Not built yet — don't design around these

- **No endpoint to put a company into "CSV mode".** A row in `csv_integration`
  is currently inserted by hand. Until there's a connect route, the Settings
  tile can't actually be wired to an enable/disable action — build the import
  screen first and treat the tile as a later step.
- **No mutual-exclusion enforcement** between CSV and a real CRM. The backend
  won't currently stop a company having both, so don't rely on it to; if you
  show the CSV tile at all, hide it when a CRM is connected.
- **No error-CSV download.** Errors come back as JSON only. If the office wants
  a "download the failed rows" button, that's a backend addition.
- **No multi-format memory.** One saved mapping per company. A company with two
  genuinely different exports would have the second overwrite the first. When
  that turns up it needs a header fingerprint on `csv_column_mappings`.

---

## 11. Checklist

- [ ] Upload sends the **raw `File`**, never `FormData`
- [ ] `filename` query param always set, with its extension
- [ ] 4 MB limit enforced client-side, with a readable message
- [ ] `422` + `code: "UNMAPPED_COLUMNS"` opens the **mapping screen**, not an error
- [ ] `one-of:` requirements validated per **group**, not per field
- [ ] Every column selectable for every field, ordered by `columns` ranking
- [ ] Duration **minutes vs hours** made unmistakable at the point of choosing
- [ ] Any other `422` rendered verbatim — it names the missing column
- [ ] The ambiguous-date 422 gets a **day-first / month-first chooser**, not a generic error
- [ ] Dry-run preview before any real import
- [ ] Commit via reprocess on the dry run's `importId` — no second upload
- [ ] `errors` (per-row) and `error` (whole-file) rendered differently
- [ ] "showing first N of M" driven by `errors.length` vs `errorRows` — the cap is 50 in a preview and 500 in a stored record
- [ ] Row numbers quoted as-is — they're Excel line numbers
- [ ] Action named "Import", not "Sync"
- [ ] Post-import note about customers defaulting to voice-only
