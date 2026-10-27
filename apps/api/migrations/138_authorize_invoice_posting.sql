-- Explicit user authorization on 2026-10-27: post invoices only while all
-- unrelated automation and projections remain paused. Preserve failed source
-- rows for manual correction, as requested, and never replay completed rows.
DO $authorize_invoice_posting$
DECLARE approved_run legacy_import_runs%ROWTYPE;
BEGIN
  SELECT * INTO approved_run FROM legacy_import_runs
  WHERE company_id=2 AND idempotency_key='f03ead4a-40d9-4713-811c-6a366b7ec6c8'
    AND source_system='dar-aldawa-legacy-2026-10' AND status='paused'
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF NOT (SELECT paused FROM automation_database_pause WHERE singleton) THEN
    RAISE EXCEPTION 'Invoice-only posting requires database projections to remain paused';
  END IF;
  UPDATE legacy_import_runs SET status='running',phase='importing',error_message=NULL,
    updated_at=clock_timestamp()
  WHERE company_id=approved_run.company_id AND idempotency_key=approved_run.idempotency_key;
  INSERT INTO audit_events(actor_id,actor_name,scope,company_id,action,target_type,target_id,before_value,after_value)
  SELECT u.id,u.name,'company',2,'company.transactions.bulk-authorized-posting','company',2,
    jsonb_build_object('status',approved_run.status,'imported',approved_run.imported),
    jsonb_build_object('status','running','idempotencyKey',approved_run.idempotency_key,
      'databaseAutomationPaused',true,'automaticRebuild',false)
  FROM users u WHERE u.id=approved_run.created_by;
END $authorize_invoice_posting$;
