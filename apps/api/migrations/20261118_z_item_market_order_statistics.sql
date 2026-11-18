-- Rebuildable request counters live in item_statistics, never in the item master.
-- Each export is unique by company/item/local-day; compare exact instants for purchases.
ALTER TABLE item_statistics
  ADD COLUMN market_order_days_30d integer NOT NULL DEFAULT 0 CHECK (market_order_days_30d >= 0),
  ADD COLUMN market_order_days_after_purchase_30d integer NOT NULL DEFAULT 0 CHECK (market_order_days_after_purchase_30d >= 0),
  ADD COLUMN market_order_last_purchase_at timestamptz,
  ADD COLUMN market_order_stats_day date;

CREATE INDEX IF NOT EXISTS stock_movements_market_purchase_at_idx
  ON stock_movements(company_id,item_id,created_at DESC,id DESC)
  WHERE kind='purchase' AND quantity_smallest > 0;

-- Update only the derived projection, scoped by company and selected item IDs.
-- "Last purchase" is the timestamp of the latest *posted* positive purchase stock movement,
-- ignoring superseded/cancelled purchase corrections. A back-dated document cannot
-- retroactively change the actual order of saved purchase and export events.
CREATE FUNCTION refresh_item_market_order_statistics(
  p_company integer,p_items integer[]
) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE touched integer := 0;
BEGIN
  WITH local_day AS (
    SELECT (clock_timestamp() AT TIME ZONE 'Asia/Aden')::date AS today
  ), affected AS (
    SELECT DISTINCT unnest(p_items) AS item_id
  ), computed AS (
    SELECT a.item_id,d.today,p.purchase_at,
      e.total_days,e.days_after_purchase
    FROM affected a CROSS JOIN local_day d
    LEFT JOIN LATERAL (
      SELECT m.created_at AS purchase_at
      FROM stock_movements m
      JOIN invoices i ON i.company_id=m.company_id AND i.id=m.invoice_id
      WHERE m.company_id=p_company AND m.item_id=a.item_id
        AND m.kind='purchase' AND m.quantity_smallest>0
        AND i.kind='purchase' AND i.posted
        AND NOT EXISTS (
          SELECT 1 FROM purchase_invoice_corrections pc
          WHERE pc.company_id=i.company_id
            AND (pc.original_id=i.id OR pc.reversal_id=i.id)
        )
      ORDER BY m.created_at DESC,m.id DESC LIMIT 1
    ) p ON true
    CROSS JOIN LATERAL (
      SELECT count(DISTINCT e.export_date)::integer AS total_days,
        (count(DISTINCT e.export_date) FILTER (
          WHERE p.purchase_at IS NULL OR e.exported_at>p.purchase_at
        ))::integer AS days_after_purchase
      FROM company_order_draft_exports e
      WHERE e.company_id=p_company AND e.item_id=a.item_id
        AND e.export_date BETWEEN d.today-29 AND d.today
    ) e
  ), updated AS (
    UPDATE item_statistics s SET
      market_order_days_30d=c.total_days,
      market_order_days_after_purchase_30d=c.days_after_purchase,
      market_order_last_purchase_at=c.purchase_at,
      market_order_stats_day=c.today,
      updated_at=clock_timestamp()
    FROM computed c
    WHERE s.company_id=p_company AND s.item_id=c.item_id
      AND (s.market_order_days_30d IS DISTINCT FROM c.total_days
        OR s.market_order_days_after_purchase_30d IS DISTINCT FROM c.days_after_purchase
        OR s.market_order_last_purchase_at IS DISTINCT FROM c.purchase_at
        OR s.market_order_stats_day IS DISTINCT FROM c.today)
    RETURNING s.item_id
  )
  SELECT count(*)::integer INTO touched FROM updated;
  RETURN touched;
END $$;

-- Statement-level trigger handles large print/PDF exports without a per-row query.
CREATE FUNCTION refresh_market_orders_after_export() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE scope record;
BEGIN
  FOR scope IN
    SELECT company_id,array_agg(DISTINCT item_id) AS item_ids
    FROM inserted_market_order_exports GROUP BY company_id
  LOOP
    PERFORM refresh_item_market_order_statistics(scope.company_id,scope.item_ids);
  END LOOP;
  RETURN NULL;
END $$;
CREATE TRIGGER company_market_order_statistics_insert
AFTER INSERT ON company_order_draft_exports
REFERENCING NEW TABLE AS inserted_market_order_exports
FOR EACH STATEMENT EXECUTE FUNCTION refresh_market_orders_after_export();

-- Refresh the affected product counters as part of posting a purchase,
-- not on sales or return invoices. Posting occurs after stock movements are saved.
CREATE FUNCTION refresh_market_orders_after_purchase() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item_ids integer[];
BEGIN
  SELECT array_agg(DISTINCT l.item_id) INTO item_ids
  FROM invoice_lines l
  WHERE l.company_id=NEW.company_id AND l.invoice_id=NEW.id AND l.quantity>0;
  IF item_ids IS NOT NULL THEN
    PERFORM refresh_item_market_order_statistics(NEW.company_id,item_ids);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER company_market_order_statistics_purchase
AFTER UPDATE OF posted ON invoices
FOR EACH ROW WHEN (NEW.kind='purchase' AND NEW.posted AND NOT OLD.posted)
EXECUTE FUNCTION refresh_market_orders_after_purchase();

-- Rollover the 30 local calendar days even for products with no new activity.
-- The worker calls this once/minute; the day checkpoint makes repeats a no-op.
CREATE TABLE item_market_order_statistics_days (
  day date PRIMARY KEY,
  processed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION prepare_item_market_order_statistics() RETURNS integer LANGUAGE plpgsql AS $$
DECLARE d date := (clock_timestamp() AT TIME ZONE 'Asia/Aden')::date;
  scope record;
  total integer := 0;
BEGIN
  INSERT INTO item_market_order_statistics_days(day) VALUES(d)
  ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN RETURN 0; END IF;
  FOR scope IN
    SELECT company_id,array_agg(item_id) AS item_ids FROM (
      SELECT company_id,item_id FROM company_order_draft_exports
        WHERE export_date BETWEEN d-29 AND d
      UNION
      SELECT company_id,item_id FROM item_statistics WHERE market_order_days_30d>0
    ) pending
    GROUP BY company_id
  LOOP
    total := total + refresh_item_market_order_statistics(scope.company_id,scope.item_ids);
  END LOOP;
  RETURN total;
END $$;
-- Initial reconciliation only touches derived statistics; never edits order or invoice history.
SELECT prepare_item_market_order_statistics();
