/**
 * Resolve the CORS allow-list from ALLOWED_ORIGINS.
 *
 * Exists because `ALLOWED_ORIGINS=*` silently blocked everything. The value is
 * comma-split into an array, and the `cors` package only treats a BARE STRING
 * "*" as a wildcard — handed the array `["*"]` it does an exact-match lookup for
 * an origin literally named "*", which no browser ever sends. The result was a
 * 204 preflight with no Access-Control-Allow-Origin header at all:
 *
 *   Access to fetch at 'http://localhost:9000/auth/login' from origin
 *   'http://localhost:8083' has been blocked by CORS policy…
 *
 * Returning `true` (reflect the caller's origin) rather than the string "*" is
 * deliberate: the app sets `credentials: true`, and browsers reject
 * `Access-Control-Allow-Origin: *` on a credentialed request. Reflecting is the
 * only form that actually means "any origin" when credentials are in play.
 */

// Origin headers never carry a trailing slash or uppercase scheme/host, but
// hand-written env values and FRONTEND_URL routinely do — an entry like
// "https://app.example.com/" would never match and the failure looks identical
// to not being listed at all.
function normalize(origin) {
  return String(origin).trim().replace(/\/+$/, "").toLowerCase();
}

/**
 * @returns {true|string[]} `true` means reflect any origin; otherwise the
 *   normalized allow-list to hand to `cors({ origin })`.
 */
function resolveAllowedOrigins(envValue, fallbacks = []) {
  const configured = envValue
    ? String(envValue).split(",").map(normalize).filter(Boolean)
    : [];

  const list = configured.length ? configured : fallbacks.map(normalize).filter(Boolean);

  // Any "*" in the list means "no restriction" — honour that as a reflector.
  if (list.includes("*")) return true;
  return [...new Set(list)];
}

module.exports = { resolveAllowedOrigins, normalize };
