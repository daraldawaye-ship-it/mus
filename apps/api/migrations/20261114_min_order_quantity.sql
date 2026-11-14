-- Keep the automatic purchase suggestion above a per-item whole-first-unit floor.
-- Applies the requested default to both existing and newly inserted items.
-- This is planning metadata; no inventory, invoice, or account balances change.
ALTER TABLE items
  ADD COLUMN IF NOT EXISTS min_order_quantity integer NOT NULL DEFAULT 1;

ALTER TABLE items
  ADD CONSTRAINT items_min_order_quantity_positive CHECK (min_order_quantity >= 1);
