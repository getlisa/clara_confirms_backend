/**
 * Confirmation recipients — who actually gets contacted.
 *
 * resolveConfirmationRecipients is the single resolver behind both the sweep
 * and the manual paths, so a mistake here mis-routes every confirmation a
 * company sends. The risky part isn't the happy path, it's the precedence:
 * a company-wide default silently overriding a human's explicit pick, or a
 * type selection that matches nobody quietly dropping a customer's
 * confirmation altogether.
 *
 * Runs against a fake db (test/helpers/fake-db) — no database, no network.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { createFakeDb } = require("./helpers/fake-db");
const { stub, silentLogger } = require("./helpers/stub-modules");

const db = createFakeDb();
const logger = silentLogger();
const todoCalls = [];
const todosStub = {
  TODO_TYPES: { RECIPIENTS_TRUNCATED: "RECIPIENTS_TRUNCATED" },
  create: async (args) => { todoCalls.push(args); return { id: 1 }; },
};

// Must be seeded before the module under test is required — see stub-modules.
stub("db", db);
stub("db/todos", todosStub);
stub("utils/logger", logger);

const {
  resolveConfirmationRecipients,
  MAX_TYPE_MATCHED_RECIPIENTS,
} = require("../src/services/confirmation-recipients");

// ── helpers ──────────────────────────────────────────────────────────────────

const CO = 7;

function customer(over = {}) {
  return {
    id: 100,
    full_name: "Acme Property Group",
    phone: "+15551110000",
    email: "ops@acme.test",
    confirmation_include_customer: true,
    confirmation_contact_ids: [],
    ...over,
  };
}

function contact(id, over = {}) {
  return {
    id,
    first_name: "Dana",
    last_name: `Contact${id}`,
    phone: `+1555222${String(id).padStart(4, "0")}`,
    mobile: null,
    alternate_phone: null,
    email: `c${id}@acme.test`,
    contact_role: "general",
    ...over,
  };
}

/** Route the two reads the resolver can make. */
function routes({ picked = [], matched = [], openTodo = false } = {}) {
  db.reset();
  todoCalls.length = 0;
  logger.reset();
  db.on("FROM contacts WHERE company_id = $1 AND id = ANY", picked);       // rule 1
  db.on("JOIN contact_companies", matched);                                 // rule 2
  db.on("FROM todos", openTodo ? [{ id: 42 }] : []);                        // truncation idempotency
}

const names = (rs) => rs.map((r) => r.name);
const ids = (rs) => rs.map((r) => r.recipientContactId);

// ── Rule 3: the customer record (today's default) ────────────────────────────

test("default customer, setting off → exactly one recipient, the customer", async () => {
  routes();
  const r = await resolveConfirmationRecipients(CO, customer(), { contactTypes: [] });
  assert.deepEqual(ids(r), [null]);
  assert.equal(r[0].phone, "+15551110000");
  assert.equal(r[0].email, "ops@acme.test");
});

test("fast path issues no queries at all", async () => {
  routes();
  await resolveConfirmationRecipients(CO, customer(), { contactTypes: [] });
  assert.equal(db.calls.length, 0, "a stock customer must cost zero extra reads");
});

test("include_customer=false with nothing else configured → no recipients", async () => {
  routes();
  const r = await resolveConfirmationRecipients(
    CO, customer({ confirmation_include_customer: false }), { contactTypes: [] }
  );
  assert.deepEqual(r, []);
});

test("opts omitted entirely behaves as setting-off (callers that don't load call settings)", async () => {
  routes();
  const r = await resolveConfirmationRecipients(CO, customer());
  assert.deepEqual(ids(r), [null]);
  assert.equal(db.calls.length, 0);
});

// ── Rule 1: explicit per-customer picks ──────────────────────────────────────

test("explicit picks are appended after the customer, in the order given", async () => {
  routes({ picked: [contact(2), contact(1)] });
  const r = await resolveConfirmationRecipients(
    CO, customer({ confirmation_contact_ids: [1, 2] }), { contactTypes: [] }
  );
  assert.deepEqual(ids(r), [null, 1, 2], "order follows confirmation_contact_ids, not row order");
});

