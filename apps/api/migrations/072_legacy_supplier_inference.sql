-- Advisory-only legacy supplier identification.
-- Stock movements and invoice/ledger history remain immutable; hypotheses live
-- in a separate table and never affect stock valuations or accounting.
ALTER TABLE items ADD COLUMN supplier_inferred boolean NOT NULL DEFAULT false;

CREATE TABLE stock_movement_supplier_hints (
  company_id integer NOT NULL,
  movement_id integer NOT NULL,
  supplier_account_id integer NOT NULL,
  supplier_account_code text NOT NULL,
  supplier_account_name text NOT NULL,
  inference_source text NOT NULL CHECK (inference_source IN ('invoice','prior_purchase','item_estimate')),
  inferred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id,movement_id),
  FOREIGN KEY (company_id,movement_id) REFERENCES stock_movements(company_id,id),
  FOREIGN KEY (company_id,supplier_account_id) REFERENCES accounts(company_id,id)
);
CREATE INDEX stock_movement_supplier_hints_by_account
 ON stock_movement_supplier_hints(company_id,supplier_account_id,movement_id);

-- Use the most recent RECEIVED purchase as a best-effort source for items
-- which have never had a supplier selected. An explicit manual choice wins.
-- Credit purchases lacking a supplier field may use their creditor account.
CREATE FUNCTION guess_item_source_suppliers() RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE updated_count bigint;
BEGIN
 WITH last_receipt AS (
   SELECT DISTINCT ON (m.company_id,m.item_id)
     m.company_id,m.item_id,
     COALESCE(supplier.id,creditor.id) AS account_id
   FROM stock_movements m
   JOIN invoices inv ON inv.company_id=m.company_id AND inv.id=m.invoice_id
     AND inv.kind='purchase' AND inv.posted
   LEFT JOIN accounts supplier ON supplier.company_id=inv.company_id
     AND supplier.id=inv.supplier_account_id
     AND supplier.kind='posting' AND supplier.category IN ('asset','liability')
     AND NOT supplier.cash_or_bank
   LEFT JOIN accounts creditor ON creditor.company_id=inv.company_id
     AND creditor.id=inv.counterparty_account_id
     AND creditor.kind='posting' AND creditor.category='liability'
     AND NOT creditor.cash_or_bank
   WHERE m.kind='purchase' AND m.quantity_smallest>0
     AND COALESCE(supplier.id,creditor.id) IS NOT NULL
   ORDER BY m.company_id,m.item_id,m.document_date DESC,m.id DESC
 ), updated AS (
   UPDATE items i SET supplier_account_id=r.account_id,supplier_inferred=true,
     revision=i.revision+1,updated_at=clock_timestamp()
   FROM last_receipt r
   WHERE i.company_id=r.company_id AND i.id=r.item_id
     AND i.supplier_account_id IS NULL
   RETURNING i.id
 )
 SELECT count(*) INTO updated_count FROM updated;
 RETURN updated_count;
END $$;

