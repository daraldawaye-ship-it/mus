-- Enable signed stock quantities and signed pooled book value while preserving
-- the sum of immutable stock movements and journal-linked invoice variances.
ALTER TABLE inventory_settings DROP CONSTRAINT IF EXISTS inventory_settings_allow_negative_check;
ALTER TABLE inventory_settings ALTER COLUMN allow_negative SET DEFAULT true;
UPDATE inventory_settings SET allow_negative=true,revision=revision+1,
  updated_at=clock_timestamp() WHERE allow_negative=false;

ALTER TABLE stock_balances DROP CONSTRAINT IF EXISTS stock_balances_quantity_smallest_check;
ALTER TABLE stock_item_valuations DROP CONSTRAINT IF EXISTS stock_item_valuations_quantity_smallest_check;
ALTER TABLE stock_item_valuations DROP CONSTRAINT IF EXISTS stock_item_valuations_value_base_check;
ALTER TABLE stock_item_valuations DROP CONSTRAINT IF EXISTS stock_item_valuations_check;
ALTER TABLE stock_item_valuations ADD CONSTRAINT stock_item_valuations_sign_check CHECK (
 (quantity_smallest>0 AND value_base>=0)
 OR (quantity_smallest<0 AND value_base<=0)
 OR (quantity_smallest=0 AND value_base=0)
);
-- Permit standalone customer returns (quantity negative with no invoice-line
-- reference); purchase returns may still require their original server-side.
DO $drop_constraint$
DECLARE c record;
BEGIN
 FOR c IN SELECT conname FROM pg_constraint
    WHERE conrelid='invoice_lines'::regclass AND contype='c'
      AND pg_get_constraintdef(oid) LIKE '%original_line_id IS NOT NULL%'
 LOOP
   EXECUTE format('ALTER TABLE invoice_lines DROP CONSTRAINT %I',c.conname);
 END LOOP;
END $drop_constraint$;
ALTER TABLE invoice_lines ADD CONSTRAINT invoice_lines_link_direction_check
 CHECK(original_line_id IS NULL OR quantity<0);

