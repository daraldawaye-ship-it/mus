-- Direct cashier payments are distinct from custody/pouch movements.
-- Each payment is a posted payment voucher and a single medical/slip source.
CREATE TABLE direct_medical_payments (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id integer NOT NULL REFERENCES companies(id),
  cashbox_account_id integer NOT NULL,
  expense_account_id integer NOT NULL,
  amount numeric(28,2) NOT NULL CHECK(amount>0),
  notes text NOT NULL DEFAULT '',
  financial_document_id integer NOT NULL,
  expense_kind text NOT NULL CHECK(expense_kind IN ('medical','slips')),
  doctor_id integer NOT NULL,
  doctor_name text NOT NULL,
  doctor_main_name text NOT NULL,
  doctor_kind text NOT NULL CHECK(doctor_kind IN ('doctor','nurse')),
  slip_count integer,
  accounted_cutoff_invoice_id integer,
  accounted_invoice_count integer NOT NULL DEFAULT 0 CHECK(accounted_invoice_count>=0),
  idempotency_key uuid NOT NULL,
  request_payload jsonb NOT NULL,
  created_by integer NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(company_id,id),
  UNIQUE(company_id,financial_document_id),
  UNIQUE(company_id,idempotency_key),
  FOREIGN KEY(company_id,cashbox_account_id) REFERENCES accounts(company_id,id),
  FOREIGN KEY(company_id,expense_account_id) REFERENCES accounts(company_id,id),
  FOREIGN KEY(company_id,doctor_id) REFERENCES doctors(company_id,id),
  FOREIGN KEY(company_id,financial_document_id) REFERENCES financial_documents(company_id,id),
  CHECK(
    (expense_kind='medical' AND slip_count IS NULL)
    OR (expense_kind='slips' AND doctor_kind='nurse' AND slip_count BETWEEN 1 AND 2147483647)
  ),
  CHECK(expense_kind='medical' OR (accounted_cutoff_invoice_id IS NULL AND accounted_invoice_count=0))
);
CREATE INDEX direct_medical_payments_beneficiary ON direct_medical_payments(company_id,doctor_kind,doctor_main_name,created_at DESC);
CREATE INDEX direct_medical_payments_slips ON direct_medical_payments(company_id,id) WHERE expense_kind='slips';
CREATE TRIGGER direct_medical_payments_immutable BEFORE UPDATE OR DELETE ON direct_medical_payments
  FOR EACH ROW EXECUTE FUNCTION protect_administrative_custody_transfer();

-- Physical slip receipts must match direct payouts as well as custody payouts,
-- without counting their corresponding ledger lines a second time.
CREATE TABLE slip_receipt_direct_sources (
  company_id integer NOT NULL,
  source_id integer NOT NULL,
  receipt_id integer NOT NULL,
  PRIMARY KEY(company_id,source_id),
  FOREIGN KEY(company_id,source_id) REFERENCES direct_medical_payments(company_id,id),
  FOREIGN KEY(company_id,receipt_id) REFERENCES slip_receipts(company_id,id)
);
CREATE INDEX slip_receipt_direct_sources_receipt ON slip_receipt_direct_sources(company_id,receipt_id);
CREATE TRIGGER slip_receipt_direct_sources_immutable BEFORE UPDATE OR DELETE ON slip_receipt_direct_sources
  FOR EACH ROW EXECUTE FUNCTION protect_administrative_custody_transfer();
