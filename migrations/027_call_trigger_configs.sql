-- Configurable call trigger rules per tenant.
-- Each trigger type defines WHEN the scheduler should place a call.
-- All three are seeded as disabled on company registration — tenant enables as needed.

CREATE TABLE call_trigger_configs (
  id             SERIAL PRIMARY KEY,
  company_id     INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  trigger_type   VARCHAR NOT NULL
                 CHECK (trigger_type IN (
                   'scheduled_unconfirmed',   -- job scheduled, customer hasn't confirmed
                   'quotation_pending',        -- quotation sent/viewed but not accepted
                   'open_job_due_soon'         -- job is open and scheduled_date is within N days
                 )),

  enabled        BOOLEAN NOT NULL DEFAULT false,

  -- Which call_type_configs.type to use when firing this trigger
  call_type      VARCHAR NOT NULL DEFAULT 'customer_confirmation',

  -- Days before the job/appointment to fire (for scheduled_unconfirmed and open_job_due_soon)
  days_before    INTEGER NOT NULL DEFAULT 2 CHECK (days_before >= 1),

  -- Trigger-specific extra config
  -- scheduled_unconfirmed:  { "retry_if_no_answer": true }
  -- quotation_pending:      { "quote_statuses": ["sent","viewed"], "days_after_sent": 3 }
  -- open_job_due_soon:      { "only_if_technician_assigned": false }
  trigger_config JSONB NOT NULL DEFAULT '{}',

  description    TEXT,

  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (company_id, trigger_type)
);

CREATE INDEX call_trigger_configs_company_idx ON call_trigger_configs (company_id);
