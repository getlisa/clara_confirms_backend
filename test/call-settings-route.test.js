/**
 * PATCH /call-settings only writes fields it explicitly destructures — a column
 * the DB layer supports but the route forgets is silently dropped, and a body
 * containing only that field comes back "No fields to update". That is how
 * job_confirmation_inference_enabled (migration 083) shipped unsettable.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

const { stub, silentLogger } = require("./helpers/stub-modules");
stub("utils/logger", silentLogger());
stub("db", { query: async () => ({ rows: [], rowCount: 0 }) });
stub("services/retell", {});
stub("auth", {
  authenticate: (req, _res, next) => { req.user = { userId: 1, companyId: 16, role: "admin" }; next(); },
  getCompanyId: (req) => req.user.companyId,
});
stub("utils/timezone", { getCompanyTimezone: async () => "America/Chicago", localizeFields: (o) => o });
const upserts = [];
stub("db/call-settings", {
  getByCompanyId: async () => ({}),
  upsert: async (_companyId, fields) => { upserts.push(fields); return { ...fields }; },
});
stub("services/retell-tools", { maybeResyncToolsAfterSettingsChange: async () => ({ status: "skipped" }) });

const app = express();
app.use(express.json());
app.use("/call-settings", require("../src/routes/call-settings"));

async function patch(body) {
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/call-settings`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return [res.status, await res.json()];
  } finally {
    server.close();
  }
}

test.beforeEach(() => { upserts.length = 0; });

test("job_confirmation_inference_enabled on its own is saved, not 'No fields to update'", async () => {
  const [status, body] = await patch({ job_confirmation_inference_enabled: true });
  assert.equal(status, 200);
  assert.deepEqual(upserts, [{ job_confirmation_inference_enabled: true }]);
  assert.equal(body.call_settings.job_confirmation_inference_enabled, true);
});

test("job_confirmation_inference_enabled can be turned off again", async () => {
  const [status] = await patch({ job_confirmation_inference_enabled: false });
  assert.equal(status, 200);
  assert.deepEqual(upserts, [{ job_confirmation_inference_enabled: false }]);
});

test("a non-boolean is rejected rather than coerced", async () => {
  const [status, body] = await patch({ job_confirmation_inference_enabled: "yes" });
  assert.equal(status, 400);
  assert.match(body.error, /must be a boolean/);
  assert.equal(upserts.length, 0);
});

test("every opt-in flag the DB layer accepts is writable through the route (except the one with its own route)", () => {
  const src = require("node:fs").readFileSync(require.resolve("../src/db/call-settings.js"), "utf8");
  const route = require("node:fs").readFileSync(require.resolve("../src/routes/call-settings.js"), "utf8");
  const allowed = [...src.slice(src.indexOf("const allowed = [")).split("];")[0].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  const ownRoute = new Set(["call_notification_enabled"]); // written only via PATCH /call-notifications
  const missing = allowed.filter((f) => !ownRoute.has(f) && !new RegExp(`\\b${f}\\s*!== undefined`).test(route));
  assert.deepEqual(missing, [], `fields the DB accepts but PATCH /call-settings silently drops: ${missing.join(", ")}`);
});
