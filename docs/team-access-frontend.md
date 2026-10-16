# Team access — invites, roles & permissions — Frontend Guide

> **For the frontend agent.** A company account can now have several people,
> each with their own login and a **role**. Admins invite colleagues by email;
> the invitee sets a password on an accept page and is signed straight in. The
> backend enforces every permission — the UI's job is to hide what a user can't
> do and to handle `403` gracefully.

Base URL: `VITE_API_URL` · Auth: `Authorization: Bearer <token>` unless marked **public**.

---

## 1. Roles

| role | label | who | can |
|---|---|---|---|
| `admin` | Admin | the primary account and anyone promoted | everything |
| `developer` | Developer | operations colleagues | calls, syncs, CSV import, settings, agent voice & name — **not** the prompt, users, CRM credentials, company profile |
| `confirmer` | Confirmer | office staff | read everything, send confirmations (chat links, email, SMS, **confirmation calls**) |

**Owner:** exactly one admin per company has `is_owner: true` (the account
creator). The owner can't be demoted, deactivated or removed; only the owner can
transfer ownership (§6.5). There can be any number of other admins.

---

## 2. Permissions — drive the UI from these, not from the role

Every user object (`/auth/me`, login, refresh, accept) now carries:

```json
{
  "id": 25, "email": "pat@acme.com", "role": "developer", "is_owner": false,
  "permissions": ["data.read","copilot.use","confirmations.send","calls.make","jobs.edit",
                  "settings.edit","sync.run","agent.voice","todos.manage"]
}
```

Check `permissions.includes("…")` to show/hide controls. Don't hard-code role
names in components — the mapping can change without a frontend release.

| permission | admin | developer | confirmer | gates in the UI |
|---|:-:|:-:|:-:|---|
| `data.read` | ✅ | ✅ | ✅ | every page (all `GET`s) |
| `copilot.use` | ✅ | ✅ | ✅ | the copilot chat (its actions are filtered per role, §8) |
| `confirmations.send` | ✅ | ✅ | ✅ | Send chat link / Email / SMS, bulk send confirmation, **Call Now for a confirmation** |
| `calls.make` | ✅ | ✅ | ❌ | Call Now for **non-confirmation** call types (quotation, service opportunity, custom), schedule / run calls, test call |
| `jobs.edit` | ✅ | ✅ | ❌ | create / edit / reschedule jobs, appointments, customers |
| `settings.edit` | ✅ | ✅ | ❌ | call settings, call triggers, analysis, notifications, report recipients, job-type instructions, call-type on/off & rename |
| `sync.run` | ✅ | ✅ | ❌ | Sync now, custom-range sync, CSV import |
| `agent.voice` | ✅ | ✅ | ❌ | agent voice + representative name, "re-sync agent" |
| `todos.manage` | ✅ | ✅ | ❌ | todo status + assignment |
| `prompt.edit` | ✅ | ❌ | ❌ | the prompt editor (save / reset / restore / sync) — view is open to all |
| `agent.manage` | ✅ | ❌ | ❌ | create / delete call types |
| `integrations.manage` | ✅ | ❌ | ❌ | connect / disconnect a CRM, credentials, webhooks |
| `users.manage` | ✅ | ❌ | ❌ | the Team page actions (§6) |
| `company.manage` | ✅ | ❌ | ❌ | company profile, phone number |

**Call Now:** whether a Confirmer may place a call depends on the call type the
trigger resolves to (`customer_confirmation` / `technician_confirmation` →
allowed). Show the button for `scheduled_unconfirmed`, `technician_unconfirmed`,
`open_job_due_soon`, `job_confirmation` to anyone with `confirmations.send`; for
`quotation_pending` and service-opportunity calls require `calls.make`. The
backend makes the final call — handle `403` (§3).

---

## 3. Errors you must handle everywhere

**`403` — not allowed**
```json
{ "error": "You don't have permission to do this", "code": "forbidden", "required": "prompt.edit" }
```
Show a toast like *"Your role doesn't allow this. Ask an admin."* Never retry.

