/**
 * routes/imports.js — upload, preview, list, reprocess.
 *
 * Handlers are invoked directly off `router.stack` with a hand-rolled req/res,
 * the house pattern for route tests (see
 * test/retell-tools-reschedule-slots-routes.test.js's header).
 *
 * The upload route takes the file as a RAW body rather than multipart — no
 * multer dependency, binary .xlsx without base64 inflation, and it matches how
 * routes/retell.js already receives its webhook payload. These tests therefore
 * hand the handler a Buffer as `req.body`, which is what `express.raw` would
 * have produced.
 */

process.env.TZ = "Asia/Kolkata";

const test = require("node:test");
const assert = require("node:assert/strict");

const { stub, silentLogger } = require("./helpers/stub-modules");
stub("utils/logger", silentLogger());
stub("db", { query: async () => ({ rows: [] }) });

stub("auth/auth.middleware", { authenticate: (req, _res, next) => next() });

stub("utils/timezone", {
  getCompanyTimezone: async () => "America/New_York",
  localToUTC: (s) => new Date(`${s.replace(/Z$/, "")}Z`).toISOString(),
  toLocalDateOnly: (iso) => String(iso).slice(0, 10),
});

let nextId = 1;
const created = [];
const stored = new Map();
const rowReads = [];
const mappingSaves = [];
let savedMapping = null;
stub("db/csv-imports", {
  create: async (args) => {
    const rec = { id: String(nextId++), status: "pending", contentAvailable: true, errorRows: 0, ...args };
    created.push(args);
    stored.set(rec.id, rec);
    return rec;
  },
  getById: async (id, companyId) => {
    const rec = stored.get(String(id));
    return rec && rec.companyId === companyId ? rec : null;
  },
  listByCompany: async () => [...stored.values()],
  listRows: async (id, companyId, opts) => { rowReads.push({ id, companyId, opts }); return [{ rowNumber: 3, error: "bad phone", payload: { Phone: "n/a" } }]; },
  markRunning: async () => {}, markCompleted: async () => {}, markFailed: async () => {},
  getSavedMapping: async () => savedMapping,
  saveMapping: async (companyId, mapping, opts) => { mappingSaves.push({ companyId, mapping, opts }); return { mapping }; },
  CONTENT_RETENTION_DAYS: 30,
});

const engineStarts = [];
stub("engines/csv-import", {
  start: async (opts) => { engineStarts.push(opts); return { id: 99, kind: "csv_import" }; },
});
stub("engines/core/token", { sign: () => "signed-token" });

const router = require("../src/routes/imports");

// ── Harness ─────────────────────────────────────────────────────────────────

function handlerFor(method, path) {
  const layer = router.stack.find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`no ${method.toUpperCase()} ${path}`);
  return layer.route.stack.at(-1).handle;
}

function makeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

const req = (over = {}) => ({ user: { companyId: 7, userId: 55 }, query: {}, params: {}, body: undefined, ...over });

const GOOD = Buffer.from("Work Order,Customer,Phone,Scheduled\nWO-1,Acme,5551234567,2026-03-04 14:00\n");

function reset() {
  created.length = 0; engineStarts.length = 0; rowReads.length = 0;
  mappingSaves.length = 0; savedMapping = null; stored.clear(); nextId = 1;
}

// ── Upload ──────────────────────────────────────────────────────────────────

test("a good upload stores the file, starts the engine and returns the standard stream envelope", async () => {
  reset();
  const res = makeRes();
  await handlerFor("post", "/csv")(req({ query: { filename: "jobs.csv" }, body: GOOD }), res);

  assert.equal(res.statusCode, 202);
  assert.equal(res.body.preview.usableRows, 1);
  assert.deepEqual(Object.keys(res.body).sort().filter((k) => ["runId", "streamToken", "streamUrl", "snapshotUrl", "kind"].includes(k)).length, 5);
  assert.equal(engineStarts[0].companyId, 7);
  assert.equal(created[0].filename, "jobs.csv");
});

test("startedBy uses req.user.userId — the `req.user.id` other routes use is always undefined", async () => {
  reset();
  await handlerFor("post", "/csv")(req({ query: { filename: "jobs.csv" }, body: GOOD }), makeRes());
  assert.equal(engineStarts[0].startedBy, 55, "authenticate sets userId, never id");
  assert.equal(created[0].uploadedBy, 55);
});

