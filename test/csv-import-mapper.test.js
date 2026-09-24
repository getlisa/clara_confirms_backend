/**
 * services/csv-import/mapper.js — raw string cells -> typed import rows.
 *
 * The bulk of these tests are about DATES, because that is the failure mode
 * with real-world consequences: a misread date books a technician on the wrong
 * day and Clara calls a customer about a visit that isn't happening. The
 * reference implementation this feature was modelled on resolved day-vs-month
 * PER ROW and fell back to "today" when it couldn't parse at all — both are
 * explicitly tested against here.
 */

process.env.TZ = "Asia/Kolkata"; // prove nothing depends on the server's own zone

const test = require("node:test");
const assert = require("node:assert/strict");

const { stub, silentLogger } = require("./helpers/stub-modules");
stub("utils/logger", silentLogger());
// timezone.js pulls in db for getCompanyTimezone; localToUTC itself is pure,
// but requiring the real module would open a pg pool.
stub("db", { query: async () => ({ rows: [] }) });

const { mapRows, resolveColumns, suggestColumns, rankColumnsForField, detectDateOrder, parseTime, parseDatePart } = require("../src/services/csv-import/mapper");

const TZ = "America/New_York";

/** Build the {headers, rows} shape the parser produces. */
function sheet(headers, ...rows) {
  return { headers, rows: rows.map((cells) => Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? ""]))) };
}

const BASE = ["Work Order", "Customer", "Phone", "Scheduled"];
const okRow = (ref, when) => [ref, "Acme Inc", "5551234567", when];

// ── Date order: decided once per FILE ───────────────────────────────────────

test("a part over 12 anywhere in the column proves the order for EVERY row in the file", () => {
  // "25/12/2026" can only be day-first, so "03/04/2026" in the same file is 3 April.
  const s = sheet(BASE, okRow("WO-1", "25/12/2026"), okRow("WO-2", "03/04/2026"));
  const r = mapRows(s, { timezone: TZ });
  assert.equal(r.dateOrder, "DMY");
  assert.equal(r.rows[1].scheduledStart.slice(0, 10), "2026-04-03");
});

test("the same two dates in a month-first file resolve the other way", () => {
  const s = sheet(BASE, okRow("WO-1", "12/25/2026"), okRow("WO-2", "03/04/2026"));
  const r = mapRows(s, { timezone: TZ });
  assert.equal(r.dateOrder, "MDY");
  assert.equal(r.rows[1].scheduledStart.slice(0, 10), "2026-03-04");
});

test("a file proving BOTH orders is rejected outright rather than read two ways", () => {
  // This is the exact bug in the reference implementation: per-row inference
  // let one column mean day-first on one line and month-first on the next.
  const s = sheet(BASE, okRow("WO-1", "25/12/2026"), okRow("WO-2", "12/25/2026"));
  assert.throws(() => mapRows(s, { timezone: TZ }), /mixes day-first and month-first/i);
});

