# Chat Footer Branding Link — Click Tracking — Backend Requirements

> **From the frontend, for the backend.** Verified against `clara_confirms_backend`
> source directly this session (migrations, `routes/chat-links.js`,
> `services/chat-links.js`) — not inferred.

## What this is for

The chat widget is getting a small "Powered by Clara AI" footer, linking out to
`https://www.justclara.ai`. The frontend part (rendering it, opening the link)
needs nothing from the backend. What does need backend work: **counting how
many people click it**, per the explicit ask ("have to see how many people
click").

**Nothing like this exists today.** Confirmed no analytics/monitoring library
anywhere in the frontend (`package.json`, full `src/` tree) and no generic
click/UI-event tracking table or endpoint in the backend. The one adjacent
thing, `confirmation_events` (migration 097), is deliberately narrow — its own
`event_type` CHECK constraint only allows `'confirmed' | 'rescheduled' |
'cancelled' | 'created'`, and it exists specifically to feed the daily
confirmation report. A footer-link click isn't a confirmation outcome and
doesn't belong in that ledger — reusing it would mean either violating its
constraint or overloading a table whose whole documented purpose is a
different, more specific thing.

## What's needed: one small table + one public write endpoint

Same shape as `confirmer_identities` (migration 100) — a small table keyed off
`chat_links.token`, written by a new public endpoint on the existing
`openCors`-protected router (`GET /:token`, `POST /:token/messages`, and
`POST /:token/end` are already public/unauthenticated the same way — no new
auth pattern needed).

**Migration** (next number is 102 — 101 is the last one that exists,
`onsite_instructions`):

```sql
CREATE TABLE IF NOT EXISTS chat_footer_link_clicks (
  id BIGSERIAL PRIMARY KEY,
  chat_link_token TEXT NOT NULL REFERENCES chat_links(token) ON DELETE CASCADE,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  clicked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_footer_link_clicks_company_time_idx
  ON chat_footer_link_clicks (company_id, clicked_at);
```

Not unique on `chat_link_token` (unlike `confirmer_identities`) — a customer
could click more than once in one session, and each click is a real, separate
event worth counting, not a piece of session state to overwrite.
`company_id` is denormalized onto the row (same call `confirmation_events`
makes) purely so a per-company rollup query doesn't need to join back through
`chat_links` every time.

**Endpoint**, following the exact pattern already in
`routes/chat-links.js:292-303`:

```js
router.options("/:token/footer-click", openCors);
router.post("/:token/footer-click", openCors, async (req, res) => {
  try {
    const link = await chatLinksDb.getByToken(req.params.token);
    if (!link) return res.status(404).json({ ok: false });
    await db.query(
      `INSERT INTO chat_footer_link_clicks (chat_link_token, company_id) VALUES ($1, $2)`,
      [link.token, link.company_id]
    );
    return res.json({ ok: true });
  } catch (err) {
    logger.error("POST /chat-links/:token/footer-click failed", { error: err.message });
    return res.status(500).json({ ok: false }); // best-effort — never worth surfacing to the customer
  }
});
```

Best-effort by design, same philosophy as every other write in this file that
isn't the customer's actual confirmation action — a failure here should log
and return, never block or error out anything the customer sees. The frontend
call is fire-and-forget for the same reason (see below).

## Open decision this doc doesn't resolve

**How do you actually want to see the count?** This doc only covers capturing
the data — it does not add a read/reporting path. Options, not resolved here:

- A raw SQL query against `chat_footer_link_clicks` is enough for now (no new
  endpoint at all) if this is just "check occasionally," not a standing UI.
- A small addition to the existing dashboard aggregate (`services/analytics.js`
  /`routes/dashboard.js`, already does per-company/per-period rollups for
  calls/jobs/todos) if this should show up alongside those numbers.

Flagging rather than picking, since it changes scope (query vs. new endpoint
vs. dashboard card) and wasn't specified.

## Frontend side (no backend dependency, already planned)

The footer itself — text, link, `target="_blank"` — renders regardless of
whether this endpoint exists yet. The click-tracking call will be wired as a
`fetch(..., { method: "POST" }).catch(() => {})` fired on click, alongside the
real navigation — best-effort, ignored on failure, never blocks or delays
opening the link. Until the backend ships `/chat-links/:token/footer-click`,
that call just 404s silently with zero effect on the customer-visible feature.
