# Jobs list — "due soon first" ordering (Backend Request)

> **From the frontend, for the backend.** A change to the default ordering of
> `GET /jobs`, on top of the visit-date sort already shipped in `6b97845`
> ("Sort GET /jobs by visit date"). One `ORDER BY` changes; no new params, no
> route change, no response shape change. The frontend needs no change — it
> already sends these params.

---

## 1. Where things stand

`6b97845` added `?sort=visit_date&order=asc|desc` to `GET /jobs`
(`src/routes/jobs.js` → `listJobs` in `src/db/jobs.js`). Today:

| request | `ORDER BY` |
|---|---|
| `order=asc` (default) | `a.scheduled_start ASC NULLS LAST, j.id ASC` |
| `order=desc` | `a.scheduled_start DESC NULLS LAST, j.id DESC` |

`a` is the existing `LEFT JOIN LATERAL`: the job's latest appointment whose
status is not `cancelled`/`rescheduled`. That's also what the Jobs table shows
in its "Visit Date" column.

The frontend sends `sort=visit_date&order=asc` on every load (the default) and
`order=desc` when the user picks "Visit date: Decreasing".

## 2. The problem

A plain ascending sort puts the **oldest past visit** at the top. Every
company has months of completed inspections, so the Jobs page opens on
history from long ago, and the inspections that are **due soon** are buried
pages down. Users want the page to open on what's coming up next.

## 3. The change — `order=asc` only

`order=asc` (and the default, and any unknown value that falls back to it)
becomes **due soon first**:

1. Jobs whose visit is **upcoming** (`a.scheduled_start >= NOW()`), soonest first.
2. Then jobs whose visit is in the **past**, most recent first.
3. Jobs with **no visit** (`a` is null) last.

```sql
ORDER BY
  (a.scheduled_start IS NULL),                                          -- no visit last
  (a.scheduled_start < NOW()),                                          -- upcoming before past
  CASE WHEN a.scheduled_start >= NOW() THEN a.scheduled_start END ASC,  -- upcoming: soonest first
  a.scheduled_start DESC,                                               -- past: most recent first
  j.id ASC                                                              -- stable paging
```

How it works: Postgres sorts `false` before `true`, so the first two boolean
keys split the rows into upcoming → past → none. The `CASE` is null for past
rows, so it only orders the upcoming group (`ASC` puts nulls last, which
doesn't matter since groups are already separated). The plain
`a.scheduled_start DESC` then orders the past group.

**`order=desc` is unchanged**: `a.scheduled_start DESC NULLS LAST, j.id DESC`.

Keep the existing guarantees from `6b97845`:
- `sort`/`order` are mapped to fixed SQL fragments, never interpolated.
- Unknown values fall back to the default (now due-soon-first), never `400`.
- `order` stays case-insensitive.
- The count query gets no `ORDER BY`, so `total` is unaffected.

### Notes

- **Timezone:** `NOW()` against a `timestamptz` compares instants, so no
  company-timezone handling is needed here (unlike the
  `scheduled_date_from/to` filters, which compare local *dates*).
- **Why `a` and not the next upcoming appointment:** sorting on the same
  appointment the "Visit Date" column displays keeps the list visibly in
  order. The trade-off: a job with two future visits sorts by its later one
  (that's the date it shows). If you'd rather key on the *next* upcoming
  visit, the list response would also need to return that date so the column
  can show it. Please raise that rather than changing only the sort.
- **Performance:** `a` is already joined for every row; this adds no join.

## 4. Tests — `test/jobs-sort.test.js`

Update the cases that assert the default `ORDER BY`. Their expected string
becomes the due-soon clause above:

- "default: visit date increasing, jobs with no visit last, id tiebreaker"
- "unknown sort/order fall back to the default instead of failing"
- "the raw params are never interpolated into SQL" (its final `orderBy()` assertion)

Leave the `desc` and case-insensitivity cases as they are. Add a case that
`order=asc` given explicitly yields the same due-soon clause as the default.

Note that `orderBy()` in that file captures only one line
(`/ORDER BY ([^\n]+)/`). Either emit the new clause on a single line, or
widen the helper to capture up to `LIMIT`.

If there's a DB-backed test path, one fixture covers the behaviour: three
jobs with a past visit, a future visit and no visit. Default order should be
**future, past, none**. With two past visits, the more recent comes first.
