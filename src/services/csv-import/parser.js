/**
 * Uploaded spreadsheet bytes -> `{headers, rows, warnings}`, where EVERY cell
 * is a plain trimmed string and nothing has been interpreted yet.
 *
 * Parsing and interpretation are deliberately separate: this module's only job
 * is to hand `mapper.js` the same text the user saw in their spreadsheet. All
 * coercion (dates, phones, numbers) happens there, against the company's own
 * timezone, where a bad value can be reported as a row error instead of
 * silently becoming something else.
 *
 * That separation is not academic — both of the parsers underneath this one
 * will happily corrupt the data if left to their defaults:
 *
 *  - ExcelJS's CSV reader (node_modules/exceljs/lib/csv/csv.js:55-80) runs
 *    `Number(datum)` on every cell and dayjs date-parsing on anything
 *    date-shaped. A phone number "5551234567" comes back as a Number, a zip
 *    "01234" as 1234, and "2026-03-04" as a Date built in whatever timezone
 *    the server happens to run in. We pass `map: v => v` to turn all of that
 *    off.
 *  - The XLSX reader genuinely does return Date objects for date-formatted
 *    cells, built from the sheet's serial number as UTC. Rendering those back
 *    with UTC getters (see cellToString) returns the wall clock the user
 *    actually typed, which is what the mapper expects. Using local getters
 *    here would shift dates by the server's offset.
 *
 * Why ExcelJS rather than papaparse/csv-parse: it is already a dependency
 * (src/services/daily-report/workbook.js writes the daily report with it) and
 * it reads both CSV and XLSX, so supporting both formats costs no new
 * dependency. Its CSV path delegates to fast-csv, so quoted fields, embedded
 * commas and embedded newlines are handled properly.
 */

const { Readable } = require("node:stream");
const ExcelJS = require("exceljs");

/** Excel's own cap, and a sane upper bound on a confirmation list. */
const MAX_ROWS = 50_000;

/**
 * A UTF-8 BOM survives as a zero-width character on the FIRST header, which
 * silently breaks an exact header match ("﻿Name" !== "Name"). Excel adds
 * one to every CSV it exports, so this is the common case, not the edge case.
 */
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Any ExcelJS cell value -> the string the user saw in the spreadsheet.
 *
 * Dates are rendered with UTC getters on purpose: ExcelJS builds them from the
 * sheet's serial number as UTC, so the UTC fields ARE the wall clock that was
 * typed. Reading them with local getters would shift every date by the
 * server's offset — the class of bug that books a technician on the wrong day.
 */
function cellToString(value) {
  if (value == null) return "";
  if (value instanceof Date) {
    const pad = (n) => String(n).padStart(2, "0");
    const date = `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
    const time = `${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}`;
    // A midnight time component means the cell was date-only in the sheet;
    // keeping the "00:00:00" would make the mapper think a time was supplied.
    return time === "00:00:00" ? date : `${date} ${time}`;
  }
  if (typeof value === "object") {
    // Rich text, hyperlinks and formula cells all carry their display text on
    // a different key. `result` can itself be a Date or a rich-text object, so
    // recurse rather than stringifying whatever comes back.
    if (Array.isArray(value.richText)) return value.richText.map((p) => p?.text ?? "").join("");
    if (value.text != null) return String(value.text);
    if (value.result !== undefined) return cellToString(value.result);
    if (value.error) return "";
    return "";
  }
  return String(value);
}

/**
 * Header row -> the canonical key each column will be read under: trimmed,
 * with interior whitespace collapsed. Case is preserved here (the mapper
 * lowercases when matching aliases) so unknown columns keep the spelling the
 * user chose when they land in additional_information.
 */
function normalizeHeader(raw) {
  return String(raw ?? "").trim().replace(/\s+/g, " ");
}

/**
 * Rows-as-arrays + a header row -> rows-as-objects, dropping rows that are
 * entirely blank.
 *
 * A duplicate header keeps the FIRST column's value rather than the last: a
 * trailing duplicate is nearly always an empty spacer column in a hand-edited
 * sheet, and letting it win would blank out a real value.
 */
function toObjects(headerRow, dataRows) {
  const warnings = [];
  const headers = [];
  const seen = new Set();
  headerRow.forEach((raw, i) => {
    const name = normalizeHeader(raw);
    if (!name) return; // unnamed column — nothing can reference it
    if (seen.has(name)) {
      warnings.push({ code: "duplicate_header", message: `Duplicate column "${name}" — only the first is read.`, column: i + 1 });
      return;
    }
    seen.add(name);
    headers.push({ name, index: i });
  });

  const rows = [];
  for (const cells of dataRows) {
    const row = {};
    let hasValue = false;
    for (const { name, index } of headers) {
      const v = cellToString(cells[index]).trim();
      row[name] = v;
      if (v !== "") hasValue = true;
    }
    if (hasValue) rows.push(row);
  }

  return { headers: headers.map((h) => h.name), rows, warnings };
}

/** CSV bytes -> rows-as-arrays, with ExcelJS's type coercion disabled. */
async function readCsvRows(buffer) {
  const text = stripBom(buffer.toString("utf8"));
  const workbook = new ExcelJS.Workbook();
  const worksheet = await workbook.csv.read(Readable.from([text]), {
    // THE important option — see this file's header comment.
    map: (v) => v,
  });
  return worksheetToArrays(worksheet);
}

/** XLSX bytes -> rows-as-arrays from the FIRST sheet only. */
async function readXlsxRows(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) return [];
  return worksheetToArrays(worksheet);
}

/**
 * ExcelJS worksheet -> plain arrays. `row.values` is 1-indexed with a leading
 * hole, so it is sliced; a fully empty row yields an empty array rather than
 * being dropped here (toObjects decides that, once it knows which columns
 * actually matter).
 */
function worksheetToArrays(worksheet) {
  const out = [];
  worksheet.eachRow({ includeEmpty: true }, (row) => {
    const values = Array.isArray(row.values) ? row.values.slice(1) : [];
    out.push(values);
  });
  return out;
}

/**
 * The module's entry point.
 *
 * @param {Buffer} buffer — the uploaded file's bytes
 * @param {string} filename — used only to pick a reader; content is not sniffed
 * @returns {Promise<{headers: string[], rows: Array<Record<string,string>>, warnings: Array<object>}>}
 * @throws {Error} on an unsupported extension, an unreadable file, or a row count over MAX_ROWS
 */
async function parseSpreadsheet(buffer, filename) {
  if (!buffer || buffer.length === 0) throw new Error("The uploaded file is empty.");

  const ext = String(filename || "").toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  let raw;
  if (ext === "csv" || ext === "txt") {
    raw = await readCsvRows(buffer);
  } else if (ext === "xlsx" || ext === "xlsm") {
    raw = await readXlsxRows(buffer);
  } else {
    throw new Error(`Unsupported file type ".${ext || "?"}" — upload a .csv or .xlsx file.`);
  }

  if (raw.length === 0) throw new Error("The file has no rows.");
  if (raw.length - 1 > MAX_ROWS) throw new Error(`The file has more than ${MAX_ROWS.toLocaleString()} rows.`);

  const [headerRow, ...dataRows] = raw;
  const { headers, rows, warnings } = toObjects(headerRow || [], dataRows);
  if (headers.length === 0) throw new Error("The first row must be a header row naming each column.");

  return { headers, rows, warnings };
}

module.exports = { parseSpreadsheet, MAX_ROWS, cellToString, normalizeHeader, stripBom };