-- For each historical movement: the purchase invoice's supplier is strongest
-- evidence; otherwise the latest preceding received purchase is a guess.
-- If none precedes it, use the newly inferred current item supplier.
-- Only previously NULL movement snapshots are eligible; the source row
-- remains immutable, and repeating this function never changes existing hints.
CREATE FUNCTION guess_legacy_movement_suppliers() RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE inserted_count bigint;
BEGIN
 WITH evidence AS (
   SELECT m.company_id,m.item_id,m.id AS movement_id,m.kind,
     m.supplier_account_id AS permanent_supplier_id,
     CASE WHEN inv.kind='purchase'
       THEN COALESCE(supplier.id,creditor.id) ELSE NULL END AS invoice_supplier_id,
     CASE WHEN m.kind='purchase' AND m.quantity_smallest>0
       THEN COALESCE(supplier.id,creditor.id,m.supplier_account_id)
       ELSE NULL END AS received_supplier_id,
     CASE WHEN inv.kind='purchase' THEN inv.supplier_account_code ELSE NULL END AS invoice_supplier_code,
     CASE WHEN inv.kind='purchase' THEN inv.supplier_account_name ELSE NULL END AS invoice_supplier_name
   FROM stock_movements m
   LEFT JOIN invoices inv ON inv.company_id=m.company_id AND inv.id=m.invoice_id
     AND inv.posted
   LEFT JOIN accounts supplier ON supplier.company_id=inv.company_id
     AND supplier.id=inv.supplier_account_id AND supplier.kind='posting'
     AND supplier.category IN ('asset','liability') AND NOT supplier.cash_or_bank
   LEFT JOIN accounts creditor ON creditor.company_id=inv.company_id
     AND creditor.id=inv.counterparty_account_id
     AND creditor.kind='posting' AND creditor.category='liability'
     AND NOT creditor.cash_or_bank
 ), segment AS (
   SELECT e.*,count(e.received_supplier_id) OVER (
     PARTITION BY e.company_id,e.item_id ORDER BY e.movement_id
     ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
   ) AS supplier_segment
   FROM evidence e
 ), known AS (
   SELECT s.*,max(s.received_supplier_id) OVER (
     PARTITION BY s.company_id,s.item_id,s.supplier_segment
   ) AS preceding_supplier_id
   FROM segment s
 ), guesses AS (
   SELECT k.company_id,k.movement_id,
     CASE WHEN k.kind IN ('purchase','purchase_return') AND k.invoice_supplier_id IS NOT NULL
         THEN k.invoice_supplier_id
       ELSE COALESCE(k.preceding_supplier_id,i.supplier_account_id) END AS selected_supplier_id,
     CASE WHEN k.kind IN ('purchase','purchase_return') AND k.invoice_supplier_id IS NOT NULL
         THEN 'invoice'
       WHEN k.preceding_supplier_id IS NOT NULL THEN 'prior_purchase'
       ELSE 'item_estimate' END AS inference_source,
     k.invoice_supplier_code,k.invoice_supplier_name
   FROM known k JOIN items i ON i.company_id=k.company_id AND i.id=k.item_id
   WHERE k.permanent_supplier_id IS NULL
 ), inserted AS (
   INSERT INTO stock_movement_supplier_hints(
     company_id,movement_id,supplier_account_id,
     supplier_account_code,supplier_account_name,inference_source
   )
   SELECT g.company_id,g.movement_id,g.selected_supplier_id,
     CASE WHEN g.inference_source='invoice' THEN COALESCE(g.invoice_supplier_code,a.code)
       ELSE a.code END,
     CASE WHEN g.inference_source='invoice' THEN COALESCE(g.invoice_supplier_name,a.name)
       ELSE a.name END,
     g.inference_source
   FROM guesses g JOIN accounts a ON a.company_id=g.company_id
     AND a.id=g.selected_supplier_id
   ON CONFLICT (company_id,movement_id) DO NOTHING
   RETURNING movement_id
 )
 SELECT count(*) INTO inserted_count FROM inserted;
 RETURN inserted_count;
END $$;

-- Manual confirmation (or clearing) on the item card overrides a guess.
-- Older clients omitting supplierAccountId retain existing supplier/source.
-- Purchase auto-promotion below marks the source as factual, not inferred.
CREATE OR REPLACE FUNCTION promote_item_supplier_on_purchase() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.kind<>'purchase' OR NEW.supplier_account_id IS NULL
    OR NOT NEW.posted OR OLD.posted THEN RETURN NEW; END IF;

 UPDATE items i SET supplier_account_id=NEW.supplier_account_id,
   supplier_inferred=false,
   revision=i.revision+1,updated_at=clock_timestamp()
 FROM (
   SELECT l.item_id,
     sum(l.smallest_quantity) FILTER(WHERE l.smallest_quantity>0) AS purchased,
     sum(l.smallest_quantity) AS signed_total
   FROM invoice_lines l WHERE l.company_id=NEW.company_id AND l.invoice_id=NEW.id
   GROUP BY l.item_id
 ) lines
 JOIN stock_item_valuations v ON v.company_id=NEW.company_id AND v.item_id=lines.item_id
 WHERE i.company_id=NEW.company_id AND i.id=lines.item_id
   AND lines.purchased IS NOT NULL AND lines.purchased>0
   AND lines.purchased>(v.quantity_smallest-lines.signed_total)
   AND (i.supplier_account_id IS DISTINCT FROM NEW.supplier_account_id OR i.supplier_inferred)
   AND EXISTS(SELECT 1 FROM accounts a WHERE a.company_id=NEW.company_id
     AND a.id=NEW.supplier_account_id AND a.kind='posting'
     AND a.category IN('asset','liability') AND NOT a.cash_or_bank);
 RETURN NEW;
END $$;

SELECT guess_item_source_suppliers();
SELECT guess_legacy_movement_suppliers();
