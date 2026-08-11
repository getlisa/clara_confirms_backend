/**
 * Row-shaped fixtures — deliberately shaped the way db/jobs.getJobById returns
 * them, not the way job-confirmation-context returns them, so the real context
 * builder does its real work in these tests.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** ISO timestamp N days from now (negative = in the past). */
function inDays(n, hourUtc = 15) {
  const d = new Date(Date.now() + n * DAY_MS);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d.toISOString();
}

function appointment({
  id,
  start,
  end = null,
  status = "scheduled",
  customerConfirmed = false,
  technicianName = null,
  serviceLine = null,
  services = [],
} = {}) {
  return {
    id,
    job_id: 1,
    scheduled_start: start,
    scheduled_end: end,
    status,
    customer_confirmed: customerConfirmed,
    technician_confirmed: false,
    technician_name: technicianName,
    technician_phone: null,
    service_line: serviceLine,
    services,
    technicians: [],
  };
}

function job({
  id = 1,
  jobNumber = "48767205",
  title = "Annual Fire Inspection",
  description = "Yearly sprinkler inspection",
  appointments = [],
  customerName = "Acme Property Group",
  customerEmail = "ap@acme.test",
  customerPhone = "+15551230000",
} = {}) {
  return {
    id,
    company_id: 9,
    job_number: jobNumber,
    title,
    description,
    job_type: "inspection",
    status: "scheduled",
    scheduled_date: null,
    customer: {
      id: 77,
      full_name: customerName,
      phone: customerPhone,
      email: customerEmail,
      address_line1: "1 Main St",
      city: "Boston",
      state: "MA",
      zipcode: "02101",
    },
    technician: null,
    // getJobById returns newest-first — the context builder is responsible for
    // re-sorting, so fixtures hand them over in that order on purpose.
    appointments: [...appointments].sort(
      (a, b) => new Date(b.scheduled_start) - new Date(a.scheduled_start)
    ),
    contacts: [],
    quotations: [],
  };
}

/** A pending scheduled_calls row as claimPending returns it. */
function scheduledCallRow(overrides = {}) {
  return {
    id: 501,
    company_id: 9,
    call_type: "customer_confirmation",
    channel: "voice",
    job_id: "1",
    job_name: "Annual Fire Inspection",
    job_description: "Yearly sprinkler inspection",
    job_type: "inspection",
    job_date: null,
    appointment_id: null,
    customer_name: "Acme Property Group",
    customer_address: "1 Main St, Boston, MA",
    technician_name: null,
    phone_number: "+15551230000",
    recipient_contact_id: null,
    recipient_name: null,
    recipient_email: null,
    total_amount: null,
    call_context: null,
    link_delivery: null,
    scheduled_at: new Date(Date.now() - 60000).toISOString(),
    is_test: false,
    attempt_number: 0,
    max_attempts: 3,
    ...overrides,
  };
}

module.exports = { inDays, appointment, job, scheduledCallRow };
