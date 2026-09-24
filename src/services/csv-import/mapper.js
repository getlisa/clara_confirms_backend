/**
 * Parsed spreadsheet rows -> validated, typed import rows (or per-row errors).
 *
 * This is where every value is interpreted, and it is the riskiest code in the
 * import: a misread date books a technician on the wrong day, and nobody finds
 * out until a customer is called about a visit that isn't happening. So the
 * rule throughout is **refuse rather than guess** — an unparseable or
 * ambiguous value produces a row error naming the column and the offending
 * text, never a fallback value.
 *
 * ── The date-order problem, and why it's solved per FILE ────────────────────
 *
 * "03/04/2026" is 3 April to most of the world and 4 March in the US. The
 * reference implementation we based this on resolved that PER ROW — defaulting
 * to DD/MM and flipping to MM/DD only when the second part exceeded 12. That is
 * worse than picking one and stating it, because a single file can then be
 * interpreted both ways: "05/03" reads as 5 March while "03/13" three rows
 * later reads as 13 March, so the same column silently means two different
 * things.
 *
 * Here the order is decided ONCE for the whole file, before any row is mapped:
 *   - a part > 12 anywhere in the column proves the order for every row
 *   - if one row proves DMY and another proves MDY, the file contradicts
 *     itself and is rejected outright
 *   - if nothing proves either (every value ≤ 12/12), the file is genuinely
 *     ambiguous and we ask the uploader which it is, rather than guessing
 * ISO dates (YYYY-MM-DD) are never ambiguous and skip all of this.
 */

const { localToUTC } = require("../../utils/timezone");
const { toE164 } = require("../../utils/phone");

/**
 * Canonical field -> the header spellings we accept for it, lowercased.
 *
 * Real exports never agree on a name, and forcing customers to rename columns
 * before their first upload is the kind of friction that loses the deal — so
 * each field takes a small alias list rather than one exact string. Matching is
 * case- and whitespace-insensitive (see matchHeader).
 *
 * Anything NOT listed here is preserved verbatim on the row's `extra` bag
 * rather than discarded, so an unrecognized column is never a reason to fail.
 */
const COLUMN_ALIASES = {
  // The row's OWN unique id — becomes the appointment's external_ref, so it
  // must identify the visit, not the job. Alias order is priority order (see
  // resolveColumns), which is what keeps a file carrying BOTH "Work Order" and
  // "Job Number" from claiming the wrong one: the visit-ish names are listed
  // first, and the job-ish names only match when nothing better is present.
  reference: ["visit id", "visit number", "visit #", "work order", "work order #", "work order number", "wo", "wo #", "wo#", "reference", "reference number", "ref", "ticket", "ticket number", "appointment id", "line id", "job number", "job #", "job id", "document number"],
  // OPTIONAL, and only meaningful when the file distinguishes the two: the
  // parent job several visits belong to. Absent (the common single-visit-per-
  // job case) the job simply takes the row's own reference.
  //
  // This is deliberately an explicit column rather than something inferred by
  // stripping a numeric suffix off the reference — "WO-1001-2" might be visit
  // 2 of job WO-1001, or might just be how that company numbers a one-visit
  // job, and guessing wrong silently merges unrelated work onto one job.
  jobReference: ["job number", "job #", "job id", "parent job", "parent job number", "master job"],
  customerName: ["customer", "customer name", "client", "client name", "account", "account name", "name", "company", "company name"],
  phone: ["phone", "phone number", "customer phone", "primary phone", "mobile", "cell", "cell phone", "telephone", "contact phone"],
  email: ["email", "email address", "customer email", "e-mail", "contact email"],
  scheduledAt: ["scheduled", "scheduled at", "scheduled date/time", "scheduled datetime", "appointment", "appointment date/time", "date/time", "due date/receive by", "service date/time"],
  scheduledDate: ["scheduled date", "date", "service date", "appointment date", "visit date", "due date"],
  scheduledTime: ["scheduled time", "time", "service time", "appointment time", "visit time", "start time"],
  endAt: ["end", "end time", "scheduled end", "finish time"],
  durationMins: ["duration", "duration (mins)", "duration minutes", "length", "estimated duration"],
  // Separate from durationMins on purpose. A column called "Est. Hours" mapped
  // onto a minutes field turns a 2-hour visit into a 2-minute one, and nothing
  // downstream can tell. The unit has to be part of what the user chooses.
  durationHours: ["duration (hours)", "duration hours", "hours", "est hours", "estimated hours", "job hours"],
  serviceDescription: ["service", "service line", "description", "job description", "work description", "service description", "job type", "type"],
  technicianName: ["technician", "tech", "technician name", "assigned to", "assigned technician"],
  addressLine1: ["address", "address line 1", "street", "street address", "service address", "site address"],
  city: ["city", "town"],
  state: ["state", "province", "region"],
  zipcode: ["zip", "zip code", "zipcode", "postal code", "postcode"],
  // Deliberately no bare "contact": on its own it's ambiguous between the
  // person, their phone and their email, and claiming "Contact Mobile" for a
  // NAME would leave the file unimportable for want of a phone number.
  contactName: ["contact name", "site contact", "on-site contact", "contact person"],
};

