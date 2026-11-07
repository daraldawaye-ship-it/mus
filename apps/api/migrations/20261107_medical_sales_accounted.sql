-- Permanent, company-scoped accounting review marks for medical sales.
-- This does not post journal entries, edit invoices, or change stock balances.
-- Each invoice is marked once; repeated/overlapping confirmations are idempotent.
CREATE TABLE IF NOT EXISTS doctor_sales_accounted_invoices (
  company_id integer NOT NULL,
  invoice_id integer NOT NULL,
  main_name varchar(240) NOT NULL,
  cutoff_invoice_id integer NOT NULL,
  marked_by integer NOT NULL REFERENCES users(id),
  marked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (company_id, invoice_id),
  FOREIGN KEY (company_id, invoice_id) REFERENCES invoices(company_id,id)
);
CREATE INDEX IF NOT EXISTS doctor_sales_accounted_invoices_actor_time
  ON doctor_sales_accounted_invoices(company_id, marked_at DESC, marked_by);
