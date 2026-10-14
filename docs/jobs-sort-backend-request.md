# Jobs list — sort by visit date (Backend Request)

> **From the frontend, for the backend.** Two optional query params on the
> existing `GET /jobs`. No new route, and no change to the response shape.
> The Jobs page already sends them; until the backend reads them, the list
> keeps its current order.

---

## 1. The problem

The Jobs page should be sorted by **visit date**, increasing by default, with a
control to switch to decreasing.

`GET /jobs` is paginated (50 per page), so sorting has to happen server-side —
sorting one page in the browser would be wrong as soon as there's a page 2.
Today `listJobs` (`src/db/jobs.js`) always orders by the job-level date:

```sql
ORDER BY j.scheduled_date ASC NULLS LAST, j.created_at DESC
```

That is **not** the date the table shows. The "Visit Date" column renders
`active_appointment.scheduled_start` — the job's latest appointment that isn't
cancelled or rescheduled, from the `LEFT JOIN LATERAL ... a` in the same
query. After a reschedule the two disagree, so a "sorted by date" list looks
out of order.

## 2. The request

`GET /jobs?sort=visit_date&order=<asc|desc>` — both optional.

| param | values | meaning |
|---|---|---|
| `sort` | `visit_date` (only value, and the default) | the active appointment's start, `a.scheduled_start` (aliased `active_appointment_start`) |
| `order` | `asc` (default) · `desc` | increasing · decreasing |

The Jobs page has a single control, "Visit date: Increasing / Decreasing",
and sends `sort=visit_date` with the chosen `order` on every request.

Suggested implementation — never interpolate the raw param:

```js
const dir = order === "desc" ? "DESC" : "ASC";

// NULLS LAST in both directions: a job with no visit belongs at the bottom,
// not the top of a decreasing list. j.id as the final tiebreaker keeps paging
// stable (no row on two pages).
`ORDER BY a.scheduled_start ${dir} NULLS LAST, j.id ${dir}`
```

Route (`src/routes/jobs.js`): read `sort` / `order` from `req.query` and pass
them to `listJobs` alongside the other filters. An unknown value should fall
back to the default rather than `400`, so an older or newer frontend never
breaks the page.

**Default changes** from `j.scheduled_date` to the visit date. That is the
point of the request, and the frontend always sends `sort` anyway.

## 3. Why this is safe

- The count query is unaffected — ordering doesn't change `total`.
- `a` is already joined for every row, so sorting on it adds no join. If it
  shows up as slow on large tenants, an index on
  `appointments (job_id, scheduled_start DESC)` serves the lateral lookup.
- No response fields change.