test("a wholly ambiguous file is refused, not guessed — but an explicit dateOrder resolves it", () => {
  const s = sheet(BASE, okRow("WO-1", "03/04/2026"));
  assert.throws(() => mapRows(s, { timezone: TZ }), /can't tell which you meant/i);

  const asMdy = mapRows(s, { timezone: TZ, dateOrder: "MDY" });
  assert.equal(asMdy.rows[0].scheduledStart.slice(0, 10), "2026-03-04");
  const asDmy = mapRows(s, { timezone: TZ, dateOrder: "DMY" });
  assert.equal(asDmy.rows[0].scheduledStart.slice(0, 10), "2026-04-03");
});

test("ISO dates are never ambiguous and need no declaration", () => {
  const s = sheet(BASE, okRow("WO-1", "2026-03-04"));
  const r = mapRows(s, { timezone: TZ });
  assert.equal(r.errors.length, 0);
  assert.equal(r.rows[0].scheduledStart.slice(0, 10), "2026-03-04");
});

// ── Times and timezone conversion ───────────────────────────────────────────

test("a wall-clock time is converted using the COMPANY's timezone, not the server's", () => {
  const r = mapRows(sheet(BASE, okRow("WO-1", "2026-03-04 14:30")), { timezone: TZ });
  // 14:30 EST (UTC-5 on 4 March, before DST starts) = 19:30Z.
  assert.equal(r.rows[0].scheduledStart, "2026-03-04T19:30:00.000Z");
});

test("the DST boundary is handled — the same wall clock maps to a different UTC hour either side", () => {
  // US DST begins 8 March 2026. 14:30 on the 7th is EST (-5), on the 9th EDT (-4).
  const r = mapRows(sheet(BASE, okRow("WO-1", "2026-03-07 14:30"), okRow("WO-2", "2026-03-09 14:30")), { timezone: TZ });
  assert.equal(r.rows[0].scheduledStart, "2026-03-07T19:30:00.000Z");
  assert.equal(r.rows[1].scheduledStart, "2026-03-09T18:30:00.000Z");
});

test("12-hour times with AM/PM are read correctly, including the midnight/noon edges", () => {
  assert.equal(parseTime("9:00 AM"), "09:00:00");
  assert.equal(parseTime("2:30 pm"), "14:30:00");
  assert.equal(parseTime("12:00 AM"), "00:00:00", "12 AM is midnight, not noon");
  assert.equal(parseTime("12:00 PM"), "12:00:00", "12 PM is noon, not midnight");
  assert.equal(parseTime("14:30:15"), "14:30:15");
  assert.equal(parseTime("25:00"), null);
  assert.equal(parseTime("half past two"), null);
});

test("a date with no time becomes local midnight rather than being rejected or given a made-up hour", () => {
  const r = mapRows(sheet(BASE, okRow("WO-1", "2026-03-04")), { timezone: TZ });
  assert.equal(r.rows[0].scheduledStart, "2026-03-04T05:00:00.000Z"); // 00:00 EST
});

test("separate date and time columns are combined", () => {
  const s = sheet(["Work Order", "Customer", "Phone", "Service Date", "Service Time"],
    ["WO-1", "Acme", "5551234567", "2026-03-04", "2:30 PM"]);
  const r = mapRows(s, { timezone: TZ });
  assert.equal(r.rows[0].scheduledStart, "2026-03-04T19:30:00.000Z");
});

// ── Refusing rather than guessing ───────────────────────────────────────────

test("an unparseable date is a ROW ERROR — never silently today's date", () => {
  const r = mapRows(sheet(BASE, okRow("WO-1", "2026-03-04"), okRow("WO-2", "sometime next week")), { timezone: TZ });
  assert.equal(r.rows.length, 1, "the good row still imports");
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].message, /Could not read the scheduled date/);
  assert.equal(r.errors[0].row, 3, "row numbers are the line numbers the user sees in Excel");
});

test("an impossible calendar date is rejected rather than rolling over into the next month", () => {
  const r = mapRows(sheet(BASE, okRow("WO-1", "2026-02-31")), { timezone: TZ });
  assert.equal(r.rows.length, 0);
  assert.match(r.errors[0].message, /Could not read the scheduled date/);
  assert.equal(parseDatePart("2026-02-31", "DMY"), null);
  assert.equal(parseDatePart("2026-13-01", "DMY"), null);
});

test("an unreadable phone is a row error, and a customer with no way to be reached is too", () => {
  const bad = mapRows(sheet(BASE, ["WO-1", "Acme", "not-a-phone", "2026-03-04"]), { timezone: TZ });
  assert.match(bad.errors[0].message, /Could not read the phone number/);

  const none = mapRows(sheet(["Work Order", "Customer", "Phone", "Email", "Scheduled"],
    ["WO-1", "Acme", "", "", "2026-03-04"]), { timezone: TZ });
  assert.match(none.errors[0].message, /neither a usable phone number nor an email/);
});

