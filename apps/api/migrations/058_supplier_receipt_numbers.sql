-- Supplier-side external reference; never replaces internal sequential document number.
ALTER TABLE invoices ADD COLUMN supplier_receipt_number text NOT NULL DEFAULT ''
  CHECK (length(supplier_receipt_number) <= 100);
ALTER TABLE invoices ADD CONSTRAINT invoices_supplier_receipt_only_purchase
  CHECK (kind = 'purchase' OR supplier_receipt_number = '');

ALTER TABLE financial_documents ADD COLUMN supplier_receipt_number text NOT NULL DEFAULT ''
  CHECK (length(supplier_receipt_number) <= 100);
ALTER TABLE financial_documents ADD CONSTRAINT financial_supplier_receipt_only_payment
  CHECK (kind = 'payment' OR supplier_receipt_number = '');
