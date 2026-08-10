# Frontend-Requested Backend Change — `GET /jobs` Pagination Metadata

> Written from the frontend (`clara-confirms`), same convention as the other
> `*-frontend.md` docs in this repo. One small change is requested; everything
> the frontend needs is already built and waiting for it.

## The ask

**`GET /jobs` should return a `pagination` object, identical in shape to the
one `GET /customers` already returns.**

```json
{
  "jobs": [ /* unchanged */ ],
  "pagination": { "total": 173, "limit": 50, "offset": 0, "totalPages": 4 }
}
```

Nothing about the `jobs` array changes — this is purely additive, so no
existing client breaks.

## Why

The Jobs page (`/inspections`) now paginates at 50 per page and needs the same
numbered pagination bar the Customers page has (`Previous · 1 2 3 … 4 · Next`).
That bar needs a page count, and a page count needs `total`.

Today `GET /jobs` returns rows only (`src/routes/jobs.js` → `res.json({ jobs })`),
and `jobsDb.listJobs` returns `result.rows.map(...)` with no count — so the
total genuinely isn't derivable client-side. The frontend can't work around it
either: `limit` is capped at 200 in the route, so "fetch everything and count"
would silently cap out (one company already has 173 jobs).

## Where

- `src/db/jobs.js` → `listJobs()` (line ~70) — return a count alongside the rows.
- `src/routes/jobs.js` → `GET /` handler (line ~113) — put it in the response.

`src/db/customers.js` → `list()` (line ~31) is the exact pattern to copy: build
`where`/`values` once, run the rows query and a `COUNT(*)` over the same
`where` in a `Promise.all`, return `{ rows, total }`.

## Two things to watch out for

These are the only non-obvious parts — worth calling out because a
copy-paste of the customers version will get both wrong.

**1. `values` currently has `limit`/`offset` pushed onto it before the query.**

```js
values.push(limit, offset);          // ← mutates the shared array
const result = await db.query(`… LIMIT $${i++} OFFSET $${i}`, values);
```

The count query must NOT receive those two params (it has no `LIMIT`/`OFFSET`),
so snapshot the filter values before appending them — the way `customers.js`
does:

```js
const [rowsResult, countResult] = await Promise.all([
  db.query(`… LIMIT $${i} OFFSET $${i + 1}`, [...values, limit, offset]),
  db.query(`SELECT COUNT(*)::int AS n FROM jobs j JOIN customers c ON c.id = j.customer_id WHERE ${where}`, values),
]);
```

Otherwise the count query throws (or silently misreads params) on every
request that has any filter applied.

**2. The count needs `JOIN customers c`, but not the `LEFT JOIN LATERAL`.**

- `JOIN customers c` is an **inner** join, so it can *exclude* jobs — the count
  must include it or `total` will exceed the number of rows actually
  returnable. It's also required whenever `search` is set, since that
  condition references `c.full_name`.
- The `LEFT JOIN LATERAL (… LIMIT 1) a` only exists to populate
  `active_appointment`. It never excludes or duplicates rows, so leave it out
  of the count — it's pure overhead there.
- `COUNT(*)` is correct (not `COUNT(DISTINCT j.id)`): both appointment-based
  filters — the `scheduled_date_from`/`to` window and the `confirmed` filter —
  are already written as `EXISTS`/scalar subqueries rather than joins, so there
  is exactly one row per job and nothing multiplies.

## `totalPages`

Compute it from the **clamped** limit the route actually used, not the raw
query param (`limit` is `Math.min(Number(limit), 200)`, default 50) — same as
`customers.js`:

```js
totalPages: Math.max(Math.ceil(total / limitNum), 1)
```

`Math.max(…, 1)` matters so an empty result set reports `totalPages: 1` rather
than `0`, which is what the frontend's pagination bar expects.

## What the frontend does in the meantime

Already shipped, so there's no rush and nothing is blocked:

- `getJobs()` (`src/lib/auth-api.ts`) already reads `data.pagination` and
  returns it — it's just `undefined` today.
- `InspectionsPage.tsx` requests `limit: perPage + 1` (51) as a probe and
  slices the extra row off. Getting 51 back is the only available proof that a
  52nd row exists, i.e. that there's a next page.
- `PaginationBar` renders a reduced `Previous · Page N · Next` when
  `totalPages` is `undefined`, instead of inventing a page count.

**`InspectionsPage` already prefers `data.pagination.totalPages` when it's
present.** So the moment this ships, the Jobs page switches to the full
numbered bar — identical to the Customers page — with **no frontend change
required**. The `+1` probe becomes redundant and can be dropped in a follow-up.

## Acceptance check

With ~173 jobs on a company and no filters applied:

- `GET /jobs?limit=50&offset=0` → `pagination: {total: 173, limit: 50, offset: 0, totalPages: 4}`
- `GET /jobs?limit=50&offset=150` → same `total`/`totalPages`, `offset: 150`, 23 rows
- `total` must react to filters — e.g. `?confirmed=false` and
  `?status=scheduled,confirmed` should each report the filtered total, not the
  unfiltered 173. (This is the thing to actually verify: it's what proves the
  count is using the same `where` as the rows query.)
- `GET /jobs?search=<something-matching-nothing>` → `total: 0`, `totalPages: 1`
