-- Explicit manual raw-table transfer only. No posting service, triggers or calculations.
CREATE TABLE raw_invoice_transfer_batches(
 company_id integer NOT NULL REFERENCES companies(id),batch_key uuid NOT NULL,
 source_system text NOT NULL,requested_count integer NOT NULL CHECK(requested_count>0),
 copied_invoices integer NOT NULL DEFAULT 0,copied_lines integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(company_id,batch_key)
);
CREATE TABLE raw_transferred_invoices(
 company_id integer NOT NULL REFERENCES companies(id),source_system text NOT NULL,source_id text NOT NULL,
 posting_date date NOT NULL,source_document jsonb NOT NULL,request_hash text NOT NULL,batch_key uuid NOT NULL,
 PRIMARY KEY(company_id,source_system,source_id),
 FOREIGN KEY(company_id,batch_key) REFERENCES raw_invoice_transfer_batches(company_id,batch_key)
);
CREATE TABLE raw_transferred_invoice_lines(
 company_id integer NOT NULL,source_system text NOT NULL,source_id text NOT NULL,
 line_number bigint NOT NULL,source_line jsonb NOT NULL,
 PRIMARY KEY(company_id,source_system,source_id,line_number),
 FOREIGN KEY(company_id,source_system,source_id)
 REFERENCES raw_transferred_invoices(company_id,source_system,source_id)
);
CREATE FUNCTION transfer_raw_invoice_table(p_company integer,p_source text,p_batch uuid,p_count integer)
RETURNS jsonb LANGUAGE plpgsql AS $copy$
DECLARE previous raw_invoice_transfer_batches%ROWTYPE; copied integer; line_count integer; result jsonb;
BEGIN
 IF p_count<1 OR p_count>100000 THEN RAISE EXCEPTION 'Invalid raw transfer count' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtext(current_schema()||':raw-invoice-transfer'),p_company);
 SELECT * INTO previous FROM raw_invoice_transfer_batches WHERE company_id=p_company AND batch_key=p_batch;
 IF FOUND THEN
   IF previous.source_system<>p_source OR previous.requested_count<>p_count THEN
     RAISE EXCEPTION 'Raw transfer key already used for a different request' USING ERRCODE='23514';
   END IF;
   RETURN jsonb_build_object('batchKey',p_batch,'companyId',p_company,'sourceSystem',p_source,
     'copiedInvoices',previous.copied_invoices,'copiedLines',previous.copied_lines,'replayed',true);
 END IF;
 INSERT INTO raw_invoice_transfer_batches(company_id,batch_key,source_system,requested_count)
 VALUES(p_company,p_batch,p_source,p_count);
 INSERT INTO raw_transferred_invoices(company_id,source_system,source_id,posting_date,source_document,request_hash,batch_key)
 SELECT s.company_id,s.source_system,s.source_id,s.posting_date,s.source_document,s.request_hash,p_batch
 FROM legacy_import_staging s WHERE s.company_id=p_company AND s.source_system=p_source AND s.source_kind='invoice'
   AND NOT EXISTS(SELECT 1 FROM transaction_source_imports m WHERE m.company_id=s.company_id
     AND m.source_system=s.source_system AND m.source_kind='invoice' AND m.source_id=s.source_id)
   AND NOT EXISTS(SELECT 1 FROM raw_transferred_invoices r WHERE r.company_id=s.company_id
     AND r.source_system=s.source_system AND r.source_id=s.source_id)
 ORDER BY s.posting_date,s.source_id LIMIT p_count;
 GET DIAGNOSTICS copied=ROW_COUNT;
 IF copied<>p_count THEN RAISE EXCEPTION 'Not enough new raw invoices for the requested batch: % of %',copied,p_count USING ERRCODE='23514'; END IF;
 INSERT INTO raw_transferred_invoice_lines(company_id,source_system,source_id,line_number,source_line)
 SELECT i.company_id,i.source_system,i.source_id,l.ordinality,l.value
 FROM raw_transferred_invoices i CROSS JOIN LATERAL
 jsonb_array_elements(i.source_document->'payload'->'lines') WITH ORDINALITY l(value,ordinality)
 WHERE i.company_id=p_company AND i.batch_key=p_batch;
 GET DIAGNOSTICS line_count=ROW_COUNT;
 UPDATE raw_invoice_transfer_batches SET copied_invoices=copied,copied_lines=line_count
 WHERE company_id=p_company AND batch_key=p_batch;
 result:=jsonb_build_object('batchKey',p_batch,'companyId',p_company,'sourceSystem',p_source,
   'copiedInvoices',copied,'copiedLines',line_count,'replayed',false);
 RETURN result;
END $copy$;
REVOKE ALL ON FUNCTION transfer_raw_invoice_table(integer,text,uuid,integer) FROM PUBLIC;
-- This bounded copy is the user's explicit request. Global workers/database
-- calculations remain paused; it is not an automatic import-resume control.
DO $manual_copy$
BEGIN
 IF EXISTS(SELECT 1 FROM legacy_import_staging WHERE company_id=2
   AND source_system='dar-aldawa-legacy-2026-10' AND source_kind='invoice') THEN
   PERFORM transfer_raw_invoice_table(2,'dar-aldawa-legacy-2026-10','36a2be4d-0430-4e7f-97e3-b2619fe2cc33'::uuid,5000);
 END IF;
END $manual_copy$;