test("an unusable phone does NOT discard a row that has a good email — it imports as email-only, with a warning", () => {
  // A real template file did this on every row: a valid email beside a
  // 7-digit phone. Rejecting the row threw away a perfectly contactable
  // customer over a column we don't even need when an email is present.
  const s = sheet(["Work Order", "Customer", "Phone", "Email", "Scheduled"],
    ["WO-1", "Acme", "555-0142", "ops@acme.example", "2026-10-05"]);
  const r = mapRows(s, { timezone: TZ });

  assert.equal(r.errors.length, 0);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].phone, null);
  assert.equal(r.rows[0].email, "ops@acme.example");
  assert.equal(r.warnings.length, 1, "but the office must still be told why this customer can't be called");
  assert.equal(r.warnings[0].row, 2);
  assert.match(r.warnings[0].message, /only 7 digits.*area code/);
});

test("the same bad phone IS a row error when there's no email to fall back on", () => {
  const s = sheet(["Work Order", "Customer", "Phone", "Email", "Scheduled"],
    ["WO-1", "Acme", "555-0142", "", "2026-10-05"]);
  const r = mapRows(s, { timezone: TZ });
  assert.equal(r.rows.length, 0);
  assert.match(r.errors[0].message, /needs an area code, and there is no email address to fall back on/);
});

test("a short phone is diagnosed as a missing area code rather than 'could not read'", () => {
  const s = sheet(["Work Order", "Customer", "Phone", "Scheduled"], ["WO-1", "Acme", "555-0142", "2026-10-05"]);
  assert.match(mapRows(s, { timezone: TZ }).errors[0].message, /only 7 digits — it needs an area code/);

  // Something that isn't a number at all keeps the generic wording, since
  // "0 digits, needs an area code" would be nonsense.
  const junk = sheet(["Work Order", "Customer", "Phone", "Scheduled"], ["WO-1", "Acme", "n/a", "2026-10-05"]);
  assert.match(mapRows(junk, { timezone: TZ }).errors[0].message, /[Cc]ould not read the phone number/);
});

test("a malformed email is survivable when there's a usable phone, and fatal when there isn't", () => {
  const withPhone = sheet(["Work Order", "Customer", "Phone", "Email", "Scheduled"],
    ["WO-1", "Acme", "5551234567", "not-an-email", "2026-10-05"]);
  const ok = mapRows(withPhone, { timezone: TZ });
  assert.equal(ok.rows.length, 1);
  assert.equal(ok.rows[0].email, null);
  assert.match(ok.warnings[0].message, /not a valid email address/);

  const without = sheet(["Work Order", "Customer", "Phone", "Email", "Scheduled"],
    ["WO-1", "Acme", "", "not-an-email", "2026-10-05"]);
  assert.match(mapRows(without, { timezone: TZ }).errors[0].message, /no phone number to fall back on/);
});

test("a visit that ends before it starts is rejected", () => {
  const s = sheet(["Work Order", "Customer", "Phone", "Scheduled", "End Time"],
    ["WO-1", "Acme", "5551234567", "2026-03-04 14:00", "13:00"]);
  const r = mapRows(s, { timezone: TZ });
  assert.match(r.errors[0].message, /ends before it starts/);
});

test("a 12-hour end time is read as a TIME, not split into a date and a meridiem", () => {
  // Regression: splitDateTime("12:00 PM") yields date "12:00" + time "PM", so
  // "12:00" got parsed as a date and failed. Every row of a real 100-row file
  // whose "Arrival To" column read "12:00 PM" was rejected on a value that is
  // perfectly readable.
  const s = sheet(["Work Order", "Customer", "Phone", "Scheduled Date", "Arrival From", "Arrival To"],
    ["WO-1", "Acme", "5551234567", "11/17/2026", "10:00 AM", "12:00 PM"]);
  const r = mapRows(s, { timezone: TZ, dateOrder: "MDY",
    mapping: { scheduledTime: "Arrival From", endAt: "Arrival To" } });

  assert.equal(r.errors.length, 0);
  assert.equal(r.rows[0].scheduledStart, "2026-11-17T15:00:00.000Z"); // 10:00 EST
  assert.equal(r.rows[0].scheduledEnd, "2026-11-17T17:00:00.000Z");   // 12:00 EST
});

