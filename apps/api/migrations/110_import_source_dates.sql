-- Explicit owner-authorized correction of imported document dates only.
-- Transaction-local target rows bind each permitted update to its original and
-- source date. Every other column and ordinary immutability guard is preserved.
CREATE TABLE transaction_source_date_repairs (
 company_id integer NOT NULL REFERENCES companies(id),
 idempotency_key uuid NOT NULL,
 created_by integer NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 request_payload jsonb NOT NULL,
 result jsonb NOT NULL,
 PRIMARY KEY(company_id,idempotency_key)
);
CREATE TRIGGER transaction_source_date_repair_immutable BEFORE UPDATE OR DELETE ON transaction_source_date_repairs
 FOR EACH ROW EXECUTE FUNCTION immutable_company_transaction_reset();

CREATE FUNCTION source_date_change_allowed(p_company integer,p_table text,p_id integer,p_old date,p_new date)
RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
 IF p_company::text IS DISTINCT FROM current_setting('tijara.source_date_company',true)
    OR txid_current()::text IS DISTINCT FROM current_setting('tijara.source_date_txid',true)
    OR to_regclass('pg_temp.tijara_source_date_targets') IS NULL THEN RETURN false; END IF;
 RETURN EXISTS(SELECT 1 FROM pg_temp.tijara_source_date_targets t
   WHERE t.company_id=p_company AND t.table_name=p_table AND t.id=p_id
     AND t.original_date=p_old AND t.source_date=p_new);
END $$;

CREATE OR REPLACE FUNCTION protect_financial_document() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN

 IF TG_OP='UPDATE' AND TG_TABLE_NAME IN ('invoices','financial_documents','stock_movements') THEN
   IF NEW.document_date IS DISTINCT FROM OLD.document_date
     AND (to_jsonb(NEW)-'document_date')=(to_jsonb(OLD)-'document_date')
     AND source_date_change_allowed(OLD.company_id,TG_TABLE_NAME,OLD.id,OLD.document_date,NEW.document_date)
   THEN RETURN NEW; END IF;
 END IF;
 IF TG_OP='DELETE' AND transaction_reset_company_allowed(OLD.company_id) THEN RETURN OLD; END IF;
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Financial documents cannot be deleted' USING ERRCODE='23514';
  END IF;
  IF ROW(NEW.company_id,NEW.id,NEW.number,NEW.created_by,NEW.created_at,NEW.idempotency_key,NEW.creation_payload)
    IS DISTINCT FROM ROW(OLD.company_id,OLD.id,OLD.number,OLD.created_by,OLD.created_at,OLD.idempotency_key,OLD.creation_payload) THEN
    RAISE EXCEPTION 'Financial identity is immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.status<>'draft' AND NEW IS DISTINCT FROM OLD THEN
    IF NOT (OLD.status='posted' AND NEW.status='reversed' AND NEW.reversal_document_id IS NOT NULL
      AND NEW.revision=OLD.revision+1 AND
      (to_jsonb(NEW)-ARRAY['status','revision','reversal_document_id'])=(to_jsonb(OLD)-ARRAY['status','revision','reversal_document_id'])) THEN
      RAISE EXCEPTION 'Posted financial document is immutable' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION protect_operational_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN

 IF TG_OP='UPDATE' AND TG_TABLE_NAME IN ('invoices','financial_documents','stock_movements') THEN
   IF NEW.document_date IS DISTINCT FROM OLD.document_date
     AND (to_jsonb(NEW)-'document_date')=(to_jsonb(OLD)-'document_date')
     AND source_date_change_allowed(OLD.company_id,TG_TABLE_NAME,OLD.id,OLD.document_date,NEW.document_date)
   THEN RETURN NEW; END IF;
 END IF;
 IF TG_OP='DELETE' AND transaction_reset_company_allowed(OLD.company_id) THEN RETURN OLD; END IF;
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