/** Fields the file cannot be processed without. */
const REQUIRED_FIELDS = ["reference", "customerName"];

/**
 * What the UI shows as the drop targets in a column-mapping step.
 *
 * `requirement` is deliberately three-valued rather than a boolean:
 *   required     — the file cannot be imported without it
 *   one-of       — at least one field in the group must be mapped (a customer
 *                  needs SOME way to be reached; a visit needs SOME date)
 *   optional     — improves the import, never blocks it
 */
const TARGET_FIELDS = [
  { field: "reference", label: "Visit / work order reference", requirement: "required", hint: "Uniquely identifies this row. Re-importing matches on it, so an edited file updates instead of duplicating.", example: "WO-1001" },
  { field: "customerName", label: "Customer name", requirement: "required", hint: "The business or person the visit is for.", example: "Acme Inc" },
  { field: "phone", label: "Phone", requirement: "one-of:contact", hint: "Used to call or text. Map a phone, an email, or both.", example: "(555) 123-4567" },
  { field: "email", label: "Email", requirement: "one-of:contact", hint: "Used to send the confirmation link.", example: "ops@acme.com" },
  { field: "scheduledAt", label: "Scheduled date & time", requirement: "one-of:schedule", hint: "One column holding both. Map this OR a separate date column.", example: "2026-03-04 14:00" },
  { field: "scheduledDate", label: "Scheduled date", requirement: "one-of:schedule", hint: "Use with 'Scheduled time' when the file splits them.", example: "2026-03-04" },
  { field: "scheduledTime", label: "Scheduled time", requirement: "optional", hint: "Start time, when it's in its own column. Without it the visit is treated as all-day.", example: "2:00 PM" },
  { field: "endAt", label: "End time", requirement: "optional", hint: "When the visit finishes.", example: "4:00 PM" },
  { field: "durationMins", label: "Duration (minutes)", requirement: "optional", hint: "Alternative to an end time. Check the unit — mapping an hours column here would make a 2-hour visit 2 minutes long.", example: "120" },
  { field: "durationHours", label: "Duration (hours)", requirement: "optional", hint: "Use this when the column is in hours.", example: "2" },
  { field: "jobReference", label: "Parent job number", requirement: "optional", hint: "Only if several visits share one job. Leave unmapped and each row becomes its own job.", example: "J-500" },
  { field: "serviceDescription", label: "Service / description", requirement: "optional", hint: "What the visit is for. The agent says this out loud.", example: "Annual inspection" },
  { field: "technicianName", label: "Technician", requirement: "optional", hint: "Matched by name against your existing technicians; unmatched names are left unassigned.", example: "Jane Smith" },
  { field: "contactName", label: "Site contact", requirement: "optional", hint: "The person on site, if different from the customer.", example: "Bob Jones" },
  { field: "addressLine1", label: "Address", requirement: "optional", hint: "Street address of the site.", example: "1 Main St" },
  { field: "city", label: "City", requirement: "optional" },
  { field: "state", label: "State / province", requirement: "optional" },
  { field: "zipcode", label: "ZIP / postcode", requirement: "optional" },
];

