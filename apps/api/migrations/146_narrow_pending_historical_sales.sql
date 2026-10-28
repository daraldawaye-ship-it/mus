-- Owner requested a narrower remaining-sales window on 2026-10-28:
-- last three calendar months and ten days, inclusive from 2026-07-18.
-- All pending purchases and previously completed/failed/excluded sources stay intact.
DO $narrow_pending_sales$
DECLARE approved_run legacy_import_runs%ROWTYPE; excluded_count integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(current_schema()||':legacy-import-worker'),2);
  PERFORM id FROM companies WHERE id=2 FOR UPDATE;
  SELECT * INTO approved_run FROM legacy_import_runs
    WHERE company_id=2 AND idempotency_key='f03ead4a-40d9-4713-811c-6a366b7ec6c8'
      AND source_system='dar-aldawa-legacy-2026-10' FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  -- Retry of an applied scope reduction is read-only, including its audit event.
  IF approved_run.sales_from_date=DATE '2026-07-18' AND NOT EXISTS(
    SELECT 1 FROM legacy_import_staging
    WHERE company_id=2 AND source_system=approved_run.source_system AND source_kind='invoice'
      AND status='pending' AND posting_date<DATE '2026-07-18'
      AND source_document->'payload'->>'kind'='sale'
  ) THEN RETURN; END IF;
  IF approved_run.status<>'paused' THEN
    RAISE EXCEPTION 'Pause the authorized invoice run before changing its remaining scope';
  END IF;
  UPDATE legacy_import_staging SET status='excluded',
    error_message='[excluded_sales_window] Owner scope: pending sales before 2026-07-18 excluded; original source retained.',
    updated_at=clock_timestamp()
  WHERE company_id=2 AND source_system=approved_run.source_system AND source_kind='invoice'
    AND status='pending' AND posting_date<DATE '2026-07-18'
    AND source_document->'payload'->>'kind'='sale';
  GET DIAGNOSTICS excluded_count=ROW_COUNT;
  UPDATE legacy_import_runs SET excluded_documents=excluded_documents+excluded_count,
    sales_from_date=DATE '2026-07-18',updated_at=clock_timestamp()
  WHERE company_id=2 AND idempotency_key=approved_run.idempotency_key;
  INSERT INTO audit_events(actor_id,actor_name,scope,company_id,action,target_type,target_id,before_value,after_value)
  SELECT u.id,u.name,'company',2,'company.transactions.pending-sales-window','company',2,
    jsonb_build_object('status',approved_run.status,'excludedDocuments',approved_run.excluded_documents,
      'salesFromDate',approved_run.sales_from_date),
    jsonb_build_object('status','paused','excludedDocuments',approved_run.excluded_documents+excluded_count,
      'salesFromDate','2026-07-18','allPendingPurchasesRetained',true)
  FROM users u WHERE u.id=approved_run.created_by;
END $narrow_pending_sales$;
