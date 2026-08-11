# SMS Link Masking — Frontend Guide

> **NO FRONTEND CHANGE IS REQUIRED.** This shipped entirely in the backend and
> is already working. Read on only if you want the small optional polish in §1.
>
> The one thing you *could* do is honour a `?expired=1` query parameter on the
> chat URL. Ignoring it changes nothing: `GET /chat-links/:token` still returns
> `410 { code: "link_expired" }` exactly as it always has, and links have always
> expired after 24h, so the app's existing handling already covers it.

---

## 0. Why

A confirmation SMS carrying `https://confirms.justclara.ai/chat/<token>` came
back **undelivered — Twilio 30007, "Carrier violation"**. Controlled tests
showed the same sentence delivered fine with no URL, and delivered fine with a
`youtube.com` URL — the carrier was filtering *our domain* by reputation.

SMS now carries a short link instead. Email is **unchanged** and still shows the
full URL — there is no carrier filter on email, and a visible domain is what
makes the mail look trustworthy.

## 1. Optional polish: `?expired=1`

Masked SMS links point at `GET /c/<code>` on the API, which 302-redirects to the
normal chat URL. When the underlying link has expired (24h TTL) the redirect
adds a marker:

```
https://confirms.justclara.ai/chat/<token>?expired=1
```

The app should show its existing "this link has expired" state when that
parameter is present, without waiting for `GET /chat-links/:token` to return
410. Two reasons: the screen paints immediately instead of after a round trip,
and it is unambiguous.

If you ignore the parameter nothing breaks — `GET /chat-links/:token` still
returns `410 link_expired` as it always has, so this is an enhancement, not a
requirement.

## 2. What has NOT changed

- `GET /chat-links/:token` — same request, same response, same 404/410 split.
- The chat URL format itself — still `/chat/<48-hex-token>`.
- Email bodies — still the full URL.
- Nothing about the chat UI, the SSE stream, or message posting.

## 3. Checklist

Nothing is required. If you want the polish:

- [ ] Read `?expired=1` on the chat route and render the existing expired state
      immediately, instead of waiting for the 410.
- [ ] Strip the parameter from the displayed URL if you tidy the address bar.

---

## Appendix — operational notes (not frontend work)

Recorded here because they affect whether the masked link behaves well.

**Serve `/c/` from a custom domain, not `*.vercel.app`.** Measured: TinyURL
returns a clean `301` straight to `confirms.justclara.ai`, but for a
`clara-confirms-backend.vercel.app` destination it inserts
`redirect.viglink.com` — an affiliate/monetisation hop. That adds a third party
between the customer and their confirmation, plus an extra redirect and a
tracking cookie. Point `PUBLIC_API_URL` at a `justclara.ai` domain and the hop
disappears.

**Masking is a toggle.** `SMS_LINK_MASKING=false` reverts to the plain URL
instantly, with no deploy, if a shortener domain ever gets filtered itself.

**Still open, and more serious:** there is no Twilio `statusCallback`, so a
blocked SMS is reported as `sent: true` and raises no todo. The send that
started all of this looked successful to the platform. Masking reduces how
often that happens; it does not make it visible.
