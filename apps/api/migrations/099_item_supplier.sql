-- Current supplier of an item; optional and editable independently of purchases.
-- Existing item cards remain unset until manually selected or a qualifying
-- new purchase is posted.
ALTER TABLE items ADD COLUMN supplier_account_id integer;

ALTER TABLE items ADD CONSTRAINT items_supplier_company_fk
  FOREIGN KEY (company_id, supplier_account_id)
  REFERENCES accounts (company_id, id)
  ON DELETE RESTRICT;

CREATE INDEX items_supplier_account_idx
  ON items (company_id, supplier_account_id)
  WHERE supplier_account_id IS NOT NULL;
