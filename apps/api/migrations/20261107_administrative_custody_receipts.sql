-- Separate immutable receiving records for company administrative custody transfers.
CREATE TABLE administrative_custody_receipts (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id integer NOT NULL,
  source_transfer_id integer NOT NULL,
  receiver_employee_id integer NOT NULL,
  receiver_employee_name text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('exact','difference')),
  expected_amount numeric(28,6) NOT NULL CHECK (expected_amount<>0),
  received_amount numeric(28,6) NOT NULL,
  difference_amount numeric(28,6) NOT NULL,
  cash_account_id integer NOT NULL,
  pouch_account_id integer NOT NULL,
  variance_account_id integer,
  financial_document_id integer NOT NULL,
  voucher_document_id integer,
  notes text NOT NULL DEFAULT '' CHECK (length(notes)<=1000),
  idempotency_key uuid NOT NULL,
  request_payload jsonb NOT NULL,
  created_by integer NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (company_id,id),
  UNIQUE (company_id,source_transfer_id),
  UNIQUE (company_id,idempotency_key),
  UNIQUE (company_id,financial_document_id),
  CHECK (cash_account_id<>pouch_account_id),
  CHECK (expected_amount=received_amount+difference_amount),
  FOREIGN KEY (company_id,source_transfer_id) REFERENCES administrative_custody_transfers(company_id,id),
  FOREIGN KEY (company_id,receiver_employee_id) REFERENCES employees(company_id,id),
  FOREIGN KEY (company_id,cash_account_id) REFERENCES accounts(company_id,id),
  FOREIGN KEY (company_id,pouch_account_id) REFERENCES accounts(company_id,id),
  FOREIGN KEY (company_id,variance_account_id) REFERENCES accounts(company_id,id),
  FOREIGN KEY (company_id,financial_document_id) REFERENCES financial_documents(company_id,id),
  FOREIGN KEY (company_id,voucher_document_id) REFERENCES financial_documents(company_id,id)
);
CREATE INDEX administrative_custody_receipts_timeline ON administrative_custody_receipts(company_id,created_at DESC,id DESC);
CREATE FUNCTION protect_administrative_custody_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Administrative custody receipts are immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER administrative_custody_receipts_immutable
  BEFORE UPDATE OR DELETE ON administrative_custody_receipts
  FOR EACH ROW EXECUTE FUNCTION protect_administrative_custody_receipt();
