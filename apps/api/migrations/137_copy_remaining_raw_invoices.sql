-- Explicit manual request: complete the raw table to cover ALL staged invoices.
-- Previously posted identities are included only as raw copies; no operation is replayed.
-- Existing raw copies are excluded. All jobs and database calculations remain paused.
DO $complete_raw_copy$
DECLARE needed integer; copied integer; line_count integer;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM legacy_import_staging WHERE company_id=2
   AND source_system='dar-aldawa-legacy-2026-10' AND source_kind='invoice') THEN RETURN; END IF;
 PERFORM pg_advisory_xact_lock(hashtext(current_schema()||':raw-invoice-transfer'),2);
 IF EXISTS(SELECT 1 FROM raw_invoice_transfer_batches WHERE company_id=2 AND batch_key='4b02a4bd-c9da-45f1-aa4f-9544b199e86c'::uuid) THEN RETURN; END IF;
 LOCK TABLE legacy_import_staging IN SHARE MODE;
 SELECT count(*)::integer INTO needed FROM legacy_import_staging s
 WHERE s.company_id=2 AND s.source_system='dar-aldawa-legacy-2026-10' AND s.source_kind='invoice'
 AND NOT EXISTS(SELECT 1 FROM raw_transferred_invoices r WHERE r.company_id=s.company_id
   AND r.source_system=s.source_system AND r.source_id=s.source_id);
 IF needed=0 THEN RETURN; END IF;
 INSERT INTO raw_invoice_transfer_batches(company_id,batch_key,source_system,requested_count)
 VALUES(2,'4b02a4bd-c9da-45f1-aa4f-9544b199e86c'::uuid,'dar-aldawa-legacy-2026-10',needed);
 INSERT INTO raw_transferred_invoices(company_id,source_system,source_id,posting_date,source_document,request_hash,batch_key)
 SELECT s.company_id,s.source_system,s.source_id,s.posting_date,s.source_document,s.request_hash,'4b02a4bd-c9da-45f1-aa4f-9544b199e86c'::uuid
 FROM legacy_import_staging s WHERE s.company_id=2 AND s.source_system='dar-aldawa-legacy-2026-10'
 AND s.source_kind='invoice' AND NOT EXISTS(SELECT 1 FROM raw_transferred_invoices r
   WHERE r.company_id=s.company_id AND r.source_system=s.source_system AND r.source_id=s.source_id)
 ORDER BY s.posting_date,s.source_id;
 GET DIAGNOSTICS copied=ROW_COUNT;
 IF copied<>needed THEN RAISE EXCEPTION 'Raw copy count changed during transfer' USING ERRCODE='23514'; END IF;
 INSERT INTO raw_transferred_invoice_lines(company_id,source_system,source_id,line_number,source_line)
 SELECT r.company_id,r.source_system,r.source_id,l.ordinality,l.value
 FROM raw_transferred_invoices r CROSS JOIN LATERAL
 jsonb_array_elements(r.source_document->'payload'->'lines') WITH ORDINALITY l(value,ordinality)
 WHERE r.company_id=2 AND r.batch_key='4b02a4bd-c9da-45f1-aa4f-9544b199e86c'::uuid;
 GET DIAGNOSTICS line_count=ROW_COUNT;
 UPDATE raw_invoice_transfer_batches SET copied_invoices=copied,copied_lines=line_count
 WHERE company_id=2 AND batch_key='4b02a4bd-c9da-45f1-aa4f-9544b199e86c'::uuid;
 IF EXISTS(SELECT 1 FROM legacy_import_staging s
   WHERE s.company_id=2 AND s.source_system='dar-aldawa-legacy-2026-10' AND s.source_kind='invoice'
   AND NOT EXISTS(SELECT 1 FROM raw_transferred_invoices r WHERE r.company_id=s.company_id
     AND r.source_system=s.source_system AND r.source_id=s.source_id)) THEN
   RAISE EXCEPTION 'Some staged invoices were not copied' USING ERRCODE='23514';
 END IF;
END $complete_raw_copy$;
