-- Explicit temporary stop requested by the owner, including table-side
-- automatic calculations. Preserve source history and every integrity guard.
CREATE TABLE IF NOT EXISTS automation_database_pause (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  paused boolean NOT NULL,
  paused_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  restored_at timestamptz
);
INSERT INTO automation_database_pause(singleton,paused) VALUES(true,true)
  ON CONFLICT(singleton) DO UPDATE SET paused=true,restored_at=NULL;
CREATE TABLE IF NOT EXISTS automation_paused_triggers (
  schema_name text NOT NULL,table_name text NOT NULL,trigger_name text NOT NULL,
  original_enabled text NOT NULL CHECK(original_enabled IN ('O','D','A','R')),
  PRIMARY KEY(schema_name,table_name,trigger_name)
);
CREATE TABLE IF NOT EXISTS automation_paused_functions (
  schema_name text NOT NULL,function_name text NOT NULL,identity_arguments text NOT NULL,
  original_definition text NOT NULL,result_type text NOT NULL,
  PRIMARY KEY(schema_name,function_name,identity_arguments)
);

DO $pause$
DECLARE entry record; definition text; prologue text;
BEGIN
  FOR entry IN
    SELECT n.nspname,c.relname,t.tgname,t.tgenabled::text AS original_enabled
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=current_schema() AND NOT t.tgisinternal AND t.tgconstraint=0
    AND t.tgname=ANY(ARRAY[
      'item_statistics_new','item_statistics_balance','item_statistics_movement',
      'item_statistics_invoice','item_statistics_location','item_statistics_count_operation',
      'item_statistics_negative_balance','item_counts_on_adjustment','item_counts_on_date_change',
      'item_daily_activity_invoice_posted','item_daily_activity_sale_rankings','item_purchase_price_on_post',
      'item_comp_stock_changed','item_comp_master_changed','item_comp_threshold_changed',
      'item_comp_daily_inserted','item_comp_daily_updated','item_comp_daily_deleted',
      'accounts_statistics_init','companies_account_balance_source',
      'financial_documents_account_balances','financial_lines_account_balances_deleted',
      'finance_settings_account_balances','company_transaction_resets_balance_source',
      'invoices_account_operation_statistics','items_account_stock_statistics',
      'valuations_account_stock_statistics','invoice_promote_item_supplier'
    ]) ORDER BY c.relname,t.tgname
  LOOP
    INSERT INTO automation_paused_triggers VALUES(entry.nspname,entry.relname,entry.tgname,entry.original_enabled)
      ON CONFLICT DO NOTHING;
    EXECUTE format('ALTER TABLE %I.%I DISABLE TRIGGER %I',entry.nspname,entry.relname,entry.tgname);
  END LOOP;
  FOR entry IN
    SELECT p.oid,n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) AS args,
      pg_get_function_result(p.oid) AS result_type
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    JOIN pg_language l ON l.oid=p.prolang
    WHERE n.nspname=current_schema() AND l.lanname='plpgsql'
      AND p.prorettype IN ('void'::regtype,'boolean'::regtype)
      AND p.proname=ANY(ARRAY[
        'refresh_item_statistics','refresh_item_negative_stock','refresh_item_adjustment_counts',
        'apply_item_statistics_stock_delta','refresh_item_purchase_price_day',
        'refresh_composition_summary','refresh_composition_daily_date','rebuild_composition_daily',
        'refresh_changed_composition_daily_scopes','prepare_item_sale_rankings','apply_item_sale_ranking_delta',
        'initialize_account_statistics','invalidate_account_balance_statistics',
        'invalidate_company_account_balance_statistics','invalidate_account_operation_statistics',
        'invalidate_account_stock_statistics','refresh_account_balance_statistics',
        'refresh_account_activity_statistics','refresh_account_stock_statistics'
      ]) ORDER BY p.proname,p.oid
  LOOP
    definition:=pg_get_functiondef(entry.oid);
    INSERT INTO automation_paused_functions VALUES(entry.nspname,entry.proname,entry.args,definition,entry.result_type)
      ON CONFLICT DO NOTHING;
    IF position('DATABASE_AUTOMATION_PAUSED' IN definition)>0 THEN CONTINUE; END IF;
    prologue:=E'\n  -- DATABASE_AUTOMATION_PAUSED: explicit owner-requested stop.\n'
      ||'  IF EXISTS(SELECT 1 FROM automation_database_pause WHERE singleton AND paused) THEN '
      ||CASE WHEN entry.result_type='boolean' THEN 'RETURN false;' ELSE 'RETURN;' END
      ||E' END IF;\n';
    IF definition !~ E'\\mBEGIN\\M' THEN RAISE EXCEPTION 'Cannot pause function %',entry.proname; END IF;
    EXECUTE regexp_replace(definition,E'\\mBEGIN\\M','BEGIN'||prologue);
  END LOOP;
END $pause$;

-- A saved, explicit recovery operation. It does NOT start jobs or rebuild data.
CREATE OR REPLACE FUNCTION restore_database_automation()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE entry record; mode text;
BEGIN
  PERFORM singleton FROM automation_database_pause WHERE singleton FOR UPDATE;
  IF NOT EXISTS(SELECT 1 FROM automation_database_pause WHERE singleton AND paused) THEN RETURN; END IF;
  FOR entry IN SELECT * FROM automation_paused_functions ORDER BY schema_name,function_name,identity_arguments
  LOOP EXECUTE entry.original_definition; END LOOP;
  FOR entry IN SELECT * FROM automation_paused_triggers ORDER BY schema_name,table_name,trigger_name
  LOOP
    mode:=CASE entry.original_enabled WHEN 'O' THEN 'ENABLE' WHEN 'D' THEN 'DISABLE'
      WHEN 'A' THEN 'ENABLE ALWAYS' WHEN 'R' THEN 'ENABLE REPLICA' END;
    EXECUTE format('ALTER TABLE %I.%I %s TRIGGER %I',entry.schema_name,entry.table_name,mode,entry.trigger_name);
  END LOOP;
  UPDATE automation_database_pause SET paused=false,restored_at=clock_timestamp() WHERE singleton;
END $$;
REVOKE ALL ON FUNCTION restore_database_automation() FROM PUBLIC;
