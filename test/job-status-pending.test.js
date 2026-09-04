/**
 * The `open` / `pending` pairing (migration 106).
 *
 * 'pending' is InspectPoint's vocabulary for the same state as 'open' —
 * "exists, nothing scheduled on it yet" — and is a LABEL, not a new behaviour.
 * Anywhere one status is actionable the other must be, or an InspectPoint
 * tenant silently drops out of that path entirely: ~99% of its jobs are
 * 'pending'. These tests pin the places where a `status = 'open'` literal
 * would reintroduce that blind spot.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { UNSCHEDULED_JOB_STATUSES, UNSCHEDULED_JOB_STATUSES_SQL } = require("../src/db/jobs");

const SRC = path.resolve(__dirname, "..", "src");

function read(rel) {
  return fs.readFileSync(path.join(SRC, rel), "utf8");
}

test("the shared constant lists exactly the two unscheduled statuses, and its SQL form agrees", () => {
  assert.deepEqual(UNSCHEDULED_JOB_STATUSES, ["open", "pending"]);
  for (const s of UNSCHEDULED_JOB_STATUSES) {
    assert.ok(UNSCHEDULED_JOB_STATUSES_SQL.includes(`'${s}'`), `${s} missing from the SQL form`);
  }
});

test("migration 106 adds 'pending' to the jobs.status CHECK without dropping any existing value", () => {
  const sql = fs.readFileSync(path.join(SRC, "..", "migrations", "106_jobs_pending_status.sql"), "utf8");
  for (const s of ["open", "pending", "scheduled", "rescheduled", "confirmed", "in_progress", "completed", "cancelled"]) {
    assert.ok(sql.includes(`'${s}'`), `${s} must remain permitted`);
  }
});

// The four places that decide whether an unscheduled job is reachable. A bare
// `status = 'open'` in any of them is the exact regression this guards.
const UNSCHEDULED_CALLSITES = [
  ["services/scheduler.js", "open_job_due_soon outreach sweep"],
  ["copilot/tools/handlers/read/find-call-targets.js", "copilot call-target finder"],
  ["routes/jobs.js", "REST open->scheduled promotion"],
  ["routes/retell-tools.js", "voice create_appointment promotion"],
  ["confirmation-agent/tools/handlers/create-appointment.js", "chat create_appointment promotion"],
];

for (const [file, label] of UNSCHEDULED_CALLSITES) {
  test(`${label} matches BOTH unscheduled statuses, not just 'open'`, () => {
    const src = read(file);
    assert.ok(
      !/status\s*=\s*'open'/.test(src),
      `${file} still has a bare status = 'open' — InspectPoint jobs (99% 'pending') would silently miss this path`
    );
    assert.ok(
      /status IN \('open', 'pending'\)|status IN \$\{UNSCHEDULED_JOB_STATUSES_SQL\}/.test(src),
      `${file} must match both unscheduled statuses`
    );
  });
}

test("the confirmation-status recompute still refuses to own EITHER unscheduled status", () => {
  // syncJobConfirmationStatus only rewrites jobs already in OWNED_STATUSES, so
  // 'pending' inherits 'open''s protection by being absent from that list.
  // If 'pending' were ever added there, a synced InspectPoint job would get
  // its status fought over by two writers.
  const src = read("services/job-confirmation-status.js");
  const owned = src.match(/OWNED_STATUSES\s*=\s*[`"']([^`"']+)[`"']/)[1];
  for (const s of UNSCHEDULED_JOB_STATUSES) {
    assert.ok(!owned.includes(`'${s}'`), `${s} must NOT be an owned status`);
  }
});

test("the copilot's job-status enum accepts 'pending', or the LLM cannot filter for it", () => {
  assert.match(read("copilot/tools/handlers/read/list-jobs.js"), /"pending"/);
});

test("the analytics by_status tiles count 'pending', so they still sum to total", () => {
  const src = read("services/analytics.js");
  assert.match(src, /status = 'pending'/, "missing the SQL FILTER");
  assert.match(src, /pending:\s*Number\(j\.s_pending\)/, "missing the response key");
});
