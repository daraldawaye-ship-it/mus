-- Display-only selling guidance. The fields never change the invoice ledger,
-- stock movements, sale prices, or source-item navigation.
ALTER TABLE items
  ADD COLUMN sale_notes text NOT NULL DEFAULT ''
    CHECK (length(sale_notes) <= 1000);
ALTER TABLE item_compositions
  ADD COLUMN sale_notes text NOT NULL DEFAULT ''
    CHECK (length(sale_notes) <= 1000);
