-- Purchase bonus is free physical stock with no additional supplier charge.
-- Keep paid quantity and unit price unchanged for invoice totals/returns,
-- and store the additional quantity separately for exact audit and valuation.
ALTER TABLE invoice_lines
  ADD COLUMN IF NOT EXISTS bonus_quantity numeric(22,0) NOT NULL DEFAULT 0;

ALTER TABLE invoice_lines
  ADD CONSTRAINT invoice_lines_bonus_quantity_sign
  CHECK (bonus_quantity = 0 OR
         (quantity > 0 AND bonus_quantity > 0) OR
         (quantity < 0 AND bonus_quantity < 0));

COMMENT ON COLUMN invoice_lines.bonus_quantity IS
  'Additional free quantities in the invoice line selected unit. Negative on linked supplier returns to reverse originally received free stock. Paid quantity determines invoice gross; paid plus bonus quantity determines physical stock.';
