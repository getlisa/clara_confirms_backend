# Apply Channel Strategy to All Customers — Frontend Guide

> **For the frontend agent.** No backend change was needed. The endpoint already
> exists and is fast; what's missing is the frontend calling it once instead of
> looping, and showing a toast when it returns.

Base URL: `VITE_API_URL` · Auth: `Authorization: Bearer <token>`

---

## 0. The short version

**It does not need to run in the background.** Measured against the largest real
company — **2,249 customers — the whole operation takes 432ms**, because it is a
single `UPDATE`, not a per-customer write:

```sql
UPDATE customers SET is_voice = $2, is_sms = $3, is_email = $4, updated_at = NOW()
 WHERE company_id = $1 AND NOT (is_voice = $2 AND is_sms = $3 AND is_email = $4)
```

So: fire it, let the user keep navigating, toast on the response. A job queue,
progress stream or polling loop would add moving parts and make the toast arrive
*later* than the request already resolves.

**If it currently feels slow, the cause is almost certainly the old client-side
loop.** `POST /customers/bulk-apply-channel-strategy` was added specifically to
replace `handleApplyStrategyToCustomers`, which `PATCH`ed every customer one at a
time. On a 2,249-customer account that's 2,249 sequential round trips — minutes,
not milliseconds. Check whether that loop is still what runs.

---

## 1. The endpoint

```
POST /customers/bulk-apply-channel-strategy
```

**No request body.** The target flags are derived server-side from the company's
own `call_settings.channel_strategy` + `chat_link_delivery_method`, so the
frontend cannot send flags that disagree with what dispatch actually honours.

```json
// → 200
{ "scanned": 2249, "updated": 2249, "skipped": 0 }
```

| field | meaning |
|---|---|
| `scanned` | customers the company has |
| `updated` | rows whose flags actually changed |
| `skipped` | already matched the target — `scanned - updated` |

Errors: `403` (no company context), `500` (`{"error": "Failed to apply channel strategy to customers"}`).

---

## 2. The pattern

```tsx
async function applyToAllCustomers() {
  setApplying(true);                       // label the button, don't block the page
  try {
    const r = await applyChannelStrategyToCustomers(token!);   // ~0.4s worst case
    toast.success(
      r.updated === 0
        ? `All ${r.scanned} customers already use this channel setup.`
        : `Channel setup applied to ${r.updated} of ${r.scanned} customers.`
    );
    refetchCustomers();                    // flags are visible in the list
  } catch {
    toast.error("Couldn't apply the channel setup. Nothing was changed — try again.");
  } finally {
    setApplying(false);
  }
}
```

Three things that matter more than the mechanism:

- **Don't block navigation.** No modal overlay, no route guard. A busy label on
  the button is enough.
- **Don't `await` it inside a route transition.** If the user navigates during a
  full page load the request is cancelled client-side — but the `UPDATE` is a
  single statement in one transaction, so it either applied or it didn't. There
  is no half-applied state to repair.
- **Distinguish "nothing to do" from "done".** `updated: 0` means every customer
  already matched. Reporting "applied to 0 customers" reads like a failure.

---

## 3. Two things to warn the user about

**It overwrites per-customer customisation.** Every customer's
`is_voice`/`is_sms`/`is_email` is overwritten unconditionally, *including*
customers individually adjusted via the confirmation-recipients checklist. That
is deliberate — the per-customer picker chooses *who* is contacted, not the
company's long-term channel strategy — but it is destructive, so confirm before
firing:

> "This replaces the channel setup for all N customers, including any you've
> customised individually. Continue?"

Use `scanned` from a prior call, or the customer count you already display, for N.

**SMS flags do nothing until SMS is approved.** `is_sms` is gated by
`companies.sms_status`, an ops-controlled A2P flag. While it is
`not_configured` or `pending_approval`, dispatch ignores `is_sms` entirely and
falls back to voice. So applying an SMS-bearing strategy can appear to do
nothing. If `sms_status !== 'live'`, say so next to the control rather than
letting the user conclude the apply failed.

---

## 4. What the strategy maps to

Derived server-side by `channelStrategyToFlags`. All 12 combinations are
verified to leave at least one channel enabled, so the
`customers_channel_at_least_one` constraint can never reject the update.

| `channel_strategy` | delivery `email` | `sms` | `both` |
|---|---|---|---|
| `voice_only` | voice + email | voice | voice + email |
| `sms_only` | sms + email | sms | sms + email |
| `voice_then_sms_fallback` | voice + sms + email | voice + sms | voice + sms + email |
| `web_chat_only` | email | sms | sms + email |

---

## 5. When a background job WOULD be warranted

Not now. The threshold is roughly where the single `UPDATE` exceeds a request
timeout — extrapolating from 432ms for 2,249 rows, somewhere around
**hundreds of thousands of customers**, or if the operation ever grows a
per-customer side effect (an API call or an email per row). At that point the
right shape is an `engine_runs` job with the existing SSE stream
(`workflow-engine-frontend.md`), not polling. Until then, one call and a toast.

---

## 6. Checklist

- [ ] Remove/replace the per-customer `PATCH` loop (`handleApplyStrategyToCustomers`) if still present.
- [ ] Call `POST /customers/bulk-apply-channel-strategy` once, no body.
- [ ] Busy label on the button; page stays navigable, no blocking overlay.
- [ ] Toast from `{scanned, updated, skipped}`, with a distinct message for `updated === 0`.
- [ ] Confirmation dialog first — this overwrites individually customised customers.
- [ ] Show an SMS-not-approved note when `sms_status !== 'live'`.
- [ ] Refetch the customer list after success so the flags shown are current.
