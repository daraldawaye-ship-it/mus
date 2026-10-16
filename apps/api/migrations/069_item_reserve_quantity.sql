-- Reserve is explicit master data in the item's smallest enabled unit.
-- It does not reserve/transfer physical stock or alter stock valuation.
ALTER TABLE items ADD COLUMN reserve_quantity numeric(22,0) NOT NULL DEFAULT 0
  CHECK (reserve_quantity >= 0);