/**
 * The alias lists run through the SAME normalisation as incoming headers, once
 * at load.
 *
 * Without this, an alias containing punctuation ("scheduled date/time",
 * "e-mail") could never match, because the header would normalise to
 * "scheduled date time" while the alias stayed a literal lookup key. Doing it
 * here means the lists above can be written the natural way and stay correct
 * however the normaliser changes.
 */
const NORMALIZED_ALIASES = Object.fromEntries(
  Object.entries(COLUMN_ALIASES).map(([field, aliases]) => [field, aliases.map((a) => normalizeForMatch(a))])
);

/**
 * A header -> its matching form: lowercased, punctuation treated as a space,
 * runs of whitespace collapsed.
 *
 * Order matters. Replacing punctuation BEFORE collapsing whitespace is what
 * makes "Customer__Phone" and "Customer . Phone" reduce to "customer phone";
 * doing it the other way round leaves the spaces punctuation just created
 * uncollapsed, so those headers silently fail to match and the file gets
 * rejected for a column it actually has.
 */
function normalizeForMatch(header) {
  return String(header ?? "")
    .toLowerCase()
    .replace(/[._\-/\\]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Headers -> which column feeds each canonical field.
 *
 * Matching walks the ALIAS list in order, not the header list, so alias order
 * is priority order: a file with both "Work Order" and "Job Number" gives
 * `reference` the work order regardless of which column appears first in the
 * sheet. Scanning headers instead would let column order in the spreadsheet
 * decide, which is arbitrary.
 *
 * A header can only be claimed once, and fields are resolved in declaration
 * order, so an earlier field wins a contested alias (`reference` takes "job
 * number" only when `jobReference` isn't separately present — see below).
 *
 * @returns {{mapping: Record<string,string>, unknown: string[], missing: string[]}}
 */
function resolveColumns(headers, overrides = {}) {
  const mapping = {};
  const claimed = new Set();
  const byNormalized = new Map();
  for (const h of headers) {
    const n = normalizeForMatch(h);
    if (!byNormalized.has(n)) byNormalized.set(n, h);
  }

  // An explicit user mapping wins outright. It is applied FIRST so the columns
  // it claims are off the table before alias matching runs — otherwise an
  // automatic match could steal a column the user deliberately assigned
  // somewhere else, which is the one thing a mapping UI must never do.
  //
  // A header named in the mapping that isn't in the file is ignored rather
  // than fatal: a saved mapping outliving a renamed column should degrade to
  // "that field is unmapped", not reject the upload.
  for (const [field, header] of Object.entries(stripEmpty(overrides))) {
    if (!COLUMN_ALIASES[field]) continue; // unknown target field — ignore
    const actual = headers.includes(header) ? header : byNormalized.get(normalizeForMatch(header));
    if (!actual || claimed.has(actual)) continue;
    mapping[field] = actual;
    claimed.add(actual);
  }

  for (const [field, aliases] of Object.entries(NORMALIZED_ALIASES)) {
    if (mapping[field]) continue; // already set by the explicit mapping
    for (const alias of aliases) {
      const hit = byNormalized.get(alias);
      if (hit && !claimed.has(hit)) {
        mapping[field] = hit;
        claimed.add(hit);
        break;
      }
    }
  }

  const missing = REQUIRED_FIELDS.filter((f) => !mapping[f]);
  // A time to schedule can arrive either as one combined column or as a
  // separate date column, so the requirement is "one of the two", not either
  // specific field.
  if (!mapping.scheduledAt && !mapping.scheduledDate) missing.push("scheduledAt");
  // Likewise the customer needs at least one way to be reached.
  if (!mapping.phone && !mapping.email) missing.push("phone");

  return { mapping, unknown: headers.filter((h) => !claimed.has(h)), missing };
}

/**
 * Best-guess column suggestions for the mapping UI.
 *
 * This is where fuzzy matching belongs — and ONLY here. Automatic import uses
 * exact alias matching, because a wrong guess there silently calls the wrong
 * number or books the wrong day with nobody the wiser. A suggestion a human
 * confirms has the opposite risk profile: being approximately right saves them
 * most of the work, and being wrong costs one click.
 *
 * Scoring, highest wins:
 *   1.0  the header IS an alias (what automatic matching already found)
 *   0.8  an alias's words all appear in the header — "Contact Mobile" ⊇ "mobile"
 *   0.6  the header's words all appear in an alias — "Phone" ⊆ "phone number"
 *   0.5+ partial word overlap, scaled by how much overlaps
 *
 * Greedy assignment: strongest pair first, and each header and field is used
 * at most once, so two fields can't both claim one column.
 *
 * @returns {Array<{field, header, confidence}>} sorted strongest-first
 */
/**
 * Tokens that mark a column as an IDENTIFIER rather than human text.
 *
 * "Account Code" and "Client Company" both contain a customer-name alias, so
 * they score identically on word overlap — but one is a reference number and
 * the other is the name a customer would recognise being read to them. These
 * tokens break that tie. Applied only to the human-text fields below, because
 * for `reference` the very same words are a positive signal.
 */
// Strong identifier markers only. "number" and "no" are deliberately absent —
// "Mobile Number" and "Phone Number" are ordinary contact columns, and
// penalising them would be worse than the problem being solved.
const IDENTIFIER_TOKENS = new Set(["code", "id", "ref", "key", "uid", "#"]);

/**
 * The two fields an identifier-looking column SHOULD win. Everywhere else, a
 * name like "Appointment Ref" or "Account Code" is a reference that happens to
 * share a word with a real field — "Appointment Ref" matches `scheduledAt` via
 * "appointment", and without this it would take the date slot and push the
 * actual reference column onto something else entirely.
 */
const ID_FRIENDLY_FIELDS = new Set(["reference", "jobReference"]);

function scoreHeaderForField(field, header, headerTokens) {
  const aliases = NORMALIZED_ALIASES[field] || [];
  const hTokens = headerTokens.get(header);
  const hNorm = normalizeForMatch(header);

  let best = 0;
  for (let i = 0; i < aliases.length; i++) {
    const alias = aliases[i];
    let score = 0;
    if (alias === hNorm) score = 1;
    else {
      const aTokens = new Set(alias.split(" ").filter(Boolean));
      const shared = [...aTokens].filter((t) => hTokens.has(t)).length;
      if (shared === 0) continue;
      if (shared === aTokens.size) score = 0.8;
      else if (shared === hTokens.size) score = 0.6;
      else score = 0.5 * (shared / Math.max(aTokens.size, hTokens.size)) + 0.3;
    }
    // Alias order is already priority order for exact matching, and the same
    // ranking is meaningful here: a decay per position lets a field's preferred
    // spelling outrank a later fallback. It's what stops `reference` claiming
    // "Job Number" (its 17th alias) when `jobReference` lists it first, leaving
    // a perfectly good "Appointment Ref" column unassigned.
    score -= i * 0.01;
    if (score > best) best = score;
  }
  if (best === 0) return 0;

  // A column whose name reads as an identifier is almost never the human text
  // it happens to share a word with — "Account Code" is not a customer name.
  // Never applied to an exact alias hit, and never to the fields where an
  // identifier IS the point.
  if (best < 1 && !ID_FRIENDLY_FIELDS.has(field) && [...hTokens].some((t) => IDENTIFIER_TOKENS.has(t))) {
    best *= 0.7;
  }
  return Number(best.toFixed(3));
}

function suggestColumns(headers) {
  const headerTokens = new Map(headers.map((h) => [h, new Set(normalizeForMatch(h).split(" ").filter(Boolean))]));

  const candidates = [];
  for (const { field } of TARGET_FIELDS) {
    for (const header of headers) {
      const confidence = scoreHeaderForField(field, header, headerTokens);
      if (confidence > 0) candidates.push({ field, header, confidence });
    }
  }

  // On a genuine tie, the field the import cannot proceed without takes the
  // column — an optional field winning would leave the file unimportable while
  // a usable column sits in a slot nobody needed.
  const priority = Object.fromEntries(TARGET_FIELDS.map((f) => [
    f.field,
    f.requirement === "required" ? 0 : f.requirement.startsWith("one-of") ? 1 : 2,
  ]));
  candidates.sort((a, b) =>
    b.confidence - a.confidence ||
    priority[a.field] - priority[b.field] ||
    a.field.localeCompare(b.field)
  );
  const usedFields = new Set();
  const usedHeaders = new Set();
  const chosen = [];
  for (const c of candidates) {
    if (usedFields.has(c.field) || usedHeaders.has(c.header)) continue;
    usedFields.add(c.field);
    usedHeaders.add(c.header);
    chosen.push(c);
  }
  return chosen;
}

/**
 * Every column ranked per field, for the dropdown behind each drop target.
 *
 * The single best guess (suggestColumns) pre-fills the UI; this is what orders
 * the alternatives when it guessed wrong. Columns with no signal at all are
 * still included, at the end — the user must always be able to pick any column
 * for any field, since our scoring knows nothing about their business.
 */
function rankColumnsForField(field, headers) {
  const headerTokens = new Map(headers.map((h) => [h, new Set(normalizeForMatch(h).split(" ").filter(Boolean))]));
  return headers
    .map((header) => ({ header, confidence: scoreHeaderForField(field, header, headerTokens) }))
    .sort((a, b) => b.confidence - a.confidence || headers.indexOf(a.header) - headers.indexOf(b.header));
}

/**
 * Everything a mapping UI needs to render itself for a given file: the
 * spreadsheet's own columns, the fields they can be mapped onto, our best
 * guesses, and what's still unsatisfied.
 */
function describeMapping(headers, overrides = {}) {
  const suggestions = suggestColumns(headers);
  const suggested = Object.fromEntries(suggestions.map((s) => [s.field, s.header]));
  const effective = { ...suggested, ...stripEmpty(overrides) };
  const { mapping, missing, unknown } = resolveColumns(headers, overrides);
  return {
    headers,
    // Each target field carries its own ranked column list, so the dropdown
    // behind every drop target is ordered by likelihood rather than by
    // whatever order the spreadsheet happened to use.
    targetFields: TARGET_FIELDS.map((f) => ({ ...f, columns: rankColumnsForField(f.field, headers) })),
    suggestions,
    suggestedMapping: suggested,
    mapping,
    effectiveMapping: effective,
    missing,
    unmappedHeaders: unknown,
  };
}

/** Drop blank/absent entries so an override of "" means "leave unmapped". */
function stripEmpty(obj) {
  return Object.fromEntries(Object.entries(obj || {}).filter(([, v]) => v != null && String(v).trim() !== ""));
}

/** Human-readable label for a missing required field, for the rejection message. */
const FIELD_LABELS = {
  reference: "a work order / reference number",
  customerName: "a customer name",
  scheduledAt: "a scheduled date (or date and time)",
  phone: "a phone number or email address",
};

const ISO_DATE = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
const SLASH_DATE = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/;

/** Split a cell that may hold "<date> <time>" into its two halves. */
function splitDateTime(value) {
  const s = String(value ?? "").trim();
  if (!s) return { date: "", time: "" };
  const m = s.match(/^(\S+)[\sT]+(.+)$/);
  return m ? { date: m[1], time: m[2].trim() } : { date: s, time: "" };
}

/**
 * Scan every scheduled value in the file and decide, once, how D/M/Y slash
 * dates should be read. See this file's header for why this is a file-level
 * decision rather than a per-row one.
 *
 * @returns {{order: "DMY"|"MDY"|"ISO_ONLY"|"ambiguous"|"contradictory", evidence: object}}
 */
function detectDateOrder(dateStrings) {
  let provesDMY = null; // a first part > 12 can only be a day
  let provesMDY = null; // a second part > 12 can only be a day
  let sawSlash = false;

  for (const raw of dateStrings) {
    const { date } = splitDateTime(raw);
    if (!date || ISO_DATE.test(date)) continue;
    const m = date.match(SLASH_DATE);
    if (!m) continue;
    sawSlash = true;
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a > 12 && !provesDMY) provesDMY = date;
    if (b > 12 && !provesMDY) provesMDY = date;
  }

  if (provesDMY && provesMDY) {
    return { order: "contradictory", evidence: { dmy: provesDMY, mdy: provesMDY } };
  }
  if (provesDMY) return { order: "DMY", evidence: { dmy: provesDMY } };
  if (provesMDY) return { order: "MDY", evidence: { mdy: provesMDY } };
  if (!sawSlash) return { order: "ISO_ONLY", evidence: {} };
  return { order: "ambiguous", evidence: {} };
}

/** "2:30 PM" / "14:30" / "14:30:00" -> "HH:mm:ss", or null if unreadable. */
function parseTime(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?$/);
  if (!m) return null;
  let hour = Number(m[1]);
  const min = Number(m[2]);
  const sec = Number(m[3] || 0);
  const meridiem = m[4]?.toLowerCase();
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  if (hour > 23 || min > 59 || sec > 59) return null;
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(hour)}:${pad(min)}:${pad(sec)}`;
}

/**
 * A date cell + the file's resolved order -> "YYYY-MM-DD", or null.
 * Two-digit years are read as 20xx; this product schedules future work, so a
 * "26" that means 1926 is not a case worth supporting.
 */
function parseDatePart(raw, order) {
  const s = String(raw ?? "").trim();
  if (!s) return null;

  const iso = s.match(ISO_DATE);
  if (iso) {
    const [, y, mo, d] = iso;
    return buildDate(Number(y), Number(mo), Number(d));
  }

  const slash = s.match(SLASH_DATE);
  if (slash) {
    const a = Number(slash[1]);
    const b = Number(slash[2]);
    const year = slash[3].length === 2 ? 2000 + Number(slash[3]) : Number(slash[3]);
    const [day, month] = order === "MDY" ? [b, a] : [a, b];
    return buildDate(year, month, day);
  }

  return null;
}

/** Reject impossible calendar dates (13th month, 31 February) rather than letting Date roll them over. */
function buildDate(year, month, day) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  const pad = (n) => String(n).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)}`;
}

