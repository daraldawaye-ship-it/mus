-- Historical import runs preserve operational stock, valuation, journals and
-- all integrity guards. Only rebuildable read projections are deferred. The
-- trusted transaction-local run context is validated by migration 130; ordinary
-- writes retain exactly the existing trigger implementations.
-- Add a narrow early return to the existing trigger bodies rather than copying
-- older implementations of those functions. Replacing their bodies retains the
-- function OIDs used by all current triggers. No trigger is disabled, including
-- foreign keys, immutable history and financial/stock consistency guards.
DO $install_import_projection_guards$
DECLARE
  function_name text;
  definition text;
  prologue text;
  guarded_definition text;
BEGIN
  FOREACH function_name IN ARRAY ARRAY[
    'refresh_item_statistics_row',
    'refresh_invoice_item_statistics',
    'add_posted_invoice_to_item_daily_activity',
    'capture_item_purchase_price_facts',
    'update_item_negative_stock',
    'update_item_sale_rankings',
    'composition_stock_stats_changed',
    'invalidate_financial_document_account_balances',
    'invalidate_invoice_account_operation_statistics',
    'invalidate_valuation_supplier_stock_statistics',
    'invalidate_item_supplier_stock_statistics'
  ] LOOP
    SELECT pg_get_functiondef(p.oid) INTO STRICT definition
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    JOIN pg_language l ON l.oid=p.prolang
    WHERE n.nspname=current_schema() AND p.proname=function_name
      AND p.pronargs=0 AND p.prorettype='trigger'::regtype
      AND l.lanname='plpgsql';

    prologue := E'\n  IF legacy_import_is_deferred(COALESCE(NEW.company_id,OLD.company_id)) THEN\n';
    IF function_name='refresh_item_statistics_row' THEN
      prologue := prologue || $guard$
    IF TG_TABLE_NAME='items' THEN
      INSERT INTO legacy_import_dirty_items(company_id,item_id)
        VALUES(COALESCE(NEW.company_id,OLD.company_id),COALESCE(NEW.id,OLD.id))
        ON CONFLICT DO NOTHING;
    ELSE
      INSERT INTO legacy_import_dirty_items(company_id,item_id)
        VALUES(COALESCE(NEW.company_id,OLD.company_id),COALESCE(NEW.item_id,OLD.item_id))
        ON CONFLICT DO NOTHING;
    END IF;
$guard$;
    ELSIF function_name='refresh_invoice_item_statistics' THEN
      prologue := prologue || $guard$
    INSERT INTO legacy_import_dirty_items(company_id,item_id)
      SELECT NEW.company_id,l.item_id FROM invoice_lines l
      WHERE l.company_id=NEW.company_id AND l.invoice_id=NEW.id
      GROUP BY l.item_id ORDER BY l.item_id ON CONFLICT DO NOTHING;
$guard$;
    END IF;
    prologue := prologue || E'    RETURN NULL;\n  END IF;\n';
    guarded_definition := regexp_replace(
      definition, E'\\mBEGIN\\M', 'BEGIN' || prologue);
    IF guarded_definition=definition THEN
      RAISE EXCEPTION 'No function body found while guarding %',function_name;
    END IF;
    EXECUTE guarded_definition;
  END LOOP;
END $install_import_projection_guards$;

-- Statement-level composition updates may be invoked by the final set-based
-- daily rebuild. Suppress their cascading scans until its final explicit pass.
CREATE OR REPLACE FUNCTION refresh_changed_composition_daily_scopes(p_scopes jsonb)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE changed record;
BEGIN
  -- A final import rebuild contains just its company. Avoid looping through
  -- every item/day composition scope when that entire company is deferred.
  IF NOT EXISTS (
    SELECT 1 FROM (
      SELECT DISTINCT company_id FROM jsonb_to_recordset(p_scopes)
        AS scope(company_id integer,composition_id integer,document_date date)
    ) companies WHERE NOT legacy_import_is_deferred(companies.company_id)
  ) THEN RETURN; END IF;
  FOR changed IN
    SELECT DISTINCT company_id,composition_id,document_date
    FROM jsonb_to_recordset(p_scopes)
      AS scope(company_id integer,composition_id integer,document_date date)
    ORDER BY company_id,composition_id,document_date
  LOOP
    IF NOT legacy_import_is_deferred(changed.company_id) THEN
      PERFORM refresh_composition_daily_date(
        changed.company_id,changed.composition_id,changed.document_date);
    END IF;
  END LOOP;
  FOR changed IN
    SELECT DISTINCT company_id,composition_id
    FROM jsonb_to_recordset(p_scopes)
      AS scope(company_id integer,composition_id integer,document_date date)
    ORDER BY company_id,composition_id
  LOOP
    IF NOT legacy_import_is_deferred(changed.company_id) THEN
      PERFORM refresh_composition_summary(changed.company_id,changed.composition_id);
    END IF;
  END LOOP;
