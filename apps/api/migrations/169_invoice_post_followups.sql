-- Follow-up actions are durable but must never delay the cashier's next invoice.
-- Enqueue atomically with the posted invoice and process only after COMMIT.
-- Unrelated financial journals, inventory and invoice.post auditing remain atomic.
CREATE TABLE invoice_post_followups (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id integer NOT NULL,
  invoice_id integer NOT NULL,
  created_by integer NOT NULL REFERENCES users(id),
  customer_reward_kind varchar(10) CHECK(customer_reward_kind IN ('new','existing')),
  doctor_reward_eligible boolean NOT NULL DEFAULT false,
  new_doctor_id integer,
  new_doctor_name text,
  archived_doctor_id integer,
  archived_doctor_name text,
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_error_code varchar(64),
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(company_id,invoice_id),
  FOREIGN KEY(company_id,invoice_id) REFERENCES invoices(company_id,id)
);
CREATE INDEX invoice_post_followups_pending
  ON invoice_post_followups(next_attempt_at,id) WHERE processed_at IS NULL;
