-- Fix 2026-11-04: the public invoice customer-correction endpoint existed
-- but a preexisting posted-invoice trigger rejected every UPDATE.
--
-- Only the approved customer snapshot columns of a POSTED SALE can change,
-- and only inside a transaction explicitly scoped to that company/invoice.
-- All amounts, line items, accounting, stock, payment and metadata remain
-- immutable. No past invoices or financial rows are rewritten by migration.
CREATE OR REPLACE FUNCTION protect_operational_history()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Operational history cannot be deleted' USING ERRCODE='23514';
  END IF;

  IF TG_TABLE_NAME='invoices' AND OLD.financial_document_id IS NOT NULL THEN
    IF TG_OP='UPDATE'
      AND OLD.kind='sale' AND NEW.kind='sale'
      AND current_setting('alraesy.sale_customer_snapshot_update',true)
        = OLD.company_id::text || ':' || OLD.id::text
      AND (to_jsonb(NEW) - 'sale_customer_id' - 'sale_customer_number' - 'sale_customer_name')
          = (to_jsonb(OLD) - 'sale_customer_id' - 'sale_customer_number' - 'sale_customer_name')
    THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Posted invoices are immutable' USING ERRCODE='23514';
  END IF;

  IF TG_TABLE_NAME='invoice_lines' AND TG_OP<>'INSERT'
    AND EXISTS(
      SELECT 1 FROM invoices
      WHERE company_id=OLD.company_id AND id=OLD.invoice_id
        AND financial_document_id IS NOT NULL
    )
  THEN
    RAISE EXCEPTION 'Posted invoice lines are immutable' USING ERRCODE='23514';
  END IF;
  IF TG_TABLE_NAME='invoice_lines'
    AND EXISTS(
      SELECT 1 FROM invoices
      WHERE company_id=NEW.company_id AND id=NEW.invoice_id
        AND financial_document_id IS NOT NULL
    )
  THEN
    RAISE EXCEPTION 'Posted invoice lines are immutable' USING ERRCODE='23514';
  END IF;
  IF TG_TABLE_NAME='stock_movements' THEN
    RAISE EXCEPTION 'Stock movements are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
