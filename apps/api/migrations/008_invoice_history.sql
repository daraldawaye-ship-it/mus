-- Table-specific branches avoid dereferencing fields absent from other trigger records.
CREATE OR REPLACE FUNCTION protect_operational_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Operational history cannot be deleted' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='invoices' THEN
   IF OLD.financial_document_id IS NOT NULL THEN RAISE EXCEPTION 'Posted invoices are immutable' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='invoice_lines' THEN
   IF TG_OP<>'INSERT' THEN
     IF EXISTS(SELECT 1 FROM invoices WHERE company_id=OLD.company_id AND id=OLD.invoice_id AND financial_document_id IS NOT NULL) THEN RAISE EXCEPTION 'Posted invoice lines are immutable' USING ERRCODE='23514'; END IF;
   END IF;
   IF EXISTS(SELECT 1 FROM invoices WHERE company_id=NEW.company_id AND id=NEW.invoice_id AND financial_document_id IS NOT NULL) THEN RAISE EXCEPTION 'Posted invoice lines are immutable' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='stock_movements' THEN
   RAISE EXCEPTION 'Stock movements are immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