test("dryRun stores the file and returns the preview WITHOUT starting an import", async () => {
  reset();
  const res = makeRes();
  await handlerFor("post", "/csv")(req({ query: { filename: "jobs.csv", dryRun: "true" }, body: GOOD }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.dryRun, true);
  assert.equal(res.body.preview.usableRows, 1);
  assert.equal(engineStarts.length, 0, "a dry run must not write any platform rows");
  assert.equal(created.length, 1, "but the file is still stored, so it can be processed later");
});

test("a file missing a required column is refused with 422 BEFORE anything is stored", async () => {
  reset();
  const res = makeRes();
  const noRef = Buffer.from("Customer,Phone,Scheduled\nAcme,5551234567,2026-03-04\n");
  await handlerFor("post", "/csv")(req({ query: { filename: "jobs.csv" }, body: noRef }), res);

  assert.equal(res.statusCode, 422);
  assert.match(res.body.error, /work order \/ reference number/);
  assert.equal(created.length, 0, "an unreadable file must not leave a row behind");
  assert.equal(engineStarts.length, 0);
});

test("an ambiguous date file is refused, and re-uploading with dateOrder resolves it", async () => {
  reset();
  const ambiguous = Buffer.from("Work Order,Customer,Phone,Scheduled\nWO-1,Acme,5551234567,03/04/2026\n");
  const refused = makeRes();
  await handlerFor("post", "/csv")(req({ query: { filename: "j.csv" }, body: ambiguous }), refused);
  assert.equal(refused.statusCode, 422);
  assert.match(refused.body.error, /can't tell which you meant/i);

  const accepted = makeRes();
  await handlerFor("post", "/csv")(req({ query: { filename: "j.csv", dateOrder: "MDY" }, body: ambiguous }), accepted);
  assert.equal(accepted.statusCode, 202);
  assert.equal(engineStarts.at(-1).dateOrder, "MDY");
});

test("a missing filename or an empty body is a 400 — the filename decides which parser runs", async () => {
  reset();
  const noName = makeRes();
  await handlerFor("post", "/csv")(req({ query: {}, body: GOOD }), noName);
  assert.equal(noName.statusCode, 400);

  const noBody = makeRes();
  await handlerFor("post", "/csv")(req({ query: { filename: "j.csv" }, body: Buffer.alloc(0) }), noBody);
  assert.equal(noBody.statusCode, 400);
});

// ── Column mapping ──────────────────────────────────────────────────────────

/** Headers from a real customer export that alias matching cannot resolve. */
const UNMAPPABLE = Buffer.from(
  "Appointment Ref,Client Company,Contact Mobile,Visit Day\n" +
  "APT-1,Northgate Retail,5559876543,2026-10-14\n"
);

test("a file whose columns can't be matched returns everything the mapping UI needs, in one response", async () => {
  reset();
  const res = makeRes();
  await handlerFor("post", "/csv")(req({ query: { filename: "real.csv" }, body: UNMAPPABLE }), res);

  assert.equal(res.statusCode, 422);
  assert.equal(res.body.mappingRequired, true, "so the UI opens a mapping step instead of a dead-end error");
  assert.deepEqual(res.body.headers, ["Appointment Ref", "Client Company", "Contact Mobile", "Visit Day"]);
  assert.ok(res.body.targetFields.length, "the fields a column can be dropped onto");
  assert.ok(res.body.targetFields[0].columns.length, "each with its columns ranked for the dropdown");
  assert.equal(res.body.suggestedMapping.reference, "Appointment Ref", "pre-filled with our best guesses");
  assert.equal(res.body.suggestedMapping.phone, "Contact Mobile");
  assert.equal(created.length, 0, "nothing stored — the user hasn't confirmed anything yet");
});

test("supplying the mapping imports the same file, and remembers it for next time", async () => {
  reset();
  const mapping = { reference: "Appointment Ref", customerName: "Client Company", phone: "Contact Mobile", scheduledDate: "Visit Day" };
  const res = makeRes();
  await handlerFor("post", "/csv")(
    req({ query: { filename: "real.csv", mapping: JSON.stringify(mapping) }, body: UNMAPPABLE }), res
  );

  assert.equal(res.statusCode, 202);
  assert.equal(res.body.preview.usableRows, 1);
  assert.deepEqual(created[0].columnMapping, mapping, "the mapping used is recorded on the import itself");
  assert.deepEqual(mappingSaves[0].mapping, mapping, "and saved as the company default");
});

test("a remembered mapping is applied automatically, so a recurring export needs mapping only once", async () => {
  reset();
  savedMapping = { mapping: { reference: "Appointment Ref", customerName: "Client Company", phone: "Contact Mobile", scheduledDate: "Visit Day" } };

  const res = makeRes();
  await handlerFor("post", "/csv")(req({ query: { filename: "real.csv" }, body: UNMAPPABLE }), res);

  assert.equal(res.statusCode, 202, "no mapping step the second time");
  assert.equal(res.body.preview.usableRows, 1);
  assert.equal(mappingSaves.length, 0, "an auto-applied mapping is not re-saved as though newly confirmed");
});

test("a malformed mapping param is rejected rather than silently ignored", async () => {
  reset();
  for (const bad of ["not json", "[1,2]", '"a string"']) {
    const res = makeRes();
    await handlerFor("post", "/csv")(req({ query: { filename: "j.csv", mapping: bad }, body: GOOD }), res);
    assert.equal(res.statusCode, 400, `${bad} should be a 400`);
  }
  assert.equal(created.length, 0, "dropping a mapping the user drew would import the wrong columns");
});

test("the saved mapping can be read and written directly, for a Settings screen", async () => {
  reset();
  const get = makeRes();
  await handlerFor("get", "/csv/mapping")(req(), get);
  assert.deepEqual(get.body.mapping, {});
  assert.ok(get.body.targetFields.length, "the field catalogue renders before any file is chosen");

  const put = makeRes();
  await handlerFor("put", "/csv/mapping")(req({ body: { mapping: { phone: "Contact Mobile" }, sourceHeaders: ["Contact Mobile"] } }), put);
  assert.deepEqual(mappingSaves[0].mapping, { phone: "Contact Mobile" });

  const bad = makeRes();
  await handlerFor("put", "/csv/mapping")(req({ body: { mapping: "nope" } }), bad);
  assert.equal(bad.statusCode, 400);
});

// ── Read + reprocess ────────────────────────────────────────────────────────

test("fetching another company's import 404s rather than leaking it", async () => {
  reset();
  await handlerFor("post", "/csv")(req({ query: { filename: "j.csv" }, body: GOOD }), makeRes());

  const res = makeRes();
  await handlerFor("get", "/csv/:id")(req({ params: { id: "1" }, user: { companyId: 999, userId: 1 } }), res);
  assert.equal(res.statusCode, 404);
});

test("reprocess re-runs from the stored file and takes companyId from the record, never the body", async () => {
  reset();
  await handlerFor("post", "/csv")(req({ query: { filename: "j.csv" }, body: GOOD }), makeRes());
  engineStarts.length = 0;

  const res = makeRes();
  // A hostile body tries to redirect the run at another tenant.
  await handlerFor("post", "/csv/:id/reprocess")(req({ params: { id: "1" }, body: { companyId: 999, dateOrder: "DMY" } }), res);

  assert.equal(res.statusCode, 202);
  assert.equal(engineStarts[0].companyId, 7, "companyId must come from the authenticated user, not the body");
  assert.equal(engineStarts[0].dateOrder, "DMY");
});

test("the uploader's identity is recorded, including a denormalised email that survives the user being deleted", async () => {
  reset();
  await handlerFor("post", "/csv")(
    req({ query: { filename: "j.csv" }, body: GOOD, user: { companyId: 7, userId: 55, email: "ops@acme.test" } }),
    makeRes()
  );
  assert.equal(created[0].uploadedBy, 55);
  assert.equal(created[0].uploadedByEmail, "ops@acme.test", "the FK is ON DELETE SET NULL, so the archive needs its own copy");
});

test("the raw rows endpoint backs the error report — it can return failed rows only", async () => {
  reset();
  await handlerFor("post", "/csv")(req({ query: { filename: "j.csv" }, body: GOOD }), makeRes());

  const res = makeRes();
  await handlerFor("get", "/csv/:id/rows")(req({ params: { id: "1" }, query: { onlyErrors: "true" } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(rowReads[0].opts.onlyErrors, true);
  assert.equal(res.body.contentAvailable, true);
  assert.equal(res.body.rows[0].payload.Phone, "n/a", "the original cells come back for the report");
});

test("raw rows for another company's import 404 rather than leaking", async () => {
  reset();
  await handlerFor("post", "/csv")(req({ query: { filename: "j.csv" }, body: GOOD }), makeRes());
  const res = makeRes();
  await handlerFor("get", "/csv/:id/rows")(req({ params: { id: "1" }, user: { companyId: 999, userId: 1 } }), res);
  assert.equal(res.statusCode, 404);
  assert.equal(rowReads.length, 0);
});

test("reprocessing an import whose file has been purged is a 410 with an actionable message", async () => {
  reset();
  await handlerFor("post", "/csv")(req({ query: { filename: "j.csv" }, body: GOOD }), makeRes());
  stored.get("1").contentAvailable = false;
  engineStarts.length = 0;

  const res = makeRes();
  await handlerFor("post", "/csv/:id/reprocess")(req({ params: { id: "1" }, body: {} }), res);
  assert.equal(res.statusCode, 410, "410 Gone, not a failed engine run the user can't act on");
  assert.match(res.body.error, /30 days/);
  assert.equal(engineStarts.length, 0);
});

test("reprocessing an already-running import is a 409, not a second concurrent run", async () => {
  reset();
  await handlerFor("post", "/csv")(req({ query: { filename: "j.csv" }, body: GOOD }), makeRes());
  stored.get("1").status = "running";
  engineStarts.length = 0;

  const res = makeRes();
  await handlerFor("post", "/csv/:id/reprocess")(req({ params: { id: "1" }, body: {} }), res);
  assert.equal(res.statusCode, 409);
  assert.equal(engineStarts.length, 0);
});
