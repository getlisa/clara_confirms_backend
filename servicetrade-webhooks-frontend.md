# ServiceTrade Webhooks (realtime sync) — Frontend Guide

> **For the frontend agent.** Four new authenticated endpoints on the existing
> ServiceTrade integration screen, plus a "refresh now" action. Same conventions
> as `confirmation-contact-types-frontend.md`.
>
> **This is the single source of truth for the webhook contract.** `api-contracts.md`
> §8 intentionally carries only a pointer here rather than a second copy, so the
> two cannot drift. Update this file, not that one.

Base URL: `VITE_API_URL` · Auth: `Authorization: Bearer <token>` on everything below.

## Endpoints at a glance

| endpoint | purpose | § |
|---|---|---|
| `GET /integrations/servicetrade/webhook` 🔒 | registration + ServiceTrade's own view + queue depth | [1](#1-get-integrationsservicetradewebhook-) |
| `POST /integrations/servicetrade/webhook` 🔒 | enable / repoint (idempotent) | [2](#2-post-integrationsservicetradewebhook-) |
| `DELETE /integrations/servicetrade/webhook` 🔒 | disable | [3](#3-delete-integrationsservicetradewebhook-) |
| `POST /integrations/servicetrade/webhook/drain` 🔒 | apply queued events now ("refresh") | [4](#4-post-integrationsservicetradewebhookdrain---the-refresh-button) |
| `POST /webhooks/servicetrade/:secret` | **PUBLIC — ServiceTrade only.** Nothing to build. | [9](#9-the-public-receiver--for-reference-only) |

All payloads below are copied from **live responses** against a real ServiceTrade
account, not hand-written examples.

---

## 0. What shipped

ServiceTrade can now **push** changes to us instead of us waiting for the hourly
poll. When a job, appointment, contact, location, customer or technician changes
in the CRM, ServiceTrade POSTs us the entity id, we queue it, and a background
drain refreshes that job and everything attached to it.

**The hourly sync is unchanged and still required.** Do not remove or relabel any
existing sync UI. Webhooks make the common case fast; they are not a replacement,
for two reasons worth surfacing in help text if you show any:

- **Service opportunities are not realtime.** ServiceTrade has no webhook for
  ServiceRequest — the entity `service_opportunities` is built from — so that
  data only ever refreshes on the poll.
- ServiceTrade **discards a message after 3 failed delivery attempts**. If our
  backend is down for a few minutes, those changes are gone and only the poll
  recovers them.

There is nothing to build for the receiving endpoint itself: it is a public
backend route that ServiceTrade calls directly.

### One thing to get right

**Never present `confirmed` as "the webhook is working."** It is ServiceTrade's
own flag and it is not trustworthy — verified twice: a subscription registered
against a domain that cannot resolve reported `confirmed: true` one second after
creation, and a subscription against a genuinely reachable URL received no
confirmation request at all. **`last_message_at` is the only evidence** that
messages are arriving. See §3 for the status rules.

---

## 1. `GET /integrations/servicetrade/webhook` 🔒

Read the current registration, ServiceTrade's own view of it, and the queue depth.

```json
// 200 — registered
{
  "ok": true,
  "subscription": {
    "company_id": 8,
    "servicetrade_webhook_id": "2687264638045377",
    "hook_url": "https://api.example.com/webhooks/servicetrade/5mMCA0jH3bgLCNdJc1glwGamHGL7zqqqs1g5WcnPywg",
    "enabled": true,
    "confirmed": false,
    "entity_events": [
      { "entityType": 3,  "actions": ["created", "updated", "deleted"] },
      { "entityType": 4,  "actions": ["created", "updated", "deleted"] },
      { "entityType": 5,  "actions": ["created", "updated", "deleted"] },
      { "entityType": 11, "actions": ["created", "updated", "deleted"] },
      { "entityType": 16, "actions": ["created", "updated", "deleted"] },
      { "entityType": 22, "actions": ["created", "updated", "deleted"] }
    ],
    "last_message_at": "2026-08-12T12:29:33.665Z",
    "created_at": "2026-08-12T12:26:56.323Z",
    "updated_at": "2026-08-12T12:26:57.638Z"
  },
  "upstream": {
    "id": 2687264638045377,
    "uri": "https://app.servicetrade.com/api/webhook/2687264638045377",
    "hookUrl": "https://api.example.com/webhooks/servicetrade/5mMCA0…",
    "enabled": true,
    "confirmed": true,
    "includeChangesets": true,
    "entityEvents": [ "…same shape…" ]
  },
  "queue": { "pending": 2, "done": 41, "failed": 1 }
}
```

```json
// 200 — never registered
{ "ok": true, "subscription": null, "queue": {} }
```

### Field notes — read these before binding anything

| field | note |
|---|---|
| `servicetrade_webhook_id` | **string**, not number. It is a Postgres `BIGINT` (~2.7×10¹⁵) and would lose precision as a JS number. Never `parseInt` it. |
| `hook_url` | **contains a secret.** See §5. |
| `confirmed` | ServiceTrade's flag, mirrored for display. **Not** proof of reachability. |
| `last_message_at` | `null` until the first real message arrives. This is the health signal. |
| `entity_events[].entityType` | numeric ServiceTrade constant — map with the table in §6. |
| `upstream` | `null` when we hold no ServiceTrade id or the session is dead. `{ "error": "HTTP 404", "missing": true }` when the subscription was deleted **inside ServiceTrade** — surface this as drift, see §3. |
| `queue` | **only non-zero statuses are present.** Default every missing key to `0`; do not assume `pending` exists. Possible keys: `pending`, `processing`, `done`, `failed`, `skipped`. |

---

## 2. `POST /integrations/servicetrade/webhook` 🔒

Register, or repoint an existing registration at the current backend URL.
**Idempotent** — safe to call repeatedly; it updates the existing subscription
rather than creating a second one. (ServiceTrade delivers every message to every
webhook on the account, so a duplicate would mean processing every change twice,
forever.)

```jsonc
// Request — body optional, send {} for the normal case
{
  "include_changesets": true   // optional, default true. Leave it alone.
  // "base_url": "https://…"   // testing only (ngrok). Omit in the product.
}
```

```json
// 200
{ "ok": true, "subscription": { "…same shape as §1…" } }
```

### Errors — each needs a different message

| status | body | what to tell the user |
|---|---|---|
| `400` | `{"error":"PUBLIC_API_URL is not set — ServiceTrade needs a stable public URL to POST to"}` | Backend misconfiguration. Not user-fixable — surface as "contact support", don't offer a retry. |
| `400` | `{"error":"Webhook base URL must be public https — got …"}` | Same: environment problem. |
| `400` | `{"error":"ServiceTrade not connected"}` | Actionable — send them to the connect step. |
| `403` | `{"error":"ServiceTrade rejected the webhook: …"}` | **The connected ServiceTrade user lacks the `admin.account` permission.** Say exactly that; it is fixed by a ServiceTrade admin, not by retrying. |
| `502` | `{"error":"ServiceTrade rejected the webhook: …"}` | Upstream failure. Retry is reasonable. |
| `500` | `{"error":"Failed to register webhook"}` | Generic. |

---

## 3. `DELETE /integrations/servicetrade/webhook` 🔒

```json
// 200
{ "ok": true, "removed": true }   // "removed": false if there was nothing registered
```

Deletes it in ServiceTrade and clears our record. A `404` from ServiceTrade
counts as success — already gone is the desired end state.

### Status rules for the UI

Derive one status from three fields; there is no single "healthy" flag.

| condition | show |
|---|---|
| `subscription === null` | **Not enabled** — offer the enable button |
| `subscription.enabled === false` | **Paused** |
| `upstream?.missing === true` | **Out of sync** — the subscription was deleted inside ServiceTrade. Offer re-register (`POST`). |
| `last_message_at === null` | **Waiting for first event** — *not* an error. A quiet CRM legitimately sends nothing for hours. Do not show a failure state here, and do not use `confirmed` to decide. |
| `last_message_at` is set | **Active**, with "last event <relative time>" |
| `queue.failed > 0` | **Warning** alongside any of the above — see §4 |

---

## 4. `POST /integrations/servicetrade/webhook/drain` 🔒 — the refresh button

Applies this company's queued events immediately, instead of waiting for the
every-minute background drain.

```json
// 200 — work was done
{ "ok": true, "claimed": 3, "jobIds": ["2274033731792769", "2278067275916801"], "synced": true, "skipped": 0, "failed": 0 }
```

```json
// 200 — nothing was waiting
{ "ok": true, "claimed": 0, "jobIds": [], "synced": false }
```

```json
// 200 — events were claimed but none mapped to a job we track
{ "ok": true, "claimed": 2, "jobIds": [], "synced": false, "skipped": 2, "failed": 0 }
```

```json
// 200 — the refresh itself failed; the events go back to pending and will retry
{ "ok": true, "claimed": 1, "jobIds": ["227…"], "synced": false, "error": "ServiceTrade 500" }
```

`500` → `{"error":"Failed to apply queued webhook events"}`.

### Three things this button needs

1. **It is slow. Measured ~32 seconds** on a real account for a single event
   (~5 s fetching from ServiceTrade, ~24 s normalising into platform tables).
   Needs a spinner and a generous client timeout — **at least 120 s**. A 10 s
   default fetch timeout will abort it and look like a failure while the work
   actually completes.
2. **It is safe to hammer.** Concurrent drains cannot double-process the same
   event (the backend claims rows with `FOR UPDATE SKIP LOCKED`). Ten impatient
   clicks are harmless — but still disable the button while in flight so people
   aren't waiting on ten 30-second requests.
3. **`ok: true` does not mean success.** Read `synced` and `error`. A response
   with `"synced": false` and an `error` means nothing was refreshed. And note
   `"claimed": 0, "synced": false` is the *normal* idle case — say "already up to
   date", not "failed".

**After a successful drain, refetch whatever the screen shows** — jobs,
appointments, the job detail. The drain is what wrote the new data; the UI will
otherwise keep showing pre-refresh values.

`jobIds` are **strings** (see §1) and are ServiceTrade's ids, not our internal
`jobs.id`. Use them for display/logging only, not to look rows up directly.

### `queue.failed > 0` matters

A `failed` event is a change ServiceTrade successfully pushed to us that we could
not apply after 5 attempts. The data is not lost forever — the hourly poll will
pick it up — but the platform is stale until then. Worth a warning badge on the
integration screen with the count. There is no per-event detail endpoint yet; ask
if you want one.

---

## 5. The secret in `hook_url` — treat as a credential

ServiceTrade sends **no signature, no HMAC and no auth header** (verified against
their full published spec), so the unguessable segment at the end of `hook_url` is
the only thing authenticating inbound messages. Consequences for the UI:

- Do not render it in plain text by default. Mask it with a reveal toggle, the
  way an API key is handled.
- Do not put it in analytics events, error reports, breadcrumbs, or `console.log`.
- "Copy URL" is fine — a staff user configuring or debugging the integration
  legitimately needs it.
- The `secret` field itself is **never** returned by the API; only the assembled
  URL is.

What limits the damage if it leaks: the payload is only entity ids, so a forged
message can at most make the backend re-fetch a real entity from ServiceTrade. It
cannot inject or overwrite data.

---

## 6. Entity type constants

`entity_events[].entityType` is a ServiceTrade numeric constant. Map for display:

| value | ServiceTrade | our label |
|---|---|---|
| `3` | Job | Jobs |
| `4` | User | Technicians |
| `5` | Company | Customers |
| `11` | Location | Locations |
| `16` | Appointment | Appointments |
| `22` | Contact | Contacts |

All six are subscribed to all three actions (`created`, `updated`, `deleted`) and
this is **not configurable from the UI** — the backend owns the list, because each
subscribed type costs a database round-trip per delivery whether or not we act on
it. Render it read-only if you show it at all.

---

## 7. Expected behaviour worth explaining in the UI

- **Your own actions cause events.** When the platform reschedules, cancels or
  books an appointment, it writes to ServiceTrade, and ServiceTrade pushes that
  change straight back to us. So `queue` counts will tick up after staff actions,
  not only after CRM edits. This is harmless and self-terminating — the refetch
  writes only to our database — but do not present it as "someone changed this in
  ServiceTrade", because it may well have been us.
- **Latency is up to ~60 seconds**, not instant: the background drain runs every
  minute, and the drain itself takes ~30 s. "Usually within a minute" is honest
  phrasing. The refresh button is for people who don't want to wait.
- **Events can arrive out of order and more than once.** The backend handles
  both; nothing is needed from the frontend.

---

## 8. Unrelated, same release: the confirmation chat `done` event

`POST /chat-links/:token/messages` now streams **real model tokens** instead of
replaying the finished reply as fake typing. **The SSE contract is unchanged** —
`typing` → `message_delta`* → `message_complete` → `done`, all `role: "agent"` —
so no frontend change is required and the existing widget works as-is.

Two optional additions on the `done` event:

```json
{ "state": "chat_ended", "input_hint": null, "first_token_ms": 3412, "total_ms": 8130 }
```

`first_token_ms` is `null` on a turn that produced no text (the agent called a
tool and said nothing). Ignore both fields unless you want them for diagnostics.

One consequence to be aware of: deltas now arrive over several seconds rather
than in one burst at the end, so any code that assumes the whole reply lands in a
single tick — a debounce, a scroll-to-bottom that only fires once, an animation
keyed to the first chunk — should be checked against the slower cadence.

---

## 9. The public receiver — for reference only

```
POST /webhooks/servicetrade/:secret     ← no auth, called by ServiceTrade
```

**Nothing to build here, and nothing in the app should ever call it.** Included so
the whole contract lives in one file, and because its constraints explain several
of the choices above.

ServiceTrade's documented delivery rules:

- **5 seconds to respond**, then retry; **3 attempts, then the message is
  discarded permanently.** This is why the endpoint only queues, and why the work
  happens later in the drain — and therefore why the refresh button is slow rather
  than the webhook being slow.
- **Any status in 200–499 counts as a successful delivery.** A `404` or `403` is
  not a rejection, it silently throws the change away. So the receiver answers
  `200` to everything it can parse — unknown secret, malformed body, entity types
  we don't model — and `503` only when our database is unreachable, which is the
  one case where a redelivery can help.
- **Messages may arrive out of order and more than once**, and one message batches
  many entities. Handled backend-side (deduped per entity, not per message).

The payload carries **entity ids only**, e.g.:

```json
{
  "messageId": "22b80b92-fdea-4c2c-8f9d-bdfb0c7bf324",
  "timestamp": "1401833057",
  "data": [
    {
      "action": "updated",
      "timestamp": 1401833052,
      "userId": 1234,
      "entity": { "type": "job", "id": 34872, "uri": "https://api.servicetrade.com/api/job/34872" },
      "changeset": [{ "field": "status", "oldValue": "scheduled", "newValue": "completed" }]
    }
  ]
}
```

That is the whole message — no entity data — which is why applying it requires a
fetch and normalize round trip, and why the drain takes ~30 s rather than being
instantaneous.
