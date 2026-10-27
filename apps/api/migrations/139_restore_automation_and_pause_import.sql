-- Explicit owner request: stop invoice posting, restore all recorded automation
-- and reopen the website, then resume posting separately after verification.
ALTER TABLE legacy_import_runs ADD COLUMN IF NOT EXISTS defer_projections boolean NOT NULL DEFAULT true;

-- Existing runs keep the original deferred behavior. The restored company run
-- uses normal per-document calculations; final rebuilding still has its trusted
-- context so one-time reconciliation remains possible.
CREATE OR REPLACE FUNCTION legacy_import_is_deferred(p_company integer)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS(SELECT 1 FROM legacy_import_runs
    WHERE company_id=p_company AND status IN ('running','rebuilding')
      AND (defer_projections OR status='rebuilding')
      AND idempotency_key::text=current_setting('alraesy.legacy_import_run',true))
$$;

DO $restore_and_pause$
DECLARE approved_run legacy_import_runs%ROWTYPE; affected record; dirty_count integer;
BEGIN
  -- Use the worker's own lock: any in-flight atomic batch finishes first.
  PERFORM pg_advisory_xact_lock(hashtext(current_schema()||':legacy-import-worker'),2);
  PERFORM id FROM companies WHERE id=2 FOR UPDATE;
  SELECT * INTO approved_run FROM legacy_import_runs
  WHERE company_id=2 AND idempotency_key='f03ead4a-40d9-4713-811c-6a366b7ec6c8'
    AND source_system='dar-aldawa-legacy-2026-10' AND status<>'completed'
  FOR UPDATE;
  -- Fresh installations/local fixtures have no authorized historical run.
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE legacy_import_runs SET status='paused',updated_at=clock_timestamp()
    WHERE company_id=2 AND idempotency_key=approved_run.idempotency_key;
  PERFORM restore_database_automation();

  -- Catch up derived rows skipped during the full pause before opening reads or
  -- starting inventory notifications. This never creates invoices or journals.
  PERFORM set_config('alraesy.legacy_import_run',approved_run.idempotency_key::text,true);
  UPDATE legacy_import_runs SET status='rebuilding',phase='restoring_automation'
    WHERE company_id=2 AND idempotency_key=approved_run.idempotency_key;
  SELECT count(*) INTO dirty_count FROM legacy_import_dirty_items WHERE company_id=2;
  PERFORM finalize_legacy_import_projections(2);
  SET CONSTRAINTS ALL IMMEDIATE;
  FOR affected IN SELECT item_id FROM legacy_import_dirty_items WHERE company_id=2 ORDER BY item_id
  LOOP PERFORM assert_stock_integrity(2,affected.item_id); END LOOP;
  DELETE FROM legacy_import_dirty_items WHERE company_id=2;
  UPDATE legacy_import_runs SET status='paused',phase='importing',defer_projections=false,
    error_message=NULL,updated_at=clock_timestamp()
    WHERE company_id=2 AND idempotency_key=approved_run.idempotency_key;
  INSERT INTO audit_events(actor_id,actor_name,scope,company_id,action,target_type,target_id,before_value,after_value)
  SELECT u.id,u.name,'company',2,'company.automation.restored-import-paused','company',2,
    jsonb_build_object('status',approved_run.status,'imported',approved_run.imported),
    jsonb_build_object('status','paused','idempotencyKey',approved_run.idempotency_key,
      'databaseAutomationPaused',false,'deferProjections',false,'reconciledItems',dirty_count)
  FROM users u WHERE u.id=approved_run.created_by;
END $restore_and_pause$;