-- The existing deferred integrity check already verifies all stock movement
-- quantities and costs for each invoice line, including returns without links.
-- A positive purchase can now carry a linked variance journal to reconcile
-- stock previously sold or transferred below zero.
CREATE OR REPLACE FUNCTION check_invoice_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE doc invoices%ROWTYPE; sums record; main_amount numeric; variance numeric;
BEGIN
 IF TG_TABLE_NAME='invoices' THEN SELECT * INTO doc FROM invoices WHERE company_id=NEW.company_id AND id=NEW.id;
 ELSE SELECT * INTO doc FROM invoices WHERE company_id=NEW.company_id AND id=NEW.invoice_id; END IF;
 SELECT count(*) AS n,sum(gross) AS gross,sum(discount) AS discount,sum(total) AS total,sum(base_total) AS base_total,sum(cost_base) AS cost_base
 INTO sums FROM invoice_lines WHERE company_id=doc.company_id AND invoice_id=doc.id;
 IF NOT doc.posted OR sums.n<1 OR
 ROW(sums.gross,sums.discount,sums.total,sums.base_total) IS DISTINCT FROM ROW(doc.gross,doc.discount,doc.total,doc.base_total)
 OR EXISTS(SELECT 1 FROM invoice_lines l WHERE l.company_id=doc.company_id AND l.invoice_id=doc.id AND (
   (l.quantity<0)<>doc.is_return OR l.gross<>l.quantity*l.unit_price
   OR abs(l.discount)>abs(l.gross) OR (NOT doc.is_return AND l.discount<0) OR (doc.is_return AND l.discount>0)
   OR l.smallest_quantity<>l.quantity*(CASE WHEN l.unit=1 THEN l.factor2::numeric*l.factor3 WHEN l.unit=2 THEN l.factor3 ELSE 1 END)
   OR COALESCE((SELECT sum(m.quantity_smallest) FROM stock_movements m WHERE m.company_id=l.company_id AND m.invoice_line_id=l.id),0)
      <>CASE WHEN doc.kind='sale' THEN -l.smallest_quantity ELSE l.smallest_quantity END
   OR COALESCE((SELECT sum(m.cost_base) FROM stock_movements m WHERE m.company_id=l.company_id AND m.invoice_line_id=l.id),0)
      <>CASE WHEN doc.kind='sale' THEN -l.cost_base ELSE l.cost_base END
 )) THEN RAISE EXCEPTION 'Invoice totals, direction and stock sources must be consistent' USING ERRCODE='23514'; END IF;
 main_amount=abs(CASE WHEN doc.kind='sale' THEN doc.gross ELSE doc.total END);
 IF main_amount=0 THEN
   IF doc.financial_document_id IS NOT NULL THEN RAISE EXCEPTION 'Zero monetary effect must not invent a journal' USING ERRCODE='23514'; END IF;
 ELSE
   IF doc.financial_document_id IS NULL OR NOT EXISTS(SELECT 1 FROM financial_documents d WHERE d.company_id=doc.company_id AND d.id=doc.financial_document_id
     AND d.status='posted' AND d.currency_id=doc.currency_id AND d.base_currency_id=doc.base_currency_id AND d.exchange_rate=doc.exchange_rate
     AND d.branch_id=doc.branch_id AND d.document_date=doc.document_date AND d.total_debit=main_amount) THEN
     RAISE EXCEPTION 'Invoice monetary journal must be posted and match its snapshots' USING ERRCODE='23514';
   END IF;
 END IF;
 IF doc.total=0 THEN
   IF EXISTS(SELECT 1 FROM financial_document_lines WHERE company_id=doc.company_id AND document_id=doc.financial_document_id AND account_id=doc.counterparty_account_id) THEN
     RAISE EXCEPTION 'Zero invoice net must not charge or refund the counterparty' USING ERRCODE='23514';
   END IF;
 ELSIF NOT EXISTS(SELECT 1 FROM financial_document_lines WHERE company_id=doc.company_id AND document_id=doc.financial_document_id
   AND account_id=doc.counterparty_account_id AND debit+credit=abs(doc.total) AND base_debit+base_credit=abs(doc.base_total)) THEN
   RAISE EXCEPTION 'Invoice counterparty effect must match its exact net' USING ERRCODE='23514';
 END IF;
 IF doc.kind='sale' AND sums.cost_base<>0 THEN
   IF doc.cost_document_id IS NULL OR NOT EXISTS(SELECT 1 FROM financial_documents WHERE company_id=doc.company_id AND id=doc.cost_document_id
      AND status='posted' AND currency_id=doc.base_currency_id AND branch_id=doc.branch_id AND document_date=doc.document_date AND total_debit=abs(sums.cost_base)) THEN
     RAISE EXCEPTION 'Sales inventory cost must have its posted base-currency journal' USING ERRCODE='23514';
   END IF;
 ELSIF doc.cost_document_id IS NOT NULL THEN RAISE EXCEPTION 'Invoice has an unexpected cost journal' USING ERRCODE='23514'; END IF;
 variance=sums.cost_base-doc.base_total;
 IF doc.kind='purchase' AND variance<>0 THEN
   IF doc.variance_document_id IS NULL OR NOT EXISTS(SELECT 1 FROM financial_documents WHERE company_id=doc.company_id AND id=doc.variance_document_id
      AND status='posted' AND currency_id=doc.base_currency_id AND branch_id=doc.branch_id AND document_date=doc.document_date AND total_debit=abs(variance)) THEN
     RAISE EXCEPTION 'Purchase inventory valuation variance must have a posted base-currency journal' USING ERRCODE='23514';
   END IF;
 ELSIF doc.variance_document_id IS NOT NULL THEN RAISE EXCEPTION 'Invoice has an unexpected variance journal' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
