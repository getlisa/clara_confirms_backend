const db = require("../db");
const callSettingsDb = require("../db/call-settings");
const scheduledCallsDb = require("../db/scheduled-calls");
const retell = require("./retell");
const logger = require("../utils/logger");

function toLocalHHMM(date, tz) {
  try {
    const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(date);
    return `${(p.find(x => x.type === "hour")?.value ?? "00").padStart(2,"0")}:${(p.find(x => x.type === "minute")?.value ?? "00").padStart(2,"0")}`;
  } catch { return "12:00"; }
}

function toLocalDayOfWeek(date, tz) {
  try {
    const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).formatToParts(date);
    return ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].indexOf(p.find(x => x.type === "weekday")?.value);
  } catch { return date.getDay(); }
}

function isWithinActiveHours(s, tz, date = new Date()) {
  const day = toLocalDayOfWeek(date, tz);
  if (!s.include_weekends && (day === 0 || day === 6)) return false;
  const now = toLocalHHMM(date, tz);
  return now >= s.business_hours_start && now < s.business_hours_end;
}

function getNextWindowStart(s, tz, from = new Date()) {
  const c = new Date(from); c.setSeconds(0, 0); c.setMinutes(c.getMinutes() + 1);
  for (let i = 0; i < 60*24*7; i++) { if (isWithinActiveHours(s, tz, c)) return c; c.setMinutes(c.getMinutes() + 1); }
  return new Date(from.getTime() + 86400000);
}

function snapToWindowStart(s, tz, targetDate) {
  const [h, m] = s.business_hours_start.split(":").map(Number);
  const c = new Date(new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(targetDate) + `T${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:00`);
  if (c <= new Date()) return getNextWindowStart(s, tz, new Date());
  const day = toLocalDayOfWeek(c, tz);
  if (!s.include_weekends && (day === 0 || day === 6)) return getNextWindowStart(s, tz, c);
  return c;
}

async function runDispatcher(batchSize = 10) {
  const rows = await scheduledCallsDb.claimPending(batchSize);
  if (rows.length === 0) return { fired: 0, skipped: 0, failed: 0 };
  let fired = 0, skipped = 0, failed = 0;
  for (const row of rows) {
    try {
      const { rows: cr } = await db.query(`SELECT default_timezone FROM companies WHERE id = $1`, [row.company_id]);
      const tz = cr[0]?.default_timezone || "America/New_York";
      if (!row.is_test) {
        const cs = await callSettingsDb.getByCompanyId(row.company_id);
        if (!isWithinActiveHours(cs, tz)) {
          await scheduledCallsDb.advanceToNextWindow(row.id, getNextWindowStart(cs, tz));
          skipped++; continue;
        }
      }
      const dynVars = {
        call_type: row.call_type,
        ...(row.customer_name    && { customer_name:    row.customer_name }),
        ...(row.technician_name  && { technician_name:  row.technician_name }),
        ...(row.customer_address && { customer_address: row.customer_address }),
        ...(row.job_date && { job_date: new Date(row.job_date).toLocaleDateString("en-US", { weekday:"long", month:"long", day:"numeric", year:"numeric" }) }),
        ...(row.job_id   && { job_id: String(row.job_id) }),
      };
      const call = await retell.createCall({ toNumber: row.phone_number, companyId: row.company_id, callType: row.call_type, dynamicVariables: dynVars, metadata: { scheduled_call_id: String(row.id), is_test: row.is_test } });
      await scheduledCallsDb.markCompleted(row.id, call.call_id);
      logger.info("Dispatcher: fired", { rowId: row.id, callId: call.call_id });
      fired++;
    } catch (err) {
      const st = await scheduledCallsDb.markFailedOrRetry(row.id, err.message);
      logger.error("Dispatcher: failed", { rowId: row.id, error: err.message, status: st });
      failed++;
    }
  }
  return { fired, skipped, failed };
}

async function runDailyJob() {
  const { rows: companies } = await db.query(`SELECT id, default_timezone FROM companies WHERE is_active = true OR is_active IS NULL`);
  let created = 0, skipped = 0;
  for (const co of companies) {
    try {
      const { rows: callTypes } = await db.query(`SELECT type, days_before FROM call_type_configs WHERE company_id = $1 AND enabled = true`, [co.id]);
      const cs = await callSettingsDb.getByCompanyId(co.id);
      for (const ct of callTypes) {
        const td = new Date(); td.setDate(td.getDate() + ct.days_before);
        const tds = td.toISOString().split("T")[0];
        const { rows: srs } = await db.query(
          `SELECT sr.servicetrade_id AS job_id, loc.phone_number AS location_phone, loc.address::text AS customer_address, comp.name AS customer_name
           FROM servicetrade_service_requests sr
           JOIN servicetrade_locations loc ON loc.servicetrade_id = sr.location_id
           JOIN servicetrade_companies comp ON comp.servicetrade_id = loc.company_id
           WHERE sr.company_id=$1 AND DATE(sr.window_start AT TIME ZONE $2)=$3::date AND sr.status NOT IN ('cancelled','closed') AND loc.phone_number IS NOT NULL`,
          [co.id, co.default_timezone || "America/New_York", tds]
        );
        for (const sr of srs) {
          if (await scheduledCallsDb.existsForJob(co.id, String(sr.job_id), ct.type)) { skipped++; continue; }
          await scheduledCallsDb.create({ companyId: co.id, callType: ct.type, phoneNumber: sr.location_phone, jobId: String(sr.job_id), jobDate: td, customerName: sr.customer_name, customerAddress: sr.customer_address, scheduledAt: snapToWindowStart(cs, co.default_timezone || "America/New_York", td), isTest: false, maxAttempts: cs.max_attempts });
          created++;
        }
      }
    } catch (err) { logger.error("Daily job: company failed", { companyId: co.id, error: err.message }); }
  }
  logger.info("Daily job complete", { created, skipped });
  return { created, skipped };
}

module.exports = { runDispatcher, runDailyJob, isWithinActiveHours, getNextWindowStart };