/**
 * One parsed spreadsheet row -> a typed import row, or an error describing
 * exactly which column was unusable.
 */
function mapRow(row, { mapping, unknown, order, timezone, rowNumber }) {
  const get = (field) => (mapping[field] ? String(row[mapping[field]] ?? "").trim() : "");
  const fail = (message, column) => ({ ok: false, error: { row: rowNumber, column, message } });

  const reference = get("reference");
  if (!reference) return fail("Missing work order / reference number.", mapping.reference);

  const customerName = get("customerName");
  if (!customerName) return fail("Missing customer name.", mapping.customerName);

  // Scheduling — either one combined column or a date column plus optional time.
  const combined = get("scheduledAt");
  const rawDate = combined || get("scheduledDate");
  if (!rawDate) return fail("Missing scheduled date.", mapping.scheduledAt || mapping.scheduledDate);

  const { date: datePart, time: inlineTime } = splitDateTime(rawDate);
  const isoDate = parseDatePart(datePart, order);
  if (!isoDate) return fail(`Could not read the scheduled date "${datePart}".`, mapping.scheduledAt || mapping.scheduledDate);

  const rawTime = inlineTime || get("scheduledTime");
  // A visit with no stated time is a real case (an all-day or "sometime that
  // day" visit). Midnight local is the honest representation: it is that
  // calendar day, and the agent speaks the date rather than a made-up hour.
  const isoTime = rawTime ? parseTime(rawTime) : "00:00:00";
  if (!isoTime) return fail(`Could not read the scheduled time "${rawTime}".`, mapping.scheduledTime || mapping.scheduledAt);

  const scheduledStart = localToUTC(`${isoDate}T${isoTime}`, timezone);

  // End time: an explicit end column wins over a duration; neither is required.
  let scheduledEnd = null;
  const rawEnd = get("endAt");
  const rawDuration = get("durationMins");
  const rawDurationHours = get("durationHours");
  if (rawEnd) {
    // Try the WHOLE value as a time first. An end column is usually just a
    // time on the same day, and a 12-hour one splits disastrously otherwise:
    // splitDateTime("12:00 PM") yields date "12:00" + time "PM", so every row
    // of a file whose end column reads "12:00 PM" failed on a value that is
    // perfectly readable.
    const endTimeOnly = parseTime(rawEnd);
    if (endTimeOnly) {
      scheduledEnd = localToUTC(`${isoDate}T${endTimeOnly}`, timezone);
    } else {
      const { date: endDatePart, time: endTimePart } = splitDateTime(rawEnd);
      const endIsoDate = parseDatePart(endDatePart, order);
      const endIsoTime = endTimePart ? parseTime(endTimePart) : "00:00:00";
      if (!endIsoDate || !endIsoTime) return fail(`Could not read the end time "${rawEnd}".`, mapping.endAt);
      scheduledEnd = localToUTC(`${endIsoDate}T${endIsoTime}`, timezone);
    }
  } else if (rawDuration || rawDurationHours) {
    // Hours and minutes are separate fields so the unit can never be guessed
    // — mapping an "Est. Hours" column onto minutes would turn a 2-hour visit
    // into a 2-minute one, and no downstream check would notice.
    const raw = rawDuration || rawDurationHours;
    const value = Number(raw);
    const mins = rawDuration ? value : value * 60;
    if (!Number.isFinite(value) || value <= 0) {
      return fail(`Could not read the duration "${raw}".`, rawDuration ? mapping.durationMins : mapping.durationHours);
    }
    scheduledEnd = new Date(new Date(scheduledStart).getTime() + mins * 60_000).toISOString();
  }
  if (scheduledEnd && new Date(scheduledEnd) <= new Date(scheduledStart)) {
    return fail("The visit ends before it starts.", mapping.endAt || mapping.durationMins);
  }

  // ── Contactability ────────────────────────────────────────────────────────
  //
  // The requirement is "reachable SOMEHOW", so an unreadable phone only fails
  // the row when there is no usable email to fall back on. Rejecting outright
  // would throw away a perfectly contactable customer over a formatting
  // problem in a column we don't even need — which is exactly what happened to
  // a real file whose every row carried a good email beside a 7-digit phone.
  //
  // The bad value is still reported, as a per-row warning, so nobody has to
  // wonder later why those customers are email-only.
  const rowWarnings = [];
  const rawPhone = get("phone");
  const phone = rawPhone ? toE164(rawPhone) : null;

  const rawEmail = get("email");
  const emailLooksValid = rawEmail && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(rawEmail);
  const email = emailLooksValid ? rawEmail.toLowerCase() : null;

  if (rawPhone && !phone) {
    // toE164 returns null for a number it can't dial. The commonest cause by
    // far is a missing area code, so say so rather than leaving the user to
    // guess what "could not read" means.
    const digits = rawPhone.replace(/\D/g, "");
    const why = digits.length > 0 && digits.length < 10
      ? `"${rawPhone}" is only ${digits.length} digits — it needs an area code`
      : `could not read the phone number "${rawPhone}"`;
    if (!email) return fail(`${why[0].toUpperCase()}${why.slice(1)}, and there is no email address to fall back on.`, mapping.phone);
    rowWarnings.push({ code: "unusable_phone", column: mapping.phone, message: `${why[0].toUpperCase()}${why.slice(1)}. Importing this customer as email-only.` });
  }

  if (rawEmail && !emailLooksValid) {
    if (!phone) return fail(`"${rawEmail}" is not a valid email address, and there is no phone number to fall back on.`, mapping.email);
    rowWarnings.push({ code: "unusable_email", column: mapping.email, message: `"${rawEmail}" is not a valid email address. Importing this customer as phone-only.` });
  }

  if (!phone && !email) {
    return fail("The customer has neither a usable phone number nor an email address.", mapping.phone || mapping.email);
  }

  // Every column we don't model is kept verbatim. Costs nothing, and it is
  // what lets the agent answer "what does the gate code say?" later.
  const extra = {};
  for (const h of unknown) {
    const v = String(row[h] ?? "").trim();
    if (v !== "") extra[h] = v;
  }

  return {
    ok: true,
    value: {
      rowNumber,
      reference,
      // Falls back to the row's own reference, which makes the common
      // one-visit-per-job file produce exactly one job per row.
      jobReference: get("jobReference") || reference,
      customerName,
      phone,
      email,
      scheduledStart,
      scheduledEnd,
      serviceDescription: get("serviceDescription") || null,
      technicianName: get("technicianName") || null,
      contactName: get("contactName") || null,
      address: {
        addressLine1: get("addressLine1") || null,
        city: get("city") || null,
        state: get("state") || null,
        zipcode: get("zipcode") || null,
      },
      extra,
      // Non-fatal problems with a row that still imported — e.g. a phone we
      // couldn't dial on a customer who has a good email. Surfaced so the
      // office can see WHY a customer ended up email-only.
      warnings: rowWarnings,
    },
  };
}