**`401` with `code: "session_revoked"`** — the user's role changed, they were
deactivated/removed, or their password was reset. Their tokens are dead:
```json
{ "error": "Invalid or expired token", "code": "session_revoked" }
```
Try `POST /auth/refresh` once; if that also fails (`401`), clear tokens and send
them to the login page with *"Your access changed — please sign in again."* A
user whose role changed signs back in with the new role.

> Role changes take effect on the user's next request (within ~30 s), not at
> token expiry. After a role change, the affected user's open tabs will start
> getting `401 session_revoked` — that's expected.

---

## 4. Accept-invite page — **new route `/accept-invite?token=…`** (public)

The invite email links here (no longer the reset-password page).

### 4.1 `GET /auth/invitations/:token` — public

```json
{
  "invitation": {
    "email": "pat@acme.com",
    "role": "developer",
    "first_name": "Pat",
    "last_name": null,
    "company_name": "Acme Fire",
    "invited_by_name": "Olive Owner",
    "expires_at": "2026-10-23T17:20:00.000Z"
  }
}
```

| status | code | show |
|---|---|---|
| `404` | `invalid_invitation` | "This invitation link is invalid." |
| `410` | `invitation_expired` | "This invitation has expired — ask your admin to resend it." |
| `410` | `invitation_accepted` | "This invitation was already used." + **Sign in** button |
| `410` | `invitation_revoked` | "This invitation was cancelled." |

Page: *"Olive Owner invited you to join **Acme Fire** as a **Developer**."*
Email shown read-only. Fields: first name (prefilled, required), last name,
password, confirm password (client-side match). Min password length **8**.

### 4.2 `POST /auth/invitations/accept` — public

```json
{ "token": "…", "password": "s3cret-pass", "first_name": "Pat", "last_name": "Lee" }
```

`201`:
```json
{
  "message": "Welcome aboard",
  "token": "<access>",
  "refreshToken": "<refresh>",
  "user": { "id": 31, "email": "pat@acme.com", "first_name": "Pat", "last_name": "Lee", "name": "Pat Lee",
            "role": "developer", "is_owner": false, "company_id": 7, "company_name": "Acme Fire",
            "permissions": ["…"] }
}
```
Store the tokens exactly like a login and go to the dashboard.

Errors: `400 weak_password` · `400 first_name_required` · `404 invalid_invitation`
· `410 invitation_*` · `409 email_in_use` (the email already has an account —
show **Sign in**).

---

## 5. Team page — list (any role can view; actions need `users.manage`)

### `GET /users`

```json
{
  "users": [
    { "id": 1, "email": "olive@acme.com", "first_name": "Olive", "last_name": "Owner", "name": "Olive Owner",
      "role": "admin", "is_owner": true, "active": true,
      "joined_at": null, "created_at": "2026-08-01T10:00:00-05:00", "last_login": "2026-10-16T09:12:00-05:00" }
  ],
  "seats": { "max_users": null, "active_users": 3, "pending_invitations": 1 }
}
```

- Owner first. Badge **Owner** on `is_owner`; show `role` as Admin / Developer / Confirmer.
- **There is no seat limit.** `seats` is informational — e.g. *"3 members · 1
  pending invite"*. `max_users` is always `null` (unlimited); never disable
  **Invite** for capacity.

### `GET /users/invitations` — `users.manage`

```json
{
  "invitations": [
    { "id": 12, "email": "pat@acme.com", "role": "developer", "first_name": "Pat", "last_name": null,
      "status": "pending", "invited_by": 1, "invited_by_name": "Olive Owner",
      "expires_at": "2026-10-23T12:20:00-05:00", "sent_count": 1,
      "last_sent_at": "2026-10-16T12:20:00-05:00", "created_at": "2026-10-16T12:20:00-05:00" }
  ]
}
```
`status` is `pending` or `expired` here. Show expired ones with a **Resend** action.

---

## 6. Team actions — all `users.manage`

### 6.1 Invite — `POST /users/invitations`

```json
{ "email": "pat@acme.com", "role": "developer", "first_name": "Pat", "last_name": "Lee" }
```
`email` and `role` required. `201 { "invitation": { …as §5… } }`. Invitations
expire after **7 days**.

