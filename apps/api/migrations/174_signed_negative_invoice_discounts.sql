-- Invoice-header discounts (signed) also apply when the gross invoice is
-- negative, including sales returns and purchase returns. Keep original-return
-- discount entitlements separate from newly entered manual adjustments.
-- Historical rows default to zero manual discount; no posted data is rewritten.
ALTER TABLE invoice_lines
  ADD COLUMN manual_discount numeric(28,6) NOT NULL DEFAULT 0;

ALTER TABLE invoice_lines DROP CONSTRAINT invoice_lines_signed_amounts_check;
ALTER TABLE invoice_lines ADD CONSTRAINT invoice_lines_signed_amounts_check CHECK (
  (
    (quantity>0 AND gross>=0 AND discount<=gross
      AND total>=0 AND base_total>=0 AND cost_base>=0 AND commission_amount>=0)
    OR
    (quantity<0 AND gross<=0 AND discount>=gross
      AND total<=0 AND base_total<=0 AND cost_base<=0 AND commission_amount<=0)
  )
  AND (original_line_id IS NOT NULL OR quantity>0 OR
    (discount=manual_discount AND commission_amount=0))
  AND (manual_discount=0 OR (gross<>0 AND (gross>0)=(quantity>0)))
);

-- A linked return's original discount limit is based solely on the amount
-- inherited from its original invoice. Exclude any additional manually entered
-- header discount, which must never consume or inflate that original allowance.
-- Patch only the currently deployed integrity function instead of replacing the
-- entire function and silently dropping unrelated stock/accounting safeguards.
DO $migration$
DECLARE
  source text;
  changed text;
  old_term text := 'sum(-r.discount)';
  new_term text := 'sum(-r.discount+r.manual_discount)';
BEGIN
  SELECT pg_get_functiondef('check_invoice_integrity()'::regprocedure)
    INTO source;
  IF source IS NULL OR strpos(source, old_term) = 0
     OR strpos(source, new_term) > 0 THEN
    RAISE EXCEPTION 'Unexpected invoice integrity definition; review refund limits before signed return discounts';
  END IF;
  changed := replace(source, old_term, new_term);
  EXECUTE changed;
END
$migration$;
