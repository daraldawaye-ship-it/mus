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

-- Immutable provenance attached to a stock movement, not a live item lookup.
-- Do not backfill old sales with today's item supplier: historical attribution
-- cannot be reconstructed reliably from the current card.
ALTER TABLE stock_movements
  ADD COLUMN supplier_account_id integer,
  ADD COLUMN supplier_account_code text,
  ADD COLUMN supplier_account_name text;

ALTER TABLE stock_movements ADD CONSTRAINT stock_movement_supplier_fk
  FOREIGN KEY (company_id, supplier_account_id)
  REFERENCES accounts (company_id, id)
  ON DELETE RESTRICT;

CREATE INDEX stock_movements_supplier_period_idx
  ON stock_movements (company_id, supplier_account_id, document_date, item_id)
  WHERE supplier_account_id IS NOT NULL;

-- Existing historical purchase movements have a reliable invoice supplier;
-- do not infer the supplier of older sales/transfers from today's item card.
UPDATE stock_movements m
SET supplier_account_id = i.supplier_account_id,
    supplier_account_code = i.supplier_account_code,
    supplier_account_name = i.supplier_account_name
FROM invoices i
WHERE m.company_id = i.company_id AND m.invoice_id = i.id
  AND m.kind IN ('purchase','purchase_return')
  AND i.supplier_account_id IS NOT NULL;
