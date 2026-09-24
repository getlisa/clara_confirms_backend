/**
 * services/csv-import/parser.js — uploaded bytes -> raw string cells.
 *
 * Heaviest coverage on the two things that silently corrupt data rather than
 * failing loudly:
 *  - ExcelJS's default CSV mapper coerces types (phone -> Number, "01234" ->
 *    1234, date strings -> Date built in the SERVER's timezone). The parser
 *    disables that with `map: v => v`; these tests pin it, because nothing
 *    downstream can tell a coerced value from a typed one.
 *  - XLSX date cells really are Dates, built from the sheet serial as UTC.
 *    They must render back as the wall clock the user typed. The assertions
 *    below only prove that on a machine whose local timezone isn't UTC, so the
 *    suite forces one (see TZ below) rather than passing by luck in CI.
 */

process.env.TZ = "Asia/Kolkata"; // +05:30 — a local-getter bug shifts dates visibly

const test = require("node:test");
const assert = require("node:assert/strict");
const ExcelJS = require("exceljs");

const { stub, silentLogger } = require("./helpers/stub-modules");
stub("utils/logger", silentLogger());

const { parseSpreadsheet, cellToString, normalizeHeader, stripBom } = require("../src/services/csv-import/parser");

const buf = (s) => Buffer.from(s, "utf8");

// ── CSV: the type-coercion traps ────────────────────────────────────────────

test("every cell comes back as a STRING — ExcelJS's Number/Date coercion is disabled", async () => {
  const csv = "Ref,Phone,Zip,Amount,When\nWO-1,5551234567,01234,1500.50,2026-03-04\n";
  const { rows } = await parseSpreadsheet(buf(csv), "f.csv");
  const r = rows[0];
  for (const [k, v] of Object.entries(r)) {
    assert.equal(typeof v, "string", `${k} must stay a string, got ${typeof v}`);
  }
  assert.equal(r.Phone, "5551234567", "a phone must not become a Number");
  assert.equal(r.Zip, "01234", "a leading zero must survive — zips and account numbers depend on it");
  assert.equal(r.When, "2026-03-04", "a date must not be parsed into a Date here");
});

test("a UTF-8 BOM is stripped so the first header still matches", async () => {
  const { headers } = await parseSpreadsheet(buf("﻿Work Order,Customer\nWO-1,Acme\n"), "f.csv");
  assert.deepEqual(headers, ["Work Order", "Customer"]);
});

test("quoted commas, embedded newlines and CRLF line endings all survive", async () => {
  const csv = '"Ref","Customer","Notes"\r\n"WO-1","Acme, Inc.","line one\nline two"\r\n';
  const { rows } = await parseSpreadsheet(buf(csv), "f.csv");
  assert.equal(rows[0].Customer, "Acme, Inc.");
  assert.equal(rows[0].Notes, "line one\nline two");
});

test("entirely blank rows are dropped, but a row with any value is kept", async () => {
  const csv = "Ref,Customer\nWO-1,Acme\n,\n   ,   \nWO-2,\n";
  const { rows } = await parseSpreadsheet(buf(csv), "f.csv");
  assert.deepEqual(rows.map((r) => r.Ref), ["WO-1", "WO-2"]);
});

test("headers are trimmed and interior whitespace collapsed, so ' Work  Order ' matches", async () => {
  const { headers } = await parseSpreadsheet(buf(" Work  Order ,Customer\nWO-1,Acme\n"), "f.csv");
  assert.deepEqual(headers, ["Work Order", "Customer"]);
});

test("a duplicate column keeps the FIRST occurrence and warns — a trailing dupe is usually an empty spacer", async () => {
  const csv = "Ref,Phone,Phone\nWO-1,5551234567,\n";
  const { rows, warnings } = await parseSpreadsheet(buf(csv), "f.csv");
  assert.equal(rows[0].Phone, "5551234567", "the empty trailing duplicate must not blank the real value");
  assert.equal(warnings[0].code, "duplicate_header");
});

// ── XLSX: the Date trap ─────────────────────────────────────────────────────

async function xlsxBuffer(rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

test("an xlsx date cell renders as the wall clock that was typed, NOT shifted by the server's timezone", async () => {
  const b = await xlsxBuffer([
    ["Ref", "When"],
    ["WO-1", new Date(Date.UTC(2026, 2, 4, 14, 30, 0))],
  ]);
  const { rows } = await parseSpreadsheet(b, "f.xlsx");
  // Local getters on a +05:30 machine would render "2026-03-04 20:00:00".
  assert.equal(rows[0].When, "2026-03-04 14:30:00");
});

test("an xlsx date-only cell carries no invented 00:00:00 time component", async () => {
  const b = await xlsxBuffer([
    ["Ref", "When"],
    ["WO-1", new Date(Date.UTC(2026, 2, 5, 0, 0, 0))],
  ]);
  const { rows } = await parseSpreadsheet(b, "f.xlsx");
  assert.equal(rows[0].When, "2026-03-05", "a bare date must not gain a midnight time the user never typed");
});

test("xlsx reads the first sheet only", async () => {
  const wb = new ExcelJS.Workbook();
  const a = wb.addWorksheet("First");
  a.addRow(["Ref"]); a.addRow(["FROM-FIRST"]);
  const b = wb.addWorksheet("Second");
  b.addRow(["Ref"]); b.addRow(["FROM-SECOND"]);
  const { rows } = await parseSpreadsheet(Buffer.from(await wb.xlsx.writeBuffer()), "f.xlsx");
  assert.deepEqual(rows.map((r) => r.Ref), ["FROM-FIRST"]);
});

// ── Whole-file rejections ───────────────────────────────────────────────────

test("an empty file, an unsupported extension and a header-only-blank file each fail with a readable message", async () => {
  await assert.rejects(() => parseSpreadsheet(Buffer.alloc(0), "f.csv"), /empty/i);
  await assert.rejects(() => parseSpreadsheet(buf("a,b\n1,2\n"), "f.pdf"), /Unsupported file type/i);
  await assert.rejects(() => parseSpreadsheet(buf(",,\n"), "f.csv"), /header row/i);
});

// ── Unit-level helpers ──────────────────────────────────────────────────────

test("cellToString flattens rich text, hyperlinks and formula results", () => {
  assert.equal(cellToString({ richText: [{ text: "Ac" }, { text: "me" }] }), "Acme");
  assert.equal(cellToString({ text: "Click", hyperlink: "http://x" }), "Click");
  assert.equal(cellToString({ formula: "A1+B1", result: 42 }), "42");
  assert.equal(cellToString({ error: "#DIV/0!" }), "", "an error cell is blank, not the literal '#DIV/0!'");
  assert.equal(cellToString(null), "");
});

test("stripBom and normalizeHeader", () => {
  assert.equal(stripBom("﻿Name"), "Name");
  assert.equal(stripBom("Name"), "Name");
  assert.equal(normalizeHeader("  Work   Order  "), "Work Order");
});
