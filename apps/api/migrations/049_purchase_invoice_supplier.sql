-- Preserve the financial counterparty separately from the actual supplier.
-- Old invoices deliberately keep an unknown supplier rather than guessing from a cashbox.
ALTER TABLE invoices
  ADD COLUMN supplier_account_id integer,
  ADD COLUMN supplier_account_code text,
  ADD COLUMN supplier_account_name text;

ALTER TABLE invoices
  ADD CONSTRAINT invoices_supplier_company_fk
    FOREIGN KEY (company_id, supplier_account_id)
    REFERENCES accounts(company_id, id),
  ADD CONSTRAINT invoices_supplier_snapshot_check CHECK (
    (supplier_account_id IS NULL
      AND supplier_account_code IS NULL
      AND supplier_account_name IS NULL)
    OR
    (kind = 'purchase'
      AND supplier_account_id IS NOT NULL
      AND supplier_account_code IS NOT NULL
      AND supplier_account_name IS NOT NULL)
  );

CREATE INDEX invoices_supplier_listing
  ON invoices(company_id, supplier_account_id, document_date DESC, id DESC)
  WHERE supplier_account_id IS NOT NULL;
