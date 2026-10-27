-- A bulk historical import keeps operational stock deltas and valuation intact.
-- Reconcile its full history once at finalization, while the owning company is
-- unavailable to ordinary requests. Other postings retain the existing checks.
CREATE FUNCTION assert_stock_integrity(p_company integer,p_item integer)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  pool record;
  aggregate_balance numeric;
  aggregate_value numeric;
  invalid_batches boolean;
BEGIN
  SELECT quantity_smallest,value_base INTO pool
  FROM stock_item_valuations
  WHERE company_id=p_company AND item_id=p_item;

  -- Read each authoritative source once. Grouping movements also retains a
  -- zero-net batch: a historical movement still requires its balance row.
  WITH movement_batches AS MATERIALIZED (
    SELECT location_id,batch_key,
      sum(quantity_smallest) AS quantity_smallest,sum(cost_base) AS value_base
    FROM stock_movements
    WHERE company_id=p_company AND item_id=p_item
    GROUP BY location_id,batch_key
  ), balances AS MATERIALIZED (
    SELECT location_id,batch_key,quantity_smallest
    FROM stock_balances
    WHERE company_id=p_company AND item_id=p_item
  )
  SELECT
    COALESCE((SELECT sum(quantity_smallest) FROM balances),0),
    COALESCE((SELECT sum(value_base) FROM movement_batches),0),
    EXISTS (
      SELECT 1 FROM balances b FULL JOIN movement_batches m
        USING(location_id,batch_key)
      WHERE b.location_id IS NULL
        OR b.quantity_smallest<>COALESCE(m.quantity_smallest,0)
    )
  INTO aggregate_balance,aggregate_value,invalid_batches;

  IF pool IS NULL OR pool.quantity_smallest<>aggregate_balance
    OR pool.value_base<>aggregate_value OR invalid_batches THEN
    RAISE EXCEPTION 'Stock balances, valuation and movements must reconcile atomically'
      USING ERRCODE='23514';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION check_stock_integrity() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE scope_company integer; scope_item integer;
BEGIN
  scope_company:=COALESCE(NEW.company_id,OLD.company_id);
  scope_item:=COALESCE(NEW.item_id,OLD.item_id);
  IF legacy_import_is_deferred(scope_company) THEN
    INSERT INTO legacy_import_dirty_items(company_id,item_id)
      VALUES(scope_company,scope_item) ON CONFLICT DO NOTHING;
    RETURN NULL;
  END IF;
  PERFORM assert_stock_integrity(scope_company,scope_item);
  RETURN NULL;
END $$;
