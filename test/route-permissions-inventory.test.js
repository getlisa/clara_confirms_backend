/**
 * Default deny: every user-facing WRITE route must declare a permission
 * (src/auth/permissions.js requirePermission / requireDynamicPermission).
 *
 * With ~75 write endpoints across 25 route files, one forgotten guard is a
 * privilege hole (a Confirmer changing CRM credentials, say). This walks every
 * route module's registered routes, so a new endpoint added without a
 * permission fails the suite.
 *
 * Routes that are not user-authenticated at all are listed explicitly below:
 * they are protected by their own secret (Retell signature / tool secret /
 * CRON_SECRET / ServiceTrade webhook) or by an unguessable public token.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROUTES_DIR = path.join(__dirname, "..", "src", "routes");

// Whole files that are machine-to-machine, never called with a user session.
const SYSTEM_FILES = new Set([
  "admin.js",                 // CRON_SECRET
  "retell.js",                // Retell webhook signature
  "retell-tools.js",          // Retell tool secret
  "servicetrade-webhooks.js", // ServiceTrade webhook receiver
]);

// Individual routes with no user session: the URL token is the credential
// (chat links), or CRON_SECRET is (the Vercel scheduler crons).
const PUBLIC_ROUTES = new Set([
  "chat-links.js POST /:token/footer-click",
  "chat-links.js POST /:token/messages",
  "chat-links.js POST /:token/end",
  "scheduler.js _ALL /run",
  "scheduler.js _ALL /daily",
]);

function writeRoutes(file) {
  const router = require(path.join(ROUTES_DIR, file));
  const out = [];
  for (const layer of router.stack || []) {
    if (!layer.route) continue;
    for (const method of Object.keys(layer.route.methods)) {
      if (method === "get" || method === "head" || method === "options") continue;
      const guards = layer.route.stack.map((l) => l.handle?.permission).filter(Boolean);
      out.push({ id: `${file} ${method.toUpperCase()} ${layer.route.path}`, guards });
    }
  }
  return out;
}

test("every user-facing write route declares a permission", () => {
  const files = fs.readdirSync(ROUTES_DIR).filter((f) => f.endsWith(".js") && !SYSTEM_FILES.has(f));
  const unguarded = [];
  let checked = 0;
  for (const file of files) {
    for (const r of writeRoutes(file)) {
      if (PUBLIC_ROUTES.has(r.id)) continue;
      checked++;
      if (!r.guards.length) unguarded.push(r.id);
    }
  }
  assert.ok(checked > 60, `expected to inspect the full set of write routes, saw ${checked}`);
  assert.deepEqual(unguarded, [], `write routes with no permission:\n  ${unguarded.join("\n  ")}`);
});

test("the explicit public/system exceptions still exist — a stale allowlist hides nothing", () => {
  for (const id of PUBLIC_ROUTES) {
    const [file, method, route] = id.split(" ");
    assert.ok(writeRoutes(file).some((r) => r.id === `${file} ${method} ${route}`), `${id} no longer exists — remove it from PUBLIC_ROUTES`);
  }
  for (const file of SYSTEM_FILES) assert.ok(fs.existsSync(path.join(ROUTES_DIR, file)), `${file} no longer exists`);
});

test("spot checks: the sensitive routes carry the right permission", () => {
  const find = (id) => {
    const [file] = id.split(" ");
    return writeRoutes(file).find((r) => r.id === id)?.guards || [];
  };
  assert.deepEqual(find("agent-settings.js PUT /call-types/:type/prompt"), ["prompt.edit"]);
  assert.deepEqual(find("servicetrade.js POST /credentials"), ["integrations.manage"]);
  assert.deepEqual(find("inspectpoint.js POST /credentials"), ["integrations.manage"]);
  assert.deepEqual(find("users.js POST /invitations"), ["users.manage"]);
  assert.deepEqual(find("company.js PATCH /"), ["company.manage"]);
  assert.deepEqual(find("servicetrade.js POST /sync"), ["sync.run"]);
  assert.deepEqual(find("agent-settings.js PATCH /"), ["agent.voice"]);
  assert.deepEqual(find("jobs.js POST /bulk-send-confirmation"), ["confirmations.send"]);
  assert.deepEqual(find("chat-links.js POST /jobs/:id/send-email"), ["confirmations.send"]);
  assert.deepEqual(find("manual-calls.js POST /"), ["confirmations.send | calls.make"]);
});
