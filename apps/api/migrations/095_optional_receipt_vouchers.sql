-- Optional companion receipt/payment is a separate, posted financial document.
-- It never replaces the existing pouch/electronic-to-my-cashbox journal.
-- Append-only receipt tables receive this link at insertion time only.
ALTER TABLE employee_pouch_receipts
  ADD COLUMN voucher_document_id integer,
  ADD CONSTRAINT pouch_receipts_companion_document_fk
    FOREIGN KEY(company_id,voucher_document_id)
    REFERENCES financial_documents(company_id,id),
  ADD CONSTRAINT pouch_receipts_companion_document_unique
    UNIQUE(company_id,voucher_document_id);
ALTER TABLE employee_electronic_receipts
  ADD COLUMN voucher_document_id integer,
  ADD CONSTRAINT electronic_receipts_companion_document_fk
    FOREIGN KEY(company_id,voucher_document_id)
    REFERENCES financial_documents(company_id,id),
  ADD CONSTRAINT electronic_receipts_companion_document_unique
    UNIQUE(company_id,voucher_document_id);