/**
 * The module's entry point: a parsed sheet -> typed rows + per-row errors.
 *
 * Whole-file rejections (missing required columns, an unreadable date order)
 * throw, because there is nothing partial worth committing. Per-row problems
 * are collected and returned so a mostly-good file still imports.
 *
 * @param {{headers: string[], rows: Array<Record<string,string>>}} parsed
 * @param {{timezone: string, dateOrder?: "DMY"|"MDY"}} opts
 *   `dateOrder` resolves a file the scan can't settle on its own.
 * @returns {{rows: Array<object>, errors: Array<object>, dateOrder: string, mapping: object, unknownColumns: string[]}}
 */
function mapRows(parsed, { timezone, dateOrder = null, mapping: overrides = {} } = {}) {
  if (!timezone) throw new Error("mapRows requires the company's timezone.");

  const { mapping, unknown, missing } = resolveColumns(parsed.headers, overrides);
  if (missing.length) {
    const labels = [...new Set(missing.map((f) => FIELD_LABELS[f] || f))];
    // The thrown error carries everything a mapping UI needs to recover from
    // this without a second round trip — see describeMapping.
    const err = new Error(`The file is missing ${labels.join(", ")}. Found columns: ${parsed.headers.join(", ")}`);
    err.code = "UNMAPPED_COLUMNS";
    err.details = describeMapping(parsed.headers, overrides);
    throw err;
  }

  const dateCells = parsed.rows.map((r) => r[mapping.scheduledAt] ?? r[mapping.scheduledDate] ?? "");
  const detected = detectDateOrder(dateCells);

  let order = detected.order;
  if (order === "contradictory") {
    throw new Error(
      `The date column mixes day-first and month-first dates ("${detected.evidence.dmy}" can only be day-first, "${detected.evidence.mdy}" can only be month-first), so it cannot be read reliably. Fix the file, or re-export dates as YYYY-MM-DD.`
    );
  }
  if (order === "ambiguous") {
    if (!dateOrder) {
      throw new Error(
        "Every date in this file could be read either day-first or month-first, so we can't tell which you meant. Re-upload telling us the date format, or export dates as YYYY-MM-DD."
      );
    }
    order = dateOrder;
  }
  if (order === "ISO_ONLY") order = "DMY"; // unreachable for ISO input; keeps parseDatePart total

  const rows = [];
  const errors = [];
  parsed.rows.forEach((row, i) => {
    // +2: row 1 is the header, and spreadsheet rows are 1-indexed, so this is
    // the line number the user sees in Excel.
    const result = mapRow(row, { mapping, unknown, order, timezone, rowNumber: i + 2 });
    if (result.ok) rows.push(result.value);
    else errors.push(result.error);
  });

  // Row-level warnings, flattened — a file where 40 customers lost their phone
  // number is something the office should see, even though every row imported.
  const warnings = rows.flatMap((r) => (r.warnings || []).map((w) => ({ row: r.rowNumber, ...w })));

  return { rows, errors, warnings, dateOrder: order, mapping, unknownColumns: unknown };
}

module.exports = {
  mapRows,
  resolveColumns,
  suggestColumns,
  rankColumnsForField,
  describeMapping,
  TARGET_FIELDS,
  detectDateOrder,
  parseTime,
  parseDatePart,
  splitDateTime,
  COLUMN_ALIASES,
  REQUIRED_FIELDS,
};
