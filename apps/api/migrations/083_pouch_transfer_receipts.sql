-- Each recorded pouch movement can be acknowledged exactly once. The
-- source remains immutable; receipt state is derived from this linked event.
-- A counted zero is valid (full shortage on a positive movement, full
-- overage on a negative movement).
CREATE TABLE employee_pouch_receipts (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id integer NOT NULL,
  source_operation_id integer NOT NULL,
  source_employee_id integer NOT NULL,
  receiver_employee_id integer NOT NULL,
  receiver_employee_name text NOT NULL,
  mode varchar(12) NOT NULL CHECK(mode IN('exact','difference')),
  expected_amount numeric(28,6) NOT NULL CHECK(expected_amount<>0),
  received_amount numeric(28,6) NOT NULL,
  difference_amount numeric(28,6) NOT NULL,
  cash_account_id integer NOT NULL,
  pouch_account_id integer NOT NULL,
  variance_account_id integer,
  financial_document_id integer NOT NULL,
  notes text NOT NULL DEFAULT '' CHECK(length(notes)<=1000),
  idempotency_key uuid NOT NULL,
  request_payload jsonb NOT NULL,
  created_by integer NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(company_id,id),
  UNIQUE(company_id,source_operation_id),
  UNIQUE(company_id,idempotency_key),
  UNIQUE(company_id,financial_document_id),
  FOREIGN KEY(company_id,source_operation_id)
    REFERENCES employee_cashbox_operations(company_id,id),
  FOREIGN KEY(company_id,source_employee_id)
    REFERENCES employees(company_id,id),
  FOREIGN KEY(company_id,receiver_employee_id)
    REFERENCES employees(company_id,id),
  FOREIGN KEY(company_id,cash_account_id) REFERENCES accounts(company_id,id),
  FOREIGN KEY(company_id,pouch_account_id) REFERENCES accounts(company_id,id),
  FOREIGN KEY(company_id,variance_account_id) REFERENCES accounts(company_id,id),
  FOREIGN KEY(company_id,financial_document_id)
    REFERENCES financial_documents(company_id,id),
  CHECK(difference_amount=expected_amount-received_amount),
  CHECK((mode='exact' AND received_amount=expected_amount
      AND difference_amount=0 AND variance_account_id IS NULL)
    OR (mode='difference' AND received_amount<>expected_amount
      AND variance_account_id IS NOT NULL)),
  CHECK(received_amount=0
    OR (expected_amount>0 AND received_amount>0)
    OR (expected_amount<0 AND received_amount<0))
);
CREATE INDEX employee_pouch_receipts_timeline
  ON employee_pouch_receipts(company_id,created_at DESC,id DESC);

-- Make linked receipts append-only. Canceling/adjusting a posted receipt
-- requires a separate, explicitly audited reversal workflow.
CREATE FUNCTION protect_employee_pouch_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Pouch receipt history is immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER employee_pouch_receipts_immutable
 BEFORE UPDATE OR DELETE ON employee_pouch_receipts
 FOR EACH ROW EXECUTE FUNCTION protect_employee_pouch_receipt();