test("an end column carrying a full date and time still works", () => {
  const s = sheet(["Work Order", "Customer", "Phone", "Scheduled", "End Time"],
    ["WO-1", "Acme", "5551234567", "2026-03-04 22:00", "2026-03-05 01:00"]);
  const r = mapRows(s, { timezone: TZ });
  assert.equal(r.errors.length, 0, "an overnight visit spanning midnight is legitimate");
  assert.equal(r.rows[0].scheduledEnd, "2026-03-05T06:00:00.000Z");
});

test("duration and an explicit end time both produce scheduled_end; duration must be a positive number", () => {
  const dur = mapRows(sheet(["Work Order", "Customer", "Phone", "Scheduled", "Duration"],
    ["WO-1", "Acme", "5551234567", "2026-03-04 14:00", "90"]), { timezone: TZ });
  assert.equal(dur.rows[0].scheduledEnd, "2026-03-04T20:30:00.000Z");

  const end = mapRows(sheet(["Work Order", "Customer", "Phone", "Scheduled", "End Time"],
    ["WO-1", "Acme", "5551234567", "2026-03-04 14:00", "16:00"]), { timezone: TZ });
  assert.equal(end.rows[0].scheduledEnd, "2026-03-04T21:00:00.000Z");

  const junk = mapRows(sheet(["Work Order", "Customer", "Phone", "Scheduled", "Duration"],
    ["WO-1", "Acme", "5551234567", "2026-03-04 14:00", "a while"]), { timezone: TZ });
  assert.match(junk.errors[0].message, /Could not read the duration/);
});

// ── Column resolution ───────────────────────────────────────────────────────

test("required columns are matched through aliases, case- and spacing-insensitively", () => {
  const { mapping, missing } = resolveColumns(["WO #", "CLIENT NAME", "Cell Phone", "Appointment Date"]);
  assert.deepEqual(missing, []);
  assert.equal(mapping.reference, "WO #");
  assert.equal(mapping.customerName, "CLIENT NAME");
  assert.equal(mapping.phone, "Cell Phone");
  assert.equal(mapping.scheduledDate, "Appointment Date");
});

test("header matching survives punctuation and repeated separators", () => {
  // Punctuation is turned into spaces BEFORE whitespace is collapsed. Doing it
  // the other way round left "Customer__Phone" as "customer  phone" — two
  // spaces — which silently failed to match and got the whole file rejected
  // for a column it plainly had.
  for (const header of ["Customer__Phone", "Customer . Phone", "Cell-Phone", "CUSTOMER  PHONE", "customer.phone"]) {
    assert.equal(resolveColumns([header]).mapping.phone, header, `${header} should resolve to the phone column`);
  }
  // ...and aliases that themselves contain punctuation still match, because
  // the alias list runs through the same normalisation at load.
  assert.ok(resolveColumns(["Scheduled Date/Time"]).mapping.scheduledAt);
  assert.ok(resolveColumns(["E-Mail"]).mapping.email);
  assert.ok(resolveColumns(["Duration (mins)"]).mapping.durationMins);
});

test("a header that isn't in the alias list is NOT guessed at — it becomes an unknown column", () => {
  // The matcher is a fixed dictionary, not fuzzy matching. "Tel" is a perfectly
  // reasonable thing for a spreadsheet to say and we still don't claim it,
  // because a wrong guess here silently calls the wrong number.
  const { mapping, unknown } = resolveColumns(["Work Order", "Customer", "Tel", "Scheduled"]);
  assert.equal(mapping.phone, undefined);
  assert.ok(unknown.includes("Tel"), "it is preserved, not discarded");
});

// ── Explicit column mapping ─────────────────────────────────────────────────

/** A real customer export whose headers the alias dictionary cannot resolve. */
const REAL_HEADERS = ["Appointment Ref", "Job Number", "Account Code", "Client Company", "On-Site Contact",
  "Contact Mobile", "Contact Email Address", "Job Type", "Visit Day", "Arrival From", "Est. Hours",
  "Assigned Technician", "Site Address", "Town", "Province/State", "ZIP"];

