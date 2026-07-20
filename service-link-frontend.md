# Service Link email after confirmation — Frontend Integration Guide

> Covers the frontend surfaces for the new **Service Link** feature: after a
> customer **confirms** an appointment on a `customer_confirmation` call, Clara
> emails them the job's ServiceTrade Service Link. Everything here is additive.

## 0. What shipped

When the customer confirms, the agent (live, during the call) resolves the
recipient contact — searching existing ServiceTrade contacts, or creating a new
one — and captures the email. **After** the call, the backend emails the job's
Service Link and records the attempt with a status. Non-sent attempts are
surfaced so a human can follow up.

The whole thing is **off by default per company** and gated by a new setting.

---

## 1. New setting — `service_link_enabled` (Call Settings)

A new boolean on the existing Call Settings object, sitting alongside
`crm_comment_writeback_enabled` and `agent_can_make_changes`.

### `GET /call-settings`
`call_settings` now includes:
```json
{ "service_link_enabled": false }
```
Type `boolean`, default `false`.

### `PATCH /call-settings`
```json
{ "service_link_enabled": true }
```
Boolean, else `400`. Returns the full updated `call_settings`.

**Suggested UI:** a toggle on the Call Settings page — label *"Email the service
link after confirmation"*, help text *"When a customer confirms their
appointment, email them a ServiceTrade link to follow the job."* Default off.

---

## 2. Status surface — `GET /service-link-messages`

Standard JWT auth. Lists service-link email attempts for the company so the UI
can show anything that didn't send.

**Query:** `status` (`pending|sent|failed|skipped`), `limit`, `offset`.

**Response `200`:**
```json
{
  "service_link_messages": [
    {
      "id": 12,
      "retell_call_id": "call_abc",
      "job_external_ref": "2646306457509249",
      "contact_id": "123",
      "email": "joe@example.com",
      "status": "failed",
      "servicetrade_message_id": null,
      "error": "…",
      "created_at": "…", "updated_at": "…"
    }
  ]
}
```

**Status meanings:**
| status | meaning |
|---|---|
| `pending` | recipient captured on the call; send not completed yet |
| `sent` | link emailed successfully (`servicetrade_message_id` set) |
| `failed` | send attempted but ServiceTrade reported failure (see `error`) |
| `skipped` | customer confirmed but no recipient/email was captured, or the job isn't linked to ServiceTrade |

**Suggested UI:** a small "Service links needing attention" list (filter
`status=failed` + `status=skipped`), e.g. on the dashboard or the call detail —
with the email and a link back to ServiceTrade to resend manually.

---

## 3. New todo type — `SERVICE_LINK` (`GET /todos`)

When a link isn't sent (`failed`/`skipped`), a `SERVICE_LINK` todo is raised so a
human completes it. If the Todos UI switches on `type`, add a branch:
- **`SERVICE_LINK`** — metadata carries `retell_call_id`, `reason`, and (when
  known) `contact_id` / `email`. Action: send the service link manually from
  ServiceTrade.

---

## 4. Call-outcome variables (call history)

A `customer_confirmation` call now also carries, when the customer opted in:
| Field | Type | When |
|---|---|---|
| `service_link_requested` | boolean | customer agreed to be emailed the link |
| `service_link_email` | string | the confirmed email (when requested) |

---

## 5. Not in this build
- SMS delivery (email only).
- A per-call "resend" button (resend is done in ServiceTrade for now; a backend
  resend endpoint can be added later).
- The exact ServiceTrade message template is a backend concern (not surfaced).
