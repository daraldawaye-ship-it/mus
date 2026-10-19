-- Optional selling-price grouping and one original (reference) item per composition.
-- The threshold uses the item's unit-one sale price in the item's price currency.
-- Neither setting changes invoice pricing, stock, or existing item links.
ALTER TABLE item_compositions
  ADD COLUMN price_split_threshold numeric(28,6)
    CHECK (price_split_threshold >= 0),
  ADD COLUMN original_item_id integer;

ALTER TABLE item_compositions
  ADD CONSTRAINT composition_original_same_company_fk
  FOREIGN KEY (company_id,original_item_id)
  REFERENCES items(company_id,id)
  DEFERRABLE INITIALLY IMMEDIATE;

CREATE INDEX IF NOT EXISTS idx_items_composition_sale_price1
  ON items(company_id,composition_id,sale_price1,id);
