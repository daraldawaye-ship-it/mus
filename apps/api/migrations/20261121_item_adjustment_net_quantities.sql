-- Cached signed physical-count quantity differences. Values are derived on the
-- item-options list from the saved quantities and the current item purchase price;
-- no financial value is stored here and no posted financial history is changed.
ALTER TABLE item_statistics
  ADD COLUMN IF NOT EXISTS adjustment_qty_since_display numeric(40,0) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS adjustment_qty_since_approval numeric(40,0) NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS stock_movements_adjustment_qty_window_idx
  ON stock_movements(company_id,item_id,created_at)
  WHERE kind IN ('adjustment_surplus','adjustment_shortage');

-- Rebuild a single item only when its administrative threshold changes.
-- Use exact server-stamped timestamps when known; legacy date-only records
-- retain date semantics rather than being assigned a fabricated clock time.
CREATE OR REPLACE FUNCTION refresh_item_adjustment_net_quantities(
  p_company integer, p_item integer
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE item_statistics s SET
    adjustment_qty_since_display = totals.display_qty,
    adjustment_qty_since_approval = totals.approval_qty,
    updated_at = clock_timestamp()
  FROM (
    SELECT i.company_id, i.id AS item_id,
      COALESCE(SUM(m.quantity_smallest) FILTER (WHERE
        (i.settlement_display_at IS NOT NULL AND m.created_at>=i.settlement_display_at)
        OR (i.settlement_display_at IS NULL AND i.settlement_display_date IS NOT NULL
          AND m.document_date>=i.settlement_display_date)
      ),0) AS display_qty,
      COALESCE(SUM(m.quantity_smallest) FILTER (WHERE
        (i.settlement_approval_at IS NOT NULL AND m.created_at>=i.settlement_approval_at)
        OR (i.settlement_approval_at IS NULL AND i.settlement_approval_date IS NOT NULL
          AND m.document_date>=i.settlement_approval_date)
      ),0) AS approval_qty
    FROM items i
    LEFT JOIN stock_movements m ON m.company_id=i.company_id AND m.item_id=i.id
      AND m.kind IN ('adjustment_surplus','adjustment_shortage')
    WHERE i.company_id=p_company AND i.id=p_item
    GROUP BY i.company_id,i.id
  ) totals
  WHERE s.company_id=totals.company_id AND s.item_id=totals.item_id;
END $$;

-- Update only the affected item inside the transaction that posts the count.
-- A zero-difference count has no movement and correctly contributes zero.
CREATE OR REPLACE FUNCTION increment_item_adjustment_net_quantities()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE item_statistics s SET
    adjustment_qty_since_display=s.adjustment_qty_since_display+
      CASE WHEN
        (i.settlement_display_at IS NOT NULL AND NEW.created_at>=i.settlement_display_at)
        OR (i.settlement_display_at IS NULL AND i.settlement_display_date IS NOT NULL
          AND NEW.document_date>=i.settlement_display_date)
      THEN NEW.quantity_smallest ELSE 0 END,
    adjustment_qty_since_approval=s.adjustment_qty_since_approval+
      CASE WHEN
        (i.settlement_approval_at IS NOT NULL AND NEW.created_at>=i.settlement_approval_at)
        OR (i.settlement_approval_at IS NULL AND i.settlement_approval_date IS NOT NULL
          AND NEW.document_date>=i.settlement_approval_date)
      THEN NEW.quantity_smallest ELSE 0 END,
    updated_at=clock_timestamp()
  FROM items i
  WHERE i.company_id=NEW.company_id AND i.id=NEW.item_id
    AND s.company_id=i.company_id AND s.item_id=i.id;
  RETURN NULL;
END $$;

CREATE TRIGGER item_adjustment_net_qty_on_movement
AFTER INSERT ON stock_movements FOR EACH ROW
WHEN (NEW.kind IN ('adjustment_surplus','adjustment_shortage'))
EXECUTE FUNCTION increment_item_adjustment_net_quantities();

CREATE OR REPLACE FUNCTION refresh_item_adjustment_net_quantities_on_date()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM refresh_item_adjustment_net_quantities(NEW.company_id,NEW.id);
  RETURN NULL;
END $$;
CREATE TRIGGER item_adjustment_net_qty_on_dates
AFTER UPDATE OF settlement_display_date,settlement_approval_date,
  settlement_display_at,settlement_approval_at ON items
FOR EACH ROW WHEN (
  OLD.settlement_display_date IS DISTINCT FROM NEW.settlement_display_date
  OR OLD.settlement_approval_date IS DISTINCT FROM NEW.settlement_approval_date
  OR OLD.settlement_display_at IS DISTINCT FROM NEW.settlement_display_at
  OR OLD.settlement_approval_at IS DISTINCT FROM NEW.settlement_approval_at
)
EXECUTE FUNCTION refresh_item_adjustment_net_quantities_on_date();

-- Reconcile once per Aden calendar day (including once at initial rollout).
-- This runs in the background worker, never when an item list is opened.
CREATE TABLE IF NOT EXISTS item_adjustment_quantity_reconcile_state(
  job_key text PRIMARY KEY,
  last_completed_on date NOT NULL
);

CREATE OR REPLACE FUNCTION prepare_item_adjustment_net_quantities()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  today_in_aden date := (clock_timestamp() AT TIME ZONE 'Asia/Aden')::date;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('item_adjustment_net_quantities'),1)
    THEN RETURN; END IF;
  IF EXISTS (
    SELECT 1 FROM item_adjustment_quantity_reconcile_state
    WHERE job_key='net_adjustment_qty' AND last_completed_on>=today_in_aden
  ) THEN RETURN; END IF;

  WITH totals AS (
    SELECT i.company_id,i.id AS item_id,
      COALESCE(SUM(m.quantity_smallest) FILTER (WHERE
        (i.settlement_display_at IS NOT NULL AND m.created_at>=i.settlement_display_at)
        OR (i.settlement_display_at IS NULL AND i.settlement_display_date IS NOT NULL
          AND m.document_date>=i.settlement_display_date)
      ),0) AS display_qty,
      COALESCE(SUM(m.quantity_smallest) FILTER (WHERE
        (i.settlement_approval_at IS NOT NULL AND m.created_at>=i.settlement_approval_at)
        OR (i.settlement_approval_at IS NULL AND i.settlement_approval_date IS NOT NULL
          AND m.document_date>=i.settlement_approval_date)
      ),0) AS approval_qty
    FROM items i
    LEFT JOIN stock_movements m ON m.company_id=i.company_id AND m.item_id=i.id
      AND m.kind IN ('adjustment_surplus','adjustment_shortage')
    GROUP BY i.company_id,i.id
  )
  UPDATE item_statistics s SET
    adjustment_qty_since_display=totals.display_qty,
    adjustment_qty_since_approval=totals.approval_qty,
    updated_at=clock_timestamp()
  FROM totals
  WHERE s.company_id=totals.company_id AND s.item_id=totals.item_id
    AND (s.adjustment_qty_since_display IS DISTINCT FROM totals.display_qty
      OR s.adjustment_qty_since_approval IS DISTINCT FROM totals.approval_qty);

  INSERT INTO item_adjustment_quantity_reconcile_state(job_key,last_completed_on)
    VALUES('net_adjustment_qty',today_in_aden)
  ON CONFLICT(job_key) DO UPDATE
    SET last_completed_on=EXCLUDED.last_completed_on;
END $$;

-- Historical backfill is derived only from immutable movement history.
SELECT prepare_item_adjustment_net_quantities();