| status | code | message to show |
|---|---|---|
| `400` | `invalid_email` / `invalid_role` | field error |
| `409` | `already_member` | "They're already on your team." |
| `409` | `email_in_use` | "This email already has a Clara Confirms account with another company." (one person = one company) |
| `409` | `invite_pending` | "An invitation is already open — resend it instead." |

> `POST /users/invite` still works for one release (alias; old role `user` maps
> to `developer`). Switch to `POST /users/invitations`.

### 6.2 Resend — `POST /users/invitations/:id/resend`

New link, fresh 7-day expiry (the old link stops working). `200 { invitation }`.
`429 resend_cooldown` (wait a minute) · `429 resend_limit` (10 sends — revoke and
re-invite) · `409 not_open` · `404`.

### 6.3 Revoke — `DELETE /users/invitations/:id`

`200 { "message": "Invitation revoked" }` · `404 not_found`.

### 6.4 Change role / deactivate — `PATCH /users/:id`

```json
{ "role": "confirmer" }        // and/or
{ "active": false }
```
`200 { user }`. The member's sessions end on their next request (§3).

| `400` code | when | UI |
|---|---|---|
| `self_role_change` | changing your own role | hide the role picker on your own row |
| `self_deactivate` | deactivating yourself | hide on your own row |
| `owner_protected` | demoting / deactivating the owner | disable on the owner's row: "Transfer ownership first" |
| `no_updates` | empty body | — |

### 6.5 Transfer ownership — `POST /users/transfer-ownership` (owner only)

```json
{ "user_id": 2 }
```
Only when `me.is_owner`. Target must be an **active Admin** (`400 not_admin`
otherwise — "Promote them to Admin first"). `200 { message, users }` — re-render
the list from `users`. `403 owner_only` if the caller isn't the owner. Confirm
first: *"Make Dana the account owner? You'll stay an Admin."*

### 6.6 Remove — `DELETE /users/:id`

`200 { "message": "User removed" }`. `400 owner_protected` / `400 self_remove`.
Confirm first. A removed person can be invited again later (their old account is
restored with the new role).

### 6.7 Activity — `GET /users/audit-log?limit=50&offset=0`

```json
{ "entries": [ { "id": 88, "action": "user.role_changed", "target_type": "user", "target_id": "2",
  "metadata": { "from": "developer", "to": "admin" }, "actor_user_id": 1, "actor_name": "Olive Owner",
  "actor_email": "olive@acme.com", "created_at": "2026-10-16T12:30:00-05:00" } ] }
```
Actions: `user.invited` `user.invite_resent` `user.invite_revoked` `user.joined`
`user.role_changed` `user.deactivated` `user.reactivated` `user.removed`
`owner.transferred`. Optional "Activity" tab on the Team page.

---

## 7. Screens to gate (summary)

| screen / control | needs |
|---|---|
| Team page actions (invite, role, remove, resend, revoke) | `users.manage` |
| Transfer ownership | `is_owner` |
| Prompt editor Save / Reset / Restore / Retry sync | `prompt.edit` (others see it read-only) |
| CRM connect / disconnect / credentials | `integrations.manage` |
| Sync now, custom-range sync, CSV import | `sync.run` |
| Agent voice & name | `agent.voice` |
| Create / delete call type | `agent.manage` |
| Call settings, triggers, notifications, reports, job-type instructions | `settings.edit` |
| Company profile / phone number | `company.manage` |
| Job / appointment / customer edits | `jobs.edit` |
| Send chat link, email, SMS, bulk confirm, confirmation Call Now | `confirmations.send` |
| Other Call Now / schedule call / run scheduler | `calls.make` |
| Todo status / assign | `todos.manage` |

Read-only users still see every page — disable or hide the controls, don't hide
the data.

---

## 8. Copilot

The copilot only offers each user the actions their role allows, and refuses at
run time otherwise. A Confirmer asking it to change settings gets a polite
refusal in the chat — no UI work needed beyond rendering the reply.

---

## 9. Don'ts

- Don't gate on `role === "admin"` — use `permissions`.
- Don't keep the old invite flow on `/reset-password?invite=true`; new invites link to `/accept-invite`.
- Don't assume one user per company anywhere (owner badge, "assigned to" pickers, report recipients).
- Don't swallow `401 session_revoked` as a generic error — it means "sign in again".
