-- The customer-correction endpoint must work on posted sales, but a later
-- commerce migration (009_zero_net_invoices.sql) protects posted invoices
-- with OLD.posted rather than financial_document_id.
--
-- Patch precisely the existing live trigger definition in-place. Do NOT
-- replace protect_operational_history wholesale: it also guards invoice
-- INSERT/POST status, invoice lines and stock movement INSERT provenance.
-- Audit and concurrency checks remain in routes-commerce.ts.
DO $migration$
DECLARE
  source text;
  changed text;
  old_term text := $old$IF OLD.posted THEN RAISE EXCEPTION 'Posted invoices are immutable' USING ERRCODE='23514'; END IF;$old$;
  new_term text := $new$IF OLD.posted THEN
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
     END IF;$new$;
BEGIN
  SELECT pg_get_functiondef('protect_operational_history()'::regprocedure)
    INTO source;
  IF source IS NULL OR strpos(source,old_term)=0
     OR strpos(source,'alraesy.sale_customer_snapshot_update')>0
  THEN
    RAISE EXCEPTION 'Unexpected posted-invoice history guard; review before permitting customer edits';
  END IF;
  changed := replace(source,old_term,new_term);
  EXECUTE changed;
END
$migration$;