test("explicit picks with include_customer=false → only the picks", async () => {
  routes({ picked: [contact(1)] });
  const r = await resolveConfirmationRecipients(
    CO, customer({ confirmation_include_customer: false, confirmation_contact_ids: [1] }), { contactTypes: [] }
  );
  assert.deepEqual(ids(r), [1]);
});

test("a pick that no longer resolves is skipped, the rest survive", async () => {
  routes({ picked: [contact(1)] }); // id 9 deliberately absent
  const r = await resolveConfirmationRecipients(
    CO, customer({ confirmation_contact_ids: [9, 1] }), { contactTypes: [] }
  );
  assert.deepEqual(ids(r), [null, 1], "one bad id must not blank the whole list");
});

test("PRECEDENCE: explicit picks beat the contact-type default, and skip the type query", async () => {
  routes({ picked: [contact(1)], matched: [contact(50), contact(51)] });
  const r = await resolveConfirmationRecipients(
    CO, customer({ confirmation_contact_ids: [1] }), { contactTypes: ["on-site"] }
  );
  assert.deepEqual(ids(r), [null, 1], "a human's choice outranks the company default");
  assert.equal(db.matched("JOIN contact_companies").length, 0, "must short-circuit before the type lookup");
});

test("phone falls back mobile → alternate_phone", async () => {
  routes({ picked: [
    contact(1, { phone: null, mobile: "+15553330001" }),
    contact(2, { phone: null, mobile: null, alternate_phone: "+15553330002" }),
    contact(3, { phone: null, mobile: null, alternate_phone: null }),
  ] });
  const r = await resolveConfirmationRecipients(
    CO, customer({ confirmation_include_customer: false, confirmation_contact_ids: [1, 2, 3] }), {}
  );
  assert.deepEqual(r.map((x) => x.phone), ["+15553330001", "+15553330002", null]);
});

test("name assembly tolerates missing halves", async () => {
  routes({ picked: [
    contact(1, { first_name: "Ada", last_name: null }),
    contact(2, { first_name: null, last_name: "Lovelace" }),
    contact(3, { first_name: null, last_name: null }),
  ] });
  const r = await resolveConfirmationRecipients(
    CO, customer({ confirmation_include_customer: false, confirmation_contact_ids: [1, 2, 3] }), {}
  );
  assert.deepEqual(names(r), ["Ada", "Lovelace", null], "never emit 'null null' as a name");
});

// ── Rule 2: contact types ────────────────────────────────────────────────────

test("matched types REPLACE the customer-record recipient", async () => {
  routes({ matched: [contact(50), contact(51)] });
  const r = await resolveConfirmationRecipients(CO, customer(), { contactTypes: ["on-site"] });
  assert.deepEqual(ids(r), [50, 51]);
  assert.ok(!ids(r).includes(null), "the customer's switchboard is exactly what this replaces");
});

test("no contact matches → falls back to the customer record, never to nobody", async () => {
  routes({ matched: [] });
  const r = await resolveConfirmationRecipients(CO, customer(), { contactTypes: ["nonexistent"] });
  assert.deepEqual(ids(r), [null], "enabling the setting must not silently stop confirmations");
});

test("customerRow without an id falls through to rule 3 instead of throwing", async () => {
  routes({ matched: [contact(50)] });
  const { id, ...noId } = customer();
  const r = await resolveConfirmationRecipients(CO, noId, { contactTypes: ["on-site"] });
  assert.deepEqual(ids(r), [null]);
  assert.equal(db.matched("JOIN contact_companies").length, 0);
});

test("the type lookup is scoped to company + customer and passes the types through", async () => {
  routes({ matched: [contact(50)] });
  await resolveConfirmationRecipients(CO, customer(), { contactTypes: ["on-site", "scheduling"] });
  const call = db.calls.find((c) => c.sql.includes("JOIN contact_companies"));
  assert.deepEqual(call.params, [CO, 100, ["on-site", "scheduling"]]);
  assert.match(call.sql, /lower\(btrim\(t\)\) = ANY/, "matching must be case/whitespace-insensitive on the contact side");
});