END $$;

-- Run once inside the closing import transaction, keeping its trusted run
-- context and company lock until rebuilding and the run receipt are committed.
-- The source tables, historical snapshots, quantities and amounts are read only.
-- A rollback retains the dirty scopes for a later retry.
CREATE FUNCTION finalize_legacy_import_projections(p_company integer)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE affected record;
BEGIN
  IF NOT legacy_import_is_deferred(p_company) THEN
    RAISE EXCEPTION 'An active historical import context is required to rebuild projections'
      USING ERRCODE='42501';
  END IF;
  PERFORM id FROM companies WHERE id=p_company FOR UPDATE;

  -- Source stock balances and immutable movements remain authoritative during
  -- import. Rebuild each affected card once, including negative-location flags
  -- and the pre-existing physical-count history.
  FOR affected IN SELECT item_id FROM legacy_import_dirty_items
    WHERE company_id=p_company ORDER BY item_id
  LOOP
    PERFORM refresh_item_statistics(p_company,affected.item_id);
    PERFORM refresh_item_negative_stock(p_company,affected.item_id);
    PERFORM refresh_item_adjustment_counts(p_company,affected.item_id);
  END LOOP;

  DELETE FROM item_daily_activity d USING legacy_import_dirty_items changed
    WHERE changed.company_id=p_company AND d.company_id=changed.company_id
      AND d.item_id=changed.item_id;
  WITH per_invoice AS (
    SELECT i.id,i.kind,i.document_date,l.item_id,
      count(*) FILTER(WHERE l.smallest_quantity>0) AS positive_lines,
      count(*) FILTER(WHERE l.smallest_quantity<0) AS negative_lines,
      COALESCE(sum(l.smallest_quantity) FILTER(WHERE l.smallest_quantity>0),0) AS positive_quantity,
      -COALESCE(sum(l.smallest_quantity) FILTER(WHERE l.smallest_quantity<0),0) AS negative_quantity
    FROM legacy_import_dirty_items changed
    JOIN invoice_lines l ON l.company_id=changed.company_id AND l.item_id=changed.item_id
    JOIN invoices i ON i.company_id=l.company_id AND i.id=l.invoice_id
    WHERE changed.company_id=p_company AND i.posted
    GROUP BY i.id,i.kind,i.document_date,l.item_id
  ) INSERT INTO item_daily_activity(company_id,item_id,document_date,
    sale_invoices,sale_return_invoices,sale_lines,sale_return_lines,sale_quantity,sale_return_quantity,
    purchase_invoices,purchase_return_invoices,purchase_lines,purchase_return_lines,purchase_quantity,purchase_return_quantity)
  SELECT p_company,item_id,document_date,
    count(*) FILTER(WHERE kind='sale' AND positive_lines>0),count(*) FILTER(WHERE kind='sale' AND negative_lines>0),
    COALESCE(sum(positive_lines) FILTER(WHERE kind='sale'),0),COALESCE(sum(negative_lines) FILTER(WHERE kind='sale'),0),
    COALESCE(sum(positive_quantity) FILTER(WHERE kind='sale'),0),COALESCE(sum(negative_quantity) FILTER(WHERE kind='sale'),0),
    count(*) FILTER(WHERE kind='purchase' AND positive_lines>0),count(*) FILTER(WHERE kind='purchase' AND negative_lines>0),
    COALESCE(sum(positive_lines) FILTER(WHERE kind='purchase'),0),COALESCE(sum(negative_lines) FILTER(WHERE kind='purchase'),0),
    COALESCE(sum(positive_quantity) FILTER(WHERE kind='purchase'),0),COALESCE(sum(negative_quantity) FILTER(WHERE kind='purchase'),0)
  FROM per_invoice GROUP BY item_id,document_date;

  -- Purchase facts are immutable-line projections. Preserve existing accepted
  -- facts and insert the missing positive purchase lines in one statement.
  INSERT INTO item_purchase_price_facts(company_id,item_id,invoice_line_id,invoice_id,
    document_date,base_currency_id,invoice_number,supplier_account_id,supplier_account_name,
    original_currency_code,original_unit_name,original_unit_price,unit_multiplier,base_price_smallest)
  SELECT i.company_id,l.item_id,l.id,i.id,i.document_date,i.base_currency_id,
    i.number,i.supplier_account_id,i.supplier_account_name,i.currency_code,l.unit_name,l.unit_price,
    CASE WHEN l.unit=1 THEN l.factor2::numeric*l.factor3::numeric WHEN l.unit=2 THEN l.factor3::numeric ELSE 1::numeric END,
    round(l.unit_price*i.exchange_rate/
      (CASE WHEN l.unit=1 THEN l.factor2::numeric*l.factor3::numeric WHEN l.unit=2 THEN l.factor3::numeric ELSE 1::numeric END),30)
  FROM legacy_import_dirty_items changed
  JOIN invoice_lines l ON l.company_id=changed.company_id AND l.item_id=changed.item_id
  JOIN invoices i ON i.company_id=l.company_id AND i.id=l.invoice_id
  WHERE changed.company_id=p_company AND i.posted AND i.kind='purchase' AND l.smallest_quantity>0
  ON CONFLICT(company_id,invoice_line_id) DO NOTHING;

  DELETE FROM item_purchase_price_daily d USING legacy_import_dirty_items changed
    WHERE changed.company_id=p_company AND d.company_id=changed.company_id
      AND d.item_id=changed.item_id;
  INSERT INTO item_purchase_price_daily(company_id,item_id,document_date,base_currency_id,
    min_line_id,max_line_id,latest_line_id,min_price,max_price)
  SELECT f.company_id,f.item_id,f.document_date,f.base_currency_id,
    (array_agg(f.invoice_line_id ORDER BY f.base_price_smallest ASC,f.invoice_line_id DESC))[1],
    (array_agg(f.invoice_line_id ORDER BY f.base_price_smallest DESC,f.invoice_line_id DESC))[1],
    (array_agg(f.invoice_line_id ORDER BY f.invoice_id DESC,f.invoice_line_id DESC))[1],
    min(f.base_price_smallest),max(f.base_price_smallest)
  FROM legacy_import_dirty_items changed JOIN item_purchase_price_facts f
    ON f.company_id=changed.company_id AND f.item_id=changed.item_id
  WHERE changed.company_id=p_company
  GROUP BY f.company_id,f.item_id,f.document_date,f.base_currency_id;

  -- Daily rebuilding deliberately bypasses incremental ranking deltas. Replace
  -- only the affected items for every currently prepared ranking date.
  DELETE FROM item_sale_rankings r USING legacy_import_dirty_items changed
    WHERE changed.company_id=p_company AND r.company_id=changed.company_id
      AND r.item_id=changed.item_id;
  INSERT INTO item_sale_rankings(company_id,item_id,as_of_date,net_sale_invoices)
  SELECT d.company_id,d.item_id,ready.as_of_date,
    sum(d.sale_invoices::numeric-d.sale_return_invoices)
  FROM legacy_import_dirty_items changed JOIN item_daily_activity d
    ON d.company_id=changed.company_id AND d.item_id=changed.item_id
  JOIN item_sale_ranking_days ready ON d.document_date BETWEEN
    (ready.as_of_date-INTERVAL '1 month'+INTERVAL '1 day')::date AND ready.as_of_date
  WHERE changed.company_id=p_company
  GROUP BY d.company_id,d.item_id,ready.as_of_date
  HAVING sum(d.sale_invoices::numeric-d.sale_return_invoices)<>0;

  FOR affected IN
    SELECT DISTINCT i.composition_id FROM legacy_import_dirty_items changed
    JOIN items i ON i.company_id=changed.company_id AND i.id=changed.item_id
    WHERE changed.company_id=p_company AND i.composition_id IS NOT NULL
    ORDER BY i.composition_id
  LOOP
    PERFORM rebuild_composition_daily(p_company,affected.composition_id);
    PERFORM refresh_composition_summary(p_company,affected.composition_id);
  END LOOP;

  -- Financial balances are lazy projections; invalidate their source revisions
  -- once after the import instead of once for each invoice journal and line.
  PERFORM invalidate_company_account_balance_statistics(p_company);
  -- The caller validates operational stock for these same items before it
  -- clears the scopes and commits the completed run receipt.
END $$;
