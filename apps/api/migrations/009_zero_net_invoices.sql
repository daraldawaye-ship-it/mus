-- Finalization is independent of the presence of a monetary journal.
-- Existing posted documents retain every historical snapshot and financial link.
DROP TRIGGER invoices_history ON invoices;
ALTER TABLE invoices ADD COLUMN posted boolean NOT NULL DEFAULT false;
ALTER TABLE invoices ADD COLUMN is_return boolean NOT NULL DEFAULT false;
UPDATE invoices SET posted=true,is_return=(total<0);
-- Flush the existing deferred invoice checks before further ALTER TABLE statements.
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
ALTER TABLE invoices DROP CONSTRAINT invoices_total_check;
ALTER TABLE invoices DROP CONSTRAINT invoices_base_total_check;
ALTER TABLE invoices DROP CONSTRAINT invoices_check1;
ALTER TABLE invoices ADD CONSTRAINT invoices_direction_check CHECK (
  (NOT is_return AND gross>=0 AND discount>=0 AND total>=0 AND base_total>=0)
  OR (is_return AND gross<=0 AND discount<=0 AND total<=0 AND base_total<=0)
);
ALTER TABLE invoices ADD CONSTRAINT invoices_zero_base_check CHECK (
  (total=0 AND base_total=0) OR (total<>0 AND base_total<>0)
);
CREATE INDEX stock_movements_invoice_source ON stock_movements(company_id,invoice_line_id) WHERE invoice_line_id IS NOT NULL;
CREATE INDEX stock_movements_return_source ON stock_movements(company_id,original_movement_id) WHERE original_movement_id IS NOT NULL;

CREATE OR REPLACE FUNCTION protect_operational_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Operational history cannot be deleted' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='invoices' THEN
   IF TG_OP='INSERT' THEN
     -- Preserve old paid-invoice writers during a rolling deployment.
     NEW.is_return=NEW.is_return OR NEW.gross<0 OR NEW.total<0;
   ELSE
     IF OLD.posted THEN RAISE EXCEPTION 'Posted invoices are immutable' USING ERRCODE='23514'; END IF;
     IF NEW.financial_document_id IS NOT NULL THEN NEW.posted=true; END IF;
   END IF;
 ELSIF TG_TABLE_NAME='invoice_lines' THEN
   IF TG_OP<>'INSERT' THEN
     IF EXISTS(SELECT 1 FROM invoices WHERE company_id=OLD.company_id AND id=OLD.invoice_id AND posted) THEN
       RAISE EXCEPTION 'Posted invoice lines are immutable' USING ERRCODE='23514';
     END IF;
   END IF;
   IF EXISTS(SELECT 1 FROM invoices WHERE company_id=NEW.company_id AND id=NEW.invoice_id AND posted) THEN
     RAISE EXCEPTION 'Posted invoice lines are immutable' USING ERRCODE='23514';
   END IF;
 ELSIF TG_TABLE_NAME='stock_movements' THEN
   IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Stock movements are immutable' USING ERRCODE='23514'; END IF;
   IF NEW.invoice_id IS NOT NULL THEN
     IF EXISTS(SELECT 1 FROM invoices WHERE company_id=NEW.company_id AND id=NEW.invoice_id AND posted)
       OR NOT EXISTS(SELECT 1 FROM invoice_lines WHERE company_id=NEW.company_id AND id=NEW.invoice_line_id AND invoice_id=NEW.invoice_id) THEN
       RAISE EXCEPTION 'Invoice stock movements require their unposted source line' USING ERRCODE='23514';
     END IF;
   ELSIF EXISTS(SELECT 1 FROM audit_events WHERE company_id=NEW.company_id AND target_type='stockOperation' AND target_id=NEW.operation_id) THEN
     RAISE EXCEPTION 'Posted stock operations cannot receive new movements' USING ERRCODE='23514';
   END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER invoices_history BEFORE INSERT OR UPDATE OR DELETE ON invoices FOR EACH ROW EXECUTE FUNCTION protect_operational_history();
DROP TRIGGER stock_movements_history ON stock_movements;
CREATE TRIGGER stock_movements_history BEFORE INSERT OR UPDATE OR DELETE ON stock_movements FOR EACH ROW EXECUTE FUNCTION protect_operational_history();

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
 IF doc.kind='purchase' AND doc.is_return AND variance<>0 THEN
   IF doc.variance_document_id IS NULL OR NOT EXISTS(SELECT 1 FROM financial_documents WHERE company_id=doc.company_id AND id=doc.variance_document_id
      AND status='posted' AND currency_id=doc.base_currency_id AND branch_id=doc.branch_id AND document_date=doc.document_date AND total_debit=abs(variance)) THEN
     RAISE EXCEPTION 'Purchase return variance must have its posted base-currency journal' USING ERRCODE='23514';
   END IF;
 ELSIF doc.variance_document_id IS NOT NULL THEN RAISE EXCEPTION 'Invoice has an unexpected variance journal' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
