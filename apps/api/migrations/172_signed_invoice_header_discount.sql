-- A signed invoice-header discount represents an extra amount when
-- negative. Preserve historical invoice rows and financial/stock immutability.
-- Do not weaken the nonnegative amounts used by general vouchers or prices.
ALTER TABLE invoice_lines DROP CONSTRAINT invoice_lines_signed_amounts_check;
ALTER TABLE invoice_lines ADD CONSTRAINT invoice_lines_signed_amounts_check CHECK (
  (
    (quantity>0 AND gross>=0 AND discount<=gross
      AND total>=0 AND base_total>=0 AND cost_base>=0 AND commission_amount>=0)
    OR
    (quantity<0 AND gross<=0 AND discount>=gross
      AND total<=0 AND base_total<=0 AND cost_base<=0 AND commission_amount<=0)
  )
  AND (original_line_id IS NOT NULL OR quantity>0 OR (discount=0 AND commission_amount=0))
);

-- Keep the current integrity trigger function, including all changes from
-- later migrations. Surgically update two account/refund predicates rather
-- than overwriting it with an obsolete copied implementation.
DO $migration$
DECLARE source text;
changed text;
old_account text := $needle$SELECT account_id INTO discount_account FROM account_links WHERE company_id=doc.company_id AND purpose='discountAllowed';$needle$;
new_account text := $replacement$SELECT account_id INTO discount_account FROM account_links
   WHERE company_id=doc.company_id
     AND purpose=CASE WHEN doc.discount<0 THEN 'discountEarned' ELSE 'discountAllowed' END;
 IF doc.discount<0 AND discount_account IS NULL THEN
   discount_account := setting.sales_account_id;
 END IF;$replacement$;
old_refund text := $needle$AND (SELECT COALESCE(sum(-r.discount),0) FROM invoice_lines r WHERE r.company_id=o.company_id AND r.original_line_id=o.id)<=o.discount$needle$;
new_refund text := $replacement$AND (
          (o.discount>=0 AND (SELECT COALESCE(sum(-r.discount),0) FROM invoice_lines r WHERE r.company_id=o.company_id AND r.original_line_id=o.id)<=o.discount)
       OR (o.discount<0 AND (SELECT COALESCE(sum(-r.discount),0) FROM invoice_lines r WHERE r.company_id=o.company_id AND r.original_line_id=o.id)>=o.discount)
        )$replacement$;
BEGIN
  SELECT pg_get_functiondef('check_invoice_integrity()'::regprocedure) INTO source;
  IF source IS NULL OR strpos(source,old_account)=0 OR strpos(source,old_refund)=0 THEN
    RAISE EXCEPTION 'Invoice integrity definition changed; review signed-discount migration before applying';
  END IF;
  changed := replace(replace(source,old_account,new_account),old_refund,new_refund);
  EXECUTE changed;
END
$migration$;
