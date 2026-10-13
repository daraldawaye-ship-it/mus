-- Direction belongs to an invoice row. A single posted document may combine
-- ordinary and returned items and may have a positive, negative or zero net.
-- Historical invoices and their snapshots remain untouched.
ALTER TABLE invoices DROP CONSTRAINT invoices_direction_check;
ALTER TABLE invoice_lines ADD CONSTRAINT invoice_lines_signed_amounts_check CHECK (
  abs(discount)<=abs(gross)
  AND ((quantity>0 AND gross>=0 AND discount>=0 AND total>=0 AND base_total>=0 AND cost_base>=0 AND commission_amount>=0)
    OR (quantity<0 AND gross<=0 AND discount<=0 AND total<=0 AND base_total<=0 AND cost_base<=0 AND commission_amount<=0))
  AND (original_line_id IS NOT NULL OR quantity>0 OR (discount=0 AND commission_amount=0))
);

CREATE OR REPLACE FUNCTION protect_operational_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Operational history cannot be deleted' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='invoices' THEN
   IF TG_OP<>'INSERT' THEN
     IF OLD.posted THEN RAISE EXCEPTION 'Posted invoices are immutable' USING ERRCODE='23514'; END IF;
     IF NEW.financial_document_id IS NOT NULL THEN NEW.posted=true; END IF;
     IF NEW.posted THEN
       -- A negative net or first row never turns positive rows into returns.
       SELECT COALESCE(bool_and(quantity<0),false) INTO NEW.is_return
         FROM invoice_lines WHERE company_id=NEW.company_id AND invoice_id=NEW.id;
     END IF;
   END IF;
 ELSIF TG_TABLE_NAME='invoice_lines' THEN
   IF TG_OP<>'INSERT' AND EXISTS(SELECT 1 FROM invoices WHERE company_id=OLD.company_id AND id=OLD.invoice_id AND posted) THEN
     RAISE EXCEPTION 'Posted invoice lines are immutable' USING ERRCODE='23514';
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

CREATE OR REPLACE FUNCTION check_invoice_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE doc invoices%ROWTYPE; sums record; main_amount numeric; variance_amount numeric;
  receipt_variance numeric; return_variance numeric; setting inventory_settings%ROWTYPE; discount_account integer;
