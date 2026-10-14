# ServiceTrade — always-connected login — Frontend Guide

> **For the frontend agent.** ServiceTrade logins no longer expire. The backend
> now stores the ServiceTrade password (encrypted) when the user connects, and
> logs back in by itself whenever ServiceTrade ends the session. This doc
> covers the new fields on the connection endpoints and the one screen state
> the user still has to act on.

Base URL: `VITE_API_URL` · Auth: `Authorization: Bearer <token>` on every endpoint.
Base path: `/integrations/servicetrade`.

---

## 1. What changed for the user

| before | now |
|---|---|
| ServiceTrade sessions died after an unpredictable time; syncing stopped silently until someone noticed and reconnected | the backend renews the session automatically — the connection stays live indefinitely |
| "Session expired" was the normal failure | the only remaining failure is **the ServiceTrade password was changed** (or the ServiceTrade user was disabled). Then the user must reconnect once with the new password |
| — | connections made **before** this release have no stored password, so each company must **reconnect once** to turn auto-renewal on |

Nothing changes in the connect form itself: same username + password fields.

---

## 2. Connect — `POST /integrations/servicetrade/credentials` (existing, one new field)

Request (unchanged)
```json
{ "username": "ops@acme.com", "password": "••••••••", "metadata": { } }
```

Response `200`
```json
{
  "connected": true,
  "user": { "id": 9123, "firstName": "Ops", "lastName": "Manager", "email": "ops@acme.com" },
  "auto_reconnect": true,
  "message": "Connected to ServiceTrade"
}
```

| field | meaning |
|---|---|
| `auto_reconnect` | `true` = the password was stored and the session will renew itself. `false` = connected, but the server could not store the password (a server configuration problem, not the user's fault) — the connection will work until ServiceTrade ends the session. Show a quiet warning: *"Connected, but automatic reconnection is unavailable. Contact support."* |

Errors (unchanged)
```json
// 400
{ "error": "Username and password are required" }
// 403
{ "connected": false, "error": "Invalid ServiceTrade credentials" }
// 500
{ "error": "Failed to save credentials" }
```

Copy for the form: *"We store your ServiceTrade password encrypted so your
connection never expires. It is never shown or shared."*

---

## 3. Status — `GET /integrations/servicetrade/status` (existing, new fields)

If the session has expired, the backend renews it **before** answering, so a
normal status call returns `connected: true` even when ServiceTrade had ended
the session a moment ago. Poll it exactly as today (page load, after connect).

### 3.1 Connected

```json
{
  "connected": true,
  "hasCredentials": true,
  "user": { "id": 9123, "firstName": "Ops", "lastName": "Manager", "email": "ops@acme.com" },
  "auto_reconnect": true,
  "last_login_at": "2026-10-15T09:12:44.000Z",
  "needs_reconnect": false,
  "sync": {
    "syncing": false,
    "currentState": null,
    "runId": null,
    "startedAt": null,
    "lastSyncAt": "2026-10-15T10:00:01.000Z",
    "lastSyncStatus": "success",
    "lastSyncError": null,
    "lastRunAbandoned": false
  }
}
```

### 3.2 Needs the user — `needs_reconnect: true`

```json
{
  "connected": false,
  "hasCredentials": false,
  "auto_reconnect": true,
  "needs_reconnect": true,
  "auth_error": "ServiceTrade rejected the saved login (was the password changed?). Reconnect ServiceTrade.",
  "auth_error_at": "2026-10-15T08:00:03.000Z",
  "message": "ServiceTrade rejected the saved login (was the password changed?). Reconnect ServiceTrade."
}
```

The two `auth_error` texts you will see:

| `auto_reconnect` | `auth_error` | what happened | UI copy |
|---|---|---|---|
| `true` | "ServiceTrade rejected the saved login (was the password changed?)…" | password changed / user disabled in ServiceTrade | *"ServiceTrade rejected your saved login — the password may have changed. Reconnect to resume syncing."* |
| `false` | "ServiceTrade session expired and no password is stored to renew it…" | connected before auto-renewal existed | *"Reconnect ServiceTrade once to keep it connected permanently."* |

`auth_error` can also be `null` with `needs_reconnect: true` (session expired
and no renewal was possible yet, e.g. ServiceTrade briefly unreachable) — show
the generic `message`.

### 3.3 Never connected (unchanged)

```json
{
  "connected": false,
  "hasCredentials": false,
  "message": "No ServiceTrade connection. Connect with username and password."
}
```

### 3.4 Field reference

| field | type | notes |
|---|---|---|
| `connected` | boolean | the session works right now |
| `auto_reconnect` | boolean | password is stored; the session renews itself |
| `needs_reconnect` | boolean | **drive the UI off this** — `true` ⇒ show the reconnect banner (§4) |
| `last_login_at` | ISO string \| null | last time we logged in to ServiceTrade (connect or automatic renewal). Optional "Connection renewed …" caption; do not alarm on frequent renewals, that is normal |
| `auth_error` / `auth_error_at` | string \| null | why it could not be renewed / since when |
| `sync.lastSyncStatus` | `"success"` \| `"partial"` \| `"failed"` \| null | `"partial"` = some entities did not finish and will be retried next run (it is a valid value — handle it) |

---

## 4. The reconnect banner

Show when `needs_reconnect === true`, on the Integrations page **and** as a
global app banner (customer data stops updating while it is shown, so it should
be hard to miss):

> ⚠️ **ServiceTrade is disconnected.** {copy from §3.2}  **[Reconnect]**

**[Reconnect]** opens the existing connect form (username prefilled if you have
it, password empty) → `POST /credentials` (§2). On `200` hide the banner and
re-poll `/status`.

Also show it — once, dismissible — for companies whose status is
`connected: true` but `auto_reconnect: false` (connected before this release):

> ℹ️ **Keep ServiceTrade connected permanently.** Reconnect once to enable
> automatic renewal.  **[Reconnect]**

---

## 5. Manual renew — `POST /integrations/servicetrade/login` (existing route, new behaviour)

Previously this always returned `400` ("Password is not stored"). It now
renews the session immediately from the stored password. The backend already
does this automatically, so you normally never call it; it is useful behind a
**"Test connection"** button.

```json
// 200
{ "connected": true, "auto_reconnect": true, "message": "ServiceTrade session renewed" }

// 409 — could not renew; the user must reconnect (show §4)
{ "connected": false, "needs_reconnect": true, "error": "ServiceTrade rejected the saved login (was the password changed?). Reconnect ServiceTrade." }

// 502 — ServiceTrade unreachable; try again later
{ "connected": false, "error": "ServiceTrade request failed" }
```

No request body.

---

## 6. Disconnect — `DELETE /integrations/servicetrade/session` (unchanged)

`204`. Also deletes the stored password. Confirm first: *"Disconnect
ServiceTrade? Syncing stops and your saved login is deleted."*

---

## 7. Don'ts

- Don't show "session expired" as a normal state any more — with
  `auto_reconnect: true` it only happens when the password changed.
- Don't ask users to reconnect periodically "to keep it alive".
- Don't display, prefill or cache the password anywhere client-side.
- Don't treat `lastSyncStatus: "partial"` as an error banner — it retries on
  its own; only `needs_reconnect` needs the user.