test("an explicit mapping makes a file import that alias matching alone rejects", () => {
  const s = sheet(REAL_HEADERS, ["APT-1", "J-500", "ACC-9", "Northgate Retail", "Bob Jones",
    "5559876543", "bob@northgate.test", "Inspection", "2026-10-14", "9:30 AM", "2",
    "Jane Smith", "12 High St", "Springfield", "IL", "62704"]);

  assert.throws(() => mapRows(s, { timezone: TZ }), /missing/i);

  const r = mapRows(s, { timezone: TZ, mapping: {
    reference: "Appointment Ref", customerName: "Client Company",
    phone: "Contact Mobile", scheduledDate: "Visit Day", scheduledTime: "Arrival From",
  } });
  assert.equal(r.errors.length, 0);
  assert.equal(r.rows[0].reference, "APT-1");
  assert.equal(r.rows[0].customerName, "Northgate Retail");
});

test("an explicit mapping BEATS alias matching, and claims its column before automatic matching runs", () => {
  // "Job Number" is an alias for `reference`, so alias matching alone would
  // take it. The user says otherwise — and a mapping UI that can be overruled
  // by our own guesses is worse than no mapping UI.
  const s = sheet(REAL_HEADERS, ["APT-1", "J-500", "", "Acme", "", "5559876543", "", "", "2026-10-14", "", "", "", "", "", "", ""]);
  const r = mapRows(s, { timezone: TZ, mapping: {
    reference: "Appointment Ref", jobReference: "Job Number",
    customerName: "Client Company", phone: "Contact Mobile", scheduledDate: "Visit Day",
  } });
  assert.equal(r.mapping.reference, "Appointment Ref");
  assert.equal(r.mapping.jobReference, "Job Number");
  assert.equal(r.rows[0].jobReference, "J-500");
});

test("a mapping naming a column the file doesn't have degrades to unmapped rather than failing", () => {
  // A saved mapping outliving a renamed column must not hard-fail an upload.
  const s = sheet(BASE, okRow("WO-1", "2026-03-04"));
  const r = mapRows(s, { timezone: TZ, mapping: { serviceDescription: "Column That Left" } });
  assert.equal(r.errors.length, 0);
  assert.equal(r.mapping.serviceDescription, undefined);
});

test("hours and minutes are separate fields, so a duration column's unit is never guessed", () => {
  const hours = sheet(["Work Order", "Customer", "Phone", "Scheduled", "Est. Hours"],
    ["WO-1", "Acme", "5551234567", "2026-03-04 14:00", "2"]);
  const r = mapRows(hours, { timezone: TZ, mapping: { durationHours: "Est. Hours" } });
  assert.equal(r.rows[0].scheduledEnd, "2026-03-04T21:00:00.000Z", "2 hours after 14:00 EST");

  // The same "2" read as minutes — which is what mapping it to the wrong field
  // would silently do.
  const mins = sheet(["Work Order", "Customer", "Phone", "Scheduled", "Mins"],
    ["WO-1", "Acme", "5551234567", "2026-03-04 14:00", "2"]);
  const m = mapRows(mins, { timezone: TZ, mapping: { durationMins: "Mins" } });
  assert.equal(m.rows[0].scheduledEnd, "2026-03-04T19:02:00.000Z");
});

test("the rejection carries everything a mapping UI needs to recover in one screen", () => {
  const s = sheet(REAL_HEADERS, ["APT-1", "J-500", "ACC-9", "Northgate", "Bob", "5559876543", "b@x.test", "Insp", "2026-10-14", "9:30 AM", "2", "Jane", "12 High St", "Springfield", "IL", "62704"]);
  try {
    mapRows(s, { timezone: TZ });
    assert.fail("should have thrown");
  } catch (err) {
    assert.equal(err.code, "UNMAPPED_COLUMNS");
    assert.deepEqual(err.details.headers, REAL_HEADERS);
    assert.ok(err.details.targetFields.length > 0, "the fields a column can be dropped onto");
    assert.ok(err.details.targetFields[0].columns.length > 0, "each with its own ranked column list for the dropdown");
    assert.ok(err.details.missing.includes("customerName"));
  }
});