test("cap survivors are ordered account-primary first, then reachable", async () => {
  routes({ matched: [contact(50)] });
  await resolveConfirmationRecipients(CO, customer(), { contactTypes: ["on-site"] });
  const sql = db.calls.find((c) => c.sql.includes("JOIN contact_companies")).sql;
  assert.match(sql, /ORDER BY is_primary DESC, is_reachable DESC, c\.id/,
    "ordering decides who survives the cap, so it is part of the contract");
});

test("an unreachable contact is still selected (its gap surfaces as a MISSING_PHONE todo later)", async () => {
  routes({ matched: [contact(50, { phone: null, mobile: null, alternate_phone: null, email: null })] });
  const r = await resolveConfirmationRecipients(CO, customer(), { contactTypes: ["on-site"] });
  assert.deepEqual(ids(r), [50]);
  assert.equal(r[0].phone, null);
  assert.equal(r[0].email, null);
});

// ── The fan-out cap ──────────────────────────────────────────────────────────

test(`more matches than the cap → exactly ${MAX_TYPE_MATCHED_RECIPIENTS}, keeping the first`, async () => {
  const many = Array.from({ length: 59 }, (_, i) => contact(200 + i));
  routes({ matched: many });
  const r = await resolveConfirmationRecipients(CO, customer(), { contactTypes: ["on-site"] });
  assert.equal(r.length, MAX_TYPE_MATCHED_RECIPIENTS);
  assert.deepEqual(ids(r), many.slice(0, MAX_TYPE_MATCHED_RECIPIENTS).map((c) => c.id));
});

test("truncation records a todo naming what was dropped", async () => {
  const many = Array.from({ length: 8 }, (_, i) => contact(300 + i));
  routes({ matched: many });
  await resolveConfirmationRecipients(CO, customer(), { contactTypes: ["on-site"] });
  assert.equal(todoCalls.length, 1);
  const t = todoCalls[0];
  assert.equal(t.type, "RECIPIENTS_TRUNCATED");
  assert.equal(t.priority, "low", "5 people were still contacted — this is an FYI, not a failure");
  assert.equal(t.metadata.dropped_count, 3);
  assert.deepEqual(t.metadata.dropped_contact_ids, [305, 306, 307]);
  assert.equal(t.metadata.customer_id, "100");
});

test("exactly at the cap → no truncation todo", async () => {
  routes({ matched: Array.from({ length: MAX_TYPE_MATCHED_RECIPIENTS }, (_, i) => contact(400 + i)) });
  const r = await resolveConfirmationRecipients(CO, customer(), { contactTypes: ["on-site"] });
  assert.equal(r.length, MAX_TYPE_MATCHED_RECIPIENTS);
  assert.equal(todoCalls.length, 0, "off-by-one: the cap itself is not truncation");
});

test("one over the cap → one dropped", async () => {
  routes({ matched: Array.from({ length: MAX_TYPE_MATCHED_RECIPIENTS + 1 }, (_, i) => contact(500 + i)) });
  await resolveConfirmationRecipients(CO, customer(), { contactTypes: ["on-site"] });
  assert.equal(todoCalls[0].metadata.dropped_count, 1);
});

test("an existing open todo is not duplicated on the next sweep", async () => {
  routes({ matched: Array.from({ length: 8 }, (_, i) => contact(600 + i)), openTodo: true });
  const r = await resolveConfirmationRecipients(CO, customer(), { contactTypes: ["on-site"] });
  assert.equal(r.length, MAX_TYPE_MATCHED_RECIPIENTS, "recipients are unaffected either way");
  assert.equal(todoCalls.length, 0, "the sweep runs constantly — one open todo per customer, not one per run");
});

test("a failing todo write never breaks recipient resolution", async () => {
  routes({ matched: Array.from({ length: 8 }, (_, i) => contact(700 + i)) });
  const original = todosStub.create;
  todosStub.create = async () => { throw new Error("todos table is on fire"); };
  try {
    const r = await resolveConfirmationRecipients(CO, customer(), { contactTypes: ["on-site"] });
    assert.equal(r.length, MAX_TYPE_MATCHED_RECIPIENTS, "reporting is a nicety; contacting people is not");
    assert.ok(logger.records.warn.length > 0, "but it must be logged, not swallowed");
  } finally {
    todosStub.create = original;
  }
});
