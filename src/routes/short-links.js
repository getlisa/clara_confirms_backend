/**
 * GET /c/:code — the redirect behind a masked SMS link.
 *
 * The SMS carries a third-party short URL that points here; this bounces the
 * customer to the real chat page. The indirection is the point: the shortener
 * holds a permanent public record of whatever we hand it, so it gets an opaque
 * code we can revoke rather than the 48-hex chat token, which is the auth
 * credential for that conversation.
 *
 * Public and unauthenticated, exactly like GET /chat-links/:token — the
 * recipient is a customer with no account. The code carries 60 bits of
 * entropy, so it is no more guessable than the token it resolves to.
 */

const express = require("express");
const chatLinksDb = require("../db/chat-links");
const config = require("../config");
const logger = require("../utils/logger");

const router = express.Router();

router.get("/:code", async (req, res) => {
  const { code } = req.params;
  try {
    const link = await chatLinksDb.getByShortCode(code);

    if (!link) {
      // Deliberately not redirected anywhere: an unknown code is either a typo
      // or someone probing, and bouncing it to the app would make the two
      // indistinguishable in the logs.
      logger.info("short-link: unknown code", { code });
      return res.status(404).send("This link is not valid.");
    }

    const expired = link.expires_at && new Date(link.expires_at) < new Date();
    const target = expired
      // Same distinction GET /chat-links/:token already draws between expired
      // and never-existed. Sending them to the app with a marker means they
      // get the real "this link has expired" screen instead of a bare 404.
      ? `${config.frontendUrl}/chat/${encodeURIComponent(link.token)}?expired=1`
      : `${config.frontendUrl}/chat/${encodeURIComponent(link.token)}`;

    logger.info("short-link: resolved", { code, companyId: link.company_id, expired: !!expired });
    // 302, not 301: a permanent redirect would be cached by the handset's
    // browser and by intermediaries, which for a link that expires in 24h and
    // may be revoked is exactly wrong.
    return res.redirect(302, target);
  } catch (err) {
    logger.error("short-link: resolve failed", { code, error: err.message });
    return res.status(500).send("Something went wrong opening this link.");
  }
});

module.exports = router;