// ── Suggestions ─────────────────────────────────────────────────────────────

test("suggestions find the right columns in a real export that alias matching cannot", () => {
  const suggested = Object.fromEntries(suggestColumns(REAL_HEADERS).map((s) => [s.field, s.header]));
  assert.equal(suggested.reference, "Appointment Ref");
  assert.equal(suggested.phone, "Contact Mobile");
  assert.equal(suggested.email, "Contact Email Address");
  assert.equal(suggested.durationHours, "Est. Hours", "and picks the HOURS field, not minutes");
  assert.equal(suggested.scheduledDate, "Visit Day");
});

test("an identifier column loses to a name column for a name field", () => {
  // "Account Code" and "Client Company" both contain a customerName alias.
  // The one that is plainly a reference number must not win.
  const suggested = Object.fromEntries(suggestColumns(REAL_HEADERS).map((s) => [s.field, s.header]));
  assert.equal(suggested.customerName, "Client Company");
  // ...but identifier words are a POSITIVE signal where they belong.
  assert.equal(suggested.reference, "Appointment Ref");
});

test("no column is suggested for two fields at once", () => {
  const suggestions = suggestColumns(REAL_HEADERS);
  const headers = suggestions.map((s) => s.header);
  assert.equal(new Set(headers).size, headers.length);
});

test("every column is offered for every field, ranked — our scoring knows nothing about their business", () => {
  const ranked = rankColumnsForField("customerName", REAL_HEADERS);
  assert.equal(ranked.length, REAL_HEADERS.length, "the user must always be able to pick any column");
  assert.equal(ranked[0].header, "Client Company", "best guess first");
});

test("a file missing a required column is rejected whole, naming what's absent and what was found", () => {
  assert.throws(
    () => mapRows(sheet(["Customer", "Phone", "Scheduled"], ["Acme", "5551234567", "2026-03-04"]), { timezone: TZ }),
    /missing a work order \/ reference number.*Found columns/is
  );
});

test("email alone satisfies contactability — a phone column is not separately required", () => {
  const s = sheet(["Work Order", "Customer", "Email", "Scheduled"], ["WO-1", "Acme", "A@Example.COM", "2026-03-04"]);
  const r = mapRows(s, { timezone: TZ });
  assert.equal(r.errors.length, 0);
  assert.equal(r.rows[0].email, "a@example.com", "emails are lowercased for matching");
  assert.equal(r.rows[0].phone, null);
});

test("unknown columns are preserved verbatim per row instead of being dropped or failing the file", () => {
  const s = sheet(["Work Order", "Customer", "Phone", "Scheduled", "Gate Code", "PO Number", "Empty Col"],
    ["WO-1", "Acme", "5551234567", "2026-03-04", "#4455", "PO-9", ""]);
  const r = mapRows(s, { timezone: TZ });
  assert.deepEqual(r.unknownColumns, ["Gate Code", "PO Number", "Empty Col"]);
  assert.deepEqual(r.rows[0].extra, { "Gate Code": "#4455", "PO Number": "PO-9" }, "blank extras are omitted, not stored as empty strings");
});

test("detectDateOrder reports its evidence so a rejection can quote the offending cell", () => {
  assert.equal(detectDateOrder(["2026-03-04"]).order, "ISO_ONLY");
  assert.equal(detectDateOrder(["03/04/2026"]).order, "ambiguous");
  assert.deepEqual(detectDateOrder(["25/12/2026"]), { order: "DMY", evidence: { dmy: "25/12/2026" } });
  assert.equal(detectDateOrder(["25/12/2026", "12/25/2026"]).order, "contradictory");
});

test("two-digit years are read as 20xx", () => {
  const r = mapRows(sheet(BASE, okRow("WO-1", "25/12/26")), { timezone: TZ });
  assert.equal(r.rows[0].scheduledStart.slice(0, 10), "2026-12-25");
});