BEGIN
 IF TG_TABLE_NAME='invoices' THEN SELECT * INTO doc FROM invoices WHERE company_id=NEW.company_id AND id=NEW.id;
 ELSE SELECT * INTO doc FROM invoices WHERE company_id=NEW.company_id AND id=NEW.invoice_id; END IF;
 SELECT count(*) AS n,sum(gross) AS gross,sum(discount) AS discount,sum(total) AS total,sum(base_total) AS base_total,sum(cost_base) AS cost_base,
   bool_and(quantity<0) AS all_return
 INTO sums FROM invoice_lines WHERE company_id=doc.company_id AND invoice_id=doc.id;
 IF NOT doc.posted OR sums.n<1 OR doc.is_return IS DISTINCT FROM sums.all_return OR
 ROW(sums.gross,sums.discount,sums.total,sums.base_total) IS DISTINCT FROM ROW(doc.gross,doc.discount,doc.total,doc.base_total)
 OR EXISTS(SELECT 1 FROM invoice_lines l WHERE l.company_id=doc.company_id AND l.invoice_id=doc.id AND (
   l.gross<>l.quantity*l.unit_price
   OR l.smallest_quantity<>l.quantity*(CASE WHEN l.unit=1 THEN l.factor2::numeric*l.factor3 WHEN l.unit=2 THEN l.factor3 ELSE 1 END)
   OR COALESCE((SELECT sum(m.quantity_smallest) FROM stock_movements m WHERE m.company_id=l.company_id AND m.invoice_line_id=l.id),0)
      <>CASE WHEN doc.kind='sale' THEN -l.smallest_quantity ELSE l.smallest_quantity END
   OR COALESCE((SELECT sum(m.cost_base) FROM stock_movements m WHERE m.company_id=l.company_id AND m.invoice_line_id=l.id),0)
      <>CASE WHEN doc.kind='sale' THEN -l.cost_base ELSE l.cost_base END
   OR EXISTS(SELECT 1 FROM stock_movements m WHERE m.company_id=l.company_id AND m.invoice_line_id=l.id AND (
       m.invoice_id<>doc.id OR m.item_id<>l.item_id OR m.location_id<>doc.location_id OR m.document_date<>doc.document_date
       OR m.kind<>CASE WHEN doc.kind='sale' THEN CASE WHEN l.quantity>0 THEN 'sale' ELSE 'sales_return' END
          ELSE CASE WHEN l.quantity>0 THEN 'purchase' ELSE 'purchase_return' END END
       OR (m.quantity_smallest>0)<>(CASE WHEN doc.kind='sale' THEN l.quantity<0 ELSE l.quantity>0 END)
       OR (m.original_movement_id IS NOT NULL AND (doc.kind<>'sale' OR l.quantity>=0 OR l.original_line_id IS NULL))
       OR (doc.kind='sale' AND l.original_line_id IS NOT NULL AND NOT EXISTS(
         SELECT 1 FROM stock_movements o WHERE o.company_id=m.company_id AND o.id=m.original_movement_id
           AND o.invoice_line_id=l.original_line_id AND o.kind='sale' AND o.item_id=m.item_id
           AND o.location_id=m.location_id AND o.batch_key=m.batch_key AND o.quantity_smallest<0
           AND (SELECT COALESCE(sum(r.quantity_smallest),0) FROM stock_movements r WHERE r.company_id=o.company_id AND r.original_movement_id=o.id)<=-o.quantity_smallest
           AND (SELECT COALESCE(sum(r.cost_base),0) FROM stock_movements r WHERE r.company_id=o.company_id AND r.original_movement_id=o.id)<=-o.cost_base
       ))
   ))
   OR (l.original_line_id IS NOT NULL AND NOT EXISTS(
      SELECT 1 FROM invoice_lines o JOIN invoices original ON original.company_id=o.company_id AND original.id=o.invoice_id
      WHERE o.company_id=l.company_id AND o.id=l.original_line_id AND o.quantity>0 AND original.posted
        AND l.quantity<0 AND o.item_id=l.item_id AND o.unit=l.unit AND o.unit_price=l.unit_price
        AND ROW(o.factor2,o.factor3,o.purchase_factor) IS NOT DISTINCT FROM ROW(l.factor2,l.factor3,l.purchase_factor)
        AND o.expiry_date IS NOT DISTINCT FROM l.expiry_date
        AND original.kind=doc.kind AND original.currency_id=doc.currency_id
        AND original.counterparty_account_id=doc.counterparty_account_id AND original.document_date<=doc.document_date
        AND (doc.kind<>'sale' OR original.location_id=doc.location_id)
        AND (SELECT COALESCE(sum(-r.quantity),0) FROM invoice_lines r WHERE r.company_id=o.company_id AND r.original_line_id=o.id)<=o.quantity
        AND (SELECT COALESCE(sum(-r.discount),0) FROM invoice_lines r WHERE r.company_id=o.company_id AND r.original_line_id=o.id)<=o.discount
        AND l.commission_rate=o.commission_rate
        AND (SELECT COALESCE(sum(-r.commission_amount),0) FROM invoice_lines r WHERE r.company_id=o.company_id AND r.original_line_id=o.id)<=o.commission_amount
   ))
 )) THEN RAISE EXCEPTION 'Invoice row amounts, direction and stock sources must be consistent' USING ERRCODE='23514'; END IF;

 SELECT * INTO setting FROM inventory_settings WHERE company_id=doc.company_id;
 SELECT account_id INTO discount_account FROM account_links WHERE company_id=doc.company_id AND purpose='discountAllowed';
 -- The debit side may exceed abs(gross) when discount and net have opposite
 -- signs. The signed account effects, rather than document direction, balance.
 main_amount=CASE WHEN doc.kind='sale' THEN (abs(doc.gross)+abs(doc.discount)+abs(doc.total))/2 ELSE abs(doc.total) END;
 IF main_amount=0 THEN
   IF doc.financial_document_id IS NOT NULL THEN RAISE EXCEPTION 'Zero monetary effect must not invent a journal' USING ERRCODE='23514'; END IF;
 ELSE
   IF doc.financial_document_id IS NULL OR NOT EXISTS(SELECT 1 FROM financial_documents d WHERE d.company_id=doc.company_id AND d.id=doc.financial_document_id
     AND d.status='posted' AND d.currency_id=doc.currency_id AND d.base_currency_id=doc.base_currency_id AND d.exchange_rate=doc.exchange_rate
     AND d.branch_id=doc.branch_id AND d.document_date=doc.document_date AND d.total_debit=main_amount) THEN
     RAISE EXCEPTION 'Invoice monetary journal must be posted and match its snapshots' USING ERRCODE='23514';
   END IF;
 END IF;
 IF doc.financial_document_id IS NOT NULL AND EXISTS(
   WITH expected AS (
     SELECT doc.counterparty_account_id AS account_id,CASE WHEN doc.kind='sale' THEN doc.total ELSE -doc.total END AS effect
     UNION ALL SELECT CASE WHEN doc.kind='sale' THEN setting.sales_account_id ELSE setting.inventory_account_id END,
       CASE WHEN doc.kind='sale' THEN -doc.gross ELSE doc.total END
     UNION ALL SELECT discount_account,CASE WHEN doc.kind='sale' THEN doc.discount ELSE 0 END
   ), amounts AS (
     SELECT account_id,sum(effect) AS effect FROM expected GROUP BY account_id HAVING sum(effect)<>0
   ), actual AS (
     SELECT account_id,sum(debit-credit) AS effect FROM financial_document_lines WHERE company_id=doc.company_id AND document_id=doc.financial_document_id GROUP BY account_id
   ) SELECT 1 FROM amounts FULL JOIN actual USING(account_id) WHERE amounts.effect IS DISTINCT FROM actual.effect
 ) THEN RAISE EXCEPTION 'Invoice journal accounts must match the signed sales or purchase effect' USING ERRCODE='23514'; END IF;
 IF doc.total=0 THEN
   IF EXISTS(SELECT 1 FROM financial_document_lines WHERE company_id=doc.company_id AND document_id=doc.financial_document_id AND account_id=doc.counterparty_account_id) THEN
     RAISE EXCEPTION 'Zero invoice net must not charge or refund the counterparty' USING ERRCODE='23514';
   END IF;
 ELSIF NOT EXISTS(SELECT 1 FROM financial_document_lines WHERE company_id=doc.company_id AND document_id=doc.financial_document_id
   AND account_id=doc.counterparty_account_id AND debit-credit=CASE WHEN doc.kind='sale' THEN doc.total ELSE -doc.total END
   AND base_debit-base_credit=CASE WHEN doc.kind='sale' THEN doc.base_total ELSE -doc.base_total END) THEN
   RAISE EXCEPTION 'Invoice counterparty effect must match its exact signed net' USING ERRCODE='23514';
 END IF;
 IF doc.kind='sale' AND sums.cost_base<>0 THEN
   IF doc.cost_document_id IS NULL OR NOT EXISTS(SELECT 1 FROM financial_documents WHERE company_id=doc.company_id AND id=doc.cost_document_id
      AND status='posted' AND currency_id=doc.base_currency_id AND branch_id=doc.branch_id AND document_date=doc.document_date AND total_debit=abs(sums.cost_base)) THEN
     RAISE EXCEPTION 'Sales inventory cost must have its posted base-currency journal' USING ERRCODE='23514';
   END IF;
 ELSIF doc.cost_document_id IS NOT NULL THEN RAISE EXCEPTION 'Invoice has an unexpected cost journal' USING ERRCODE='23514'; END IF;
 IF doc.cost_document_id IS NOT NULL AND EXISTS(
   WITH expected AS (
     SELECT setting.cogs_account_id AS account_id,sums.cost_base AS effect
     UNION ALL SELECT setting.inventory_account_id,-sums.cost_base
   ), actual AS (
     SELECT account_id,sum(debit-credit) AS effect FROM financial_document_lines WHERE company_id=doc.company_id AND document_id=doc.cost_document_id GROUP BY account_id
   ) SELECT 1 FROM expected FULL JOIN actual USING(account_id) WHERE expected.effect IS DISTINCT FROM actual.effect
 ) THEN RAISE EXCEPTION 'Sales cost accounts must match the signed inventory effect' USING ERRCODE='23514'; END IF;


 IF doc.kind='purchase' THEN
   SELECT COALESCE(sum(cost_base-base_total) FILTER(WHERE quantity>0),0),COALESCE(sum(cost_base-base_total) FILTER(WHERE quantity<0),0)
     INTO receipt_variance,return_variance FROM invoice_lines WHERE company_id=doc.company_id AND invoice_id=doc.id;
   -- Negative-stock receipt correction and return valuation use distinct
   -- counterpart accounts, even when their inventory differences cancel.
   variance_amount=(abs(receipt_variance+return_variance)+abs(receipt_variance)+abs(return_variance))/2;
   IF variance_amount<>0 THEN
     IF doc.variance_document_id IS NULL OR NOT EXISTS(SELECT 1 FROM financial_documents WHERE company_id=doc.company_id AND id=doc.variance_document_id
        AND status='posted' AND currency_id=doc.base_currency_id AND branch_id=doc.branch_id AND document_date=doc.document_date AND total_debit=variance_amount) THEN
       RAISE EXCEPTION 'Purchase inventory valuation differences require a posted base-currency journal' USING ERRCODE='23514';
     END IF;
     IF EXISTS(
       WITH expected AS (
         SELECT setting.inventory_account_id AS account_id,receipt_variance+return_variance AS effect
         UNION ALL SELECT setting.cogs_account_id,-receipt_variance
         UNION ALL SELECT CASE WHEN return_variance>0 THEN setting.surplus_account_id ELSE setting.shortage_account_id END,-return_variance
       ), amounts AS (
         SELECT account_id,sum(effect) AS effect FROM expected GROUP BY account_id HAVING sum(effect)<>0
       ), actual AS (
         SELECT account_id,sum(debit-credit) AS effect FROM financial_document_lines WHERE company_id=doc.company_id AND document_id=doc.variance_document_id GROUP BY account_id
       ) SELECT 1 FROM amounts FULL JOIN actual USING(account_id) WHERE amounts.effect IS DISTINCT FROM actual.effect
     ) THEN RAISE EXCEPTION 'Purchase variance accounts must match each signed row valuation' USING ERRCODE='23514'; END IF;
   ELSIF doc.variance_document_id IS NOT NULL THEN RAISE EXCEPTION 'Invoice has an unexpected variance journal' USING ERRCODE='23514'; END IF;
 ELSIF doc.variance_document_id IS NOT NULL THEN RAISE EXCEPTION 'Sales invoice has an unexpected variance journal' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
