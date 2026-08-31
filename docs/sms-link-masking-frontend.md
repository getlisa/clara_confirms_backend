# SMS Link Masking — Frontend Guide

> **NO FRONTEND CHANGE IS REQUIRED.** This shipped entirely in the backend and
> is already working. Read on only if you want the small optional polish in §1.
>
> There is genuinely nothing to do. The SMS now carries a short link that
> redirects to the same `/chat/<token>` URL the app already serves, so the app
> cannot tell the difference.

---

## 0. Why

A confirmation SMS carrying `https://confirms.justclara.ai/chat/<token>` came
back **undelivered — Twilio 30007, "Carrier violation"**. Controlled tests
showed the same sentence delivered fine with no URL, and delivered fine with a
`youtube.com` URL — the carrier was filtering *our domain* by reputation.

SMS now carries a short link instead. Email is **unchanged** and still shows the
full URL — there is no carrier filter on email, and a visible domain is what
makes the mail look trustworthy.

## 2. What has NOT changed

- `GET /chat-links/:token` — same request, same response, same 404/410 split.
- The redirect target — still `/chat/<48-hex-token>`, reached in one hop.
- The chat URL format itself — still `/chat/<48-hex-token>`.
- Email bodies — still the full URL.
- Nothing about the chat UI, the SSE stream, or message posting.

---

## Appendix — operational notes (not frontend work)

Recorded here because they affect whether the masked link behaves well.

**Masking is a toggle.** `SMS_LINK_MASKING=false` reverts to the plain URL
instantly, with no deploy, if a shortener domain ever gets filtered itself.

**Still open, and more serious:** there is no Twilio `statusCallback`, so a
blocked SMS is reported as `sent: true` and raises no todo. The send that
started all of this looked successful to the platform. Masking reduces how
often that happens; it does not make it visible.
