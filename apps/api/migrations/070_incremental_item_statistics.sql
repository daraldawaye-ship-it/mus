-- Keep the rebuildable projection, but maintain common writes incrementally.
-- All triggers below remain in the SAME transaction as stock/invoice posting.
-- refresh_item_statistics(...) is deliberately retained for explicit repair/backfills.

CREATE FUNCTION apply_item_statistics_stock_delta(
  p_company integer, p_item integer, p_location integer, p_delta numeric
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_delta = 0 THEN RETURN; END IF;
  INSERT INTO item_statistics(
    company_id,item_id,stock_total,stock_showroom,stock_warehouse
  )
  SELECT p_company,p_item,p_delta,
    CASE WHEN l.kind='showroom' THEN p_delta ELSE 0 END,
    CASE WHEN l.kind='warehouse' THEN p_delta ELSE 0 END
  FROM locations l WHERE l.company_id=p_company AND l.id=p_location
  ON CONFLICT(company_id,item_id) DO UPDATE SET
    stock_total=item_statistics.stock_total+EXCLUDED.stock_total,
    stock_showroom=item_statistics.stock_showroom+EXCLUDED.stock_showroom,
    stock_warehouse=item_statistics.stock_warehouse+EXCLUDED.stock_warehouse,
    updated_at=clock_timestamp();
END $$;

CREATE OR REPLACE FUNCTION refresh_item_statistics_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='items' THEN
    -- This only runs for a newly created item, with no historical activity.
    PERFORM refresh_item_statistics(NEW.company_id,NEW.id);
  ELSIF TG_TABLE_NAME='stock_balances' THEN
    IF TG_OP='INSERT' THEN
      PERFORM apply_item_statistics_stock_delta(
        NEW.company_id,NEW.item_id,NEW.location_id,NEW.quantity_smallest
      );
    ELSIF TG_OP='DELETE' THEN
      PERFORM apply_item_statistics_stock_delta(
        OLD.company_id,OLD.item_id,OLD.location_id,-OLD.quantity_smallest
      );
    ELSIF NEW.company_id=OLD.company_id
      AND NEW.item_id=OLD.item_id AND NEW.location_id=OLD.location_id THEN
      PERFORM apply_item_statistics_stock_delta(
        NEW.company_id,NEW.item_id,NEW.location_id,
        NEW.quantity_smallest-OLD.quantity_smallest
      );
    ELSE
      PERFORM apply_item_statistics_stock_delta(
        OLD.company_id,OLD.item_id,OLD.location_id,-OLD.quantity_smallest
      );
      PERFORM apply_item_statistics_stock_delta(
        NEW.company_id,NEW.item_id,NEW.location_id,NEW.quantity_smallest
      );
    END IF;
  ELSIF TG_TABLE_NAME='stock_movements' THEN
    INSERT INTO item_statistics(
      company_id,item_id,last_movement_id,last_adjustment_movement_id
    ) VALUES (
      NEW.company_id,NEW.item_id,NEW.id,
      CASE WHEN NEW.kind IN('adjustment_surplus','adjustment_shortage')
        THEN NEW.id ELSE NULL END
    )
    ON CONFLICT(company_id,item_id) DO UPDATE SET
      last_movement_id=GREATEST(item_statistics.last_movement_id,EXCLUDED.last_movement_id),
      last_adjustment_movement_id=GREATEST(
        item_statistics.last_adjustment_movement_id,EXCLUDED.last_adjustment_movement_id
      ),
      updated_at=clock_timestamp();
  END IF;
  RETURN NULL;
END $$;

-- Only one invoice-level update per item, regardless of its line count.
-- Latest is ordered by invoice ID and then by line number, just like rebuild.
CREATE OR REPLACE FUNCTION refresh_invoice_item_statistics() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.is_return THEN RETURN NULL; END IF;
  INSERT INTO item_statistics(company_id,item_id,last_sale_invoice_id,last_purchase_line_id)
  SELECT NEW.company_id,l.item_id,
    CASE WHEN NEW.kind='sale' THEN NEW.id ELSE NULL END,
    CASE WHEN NEW.kind='purchase'
      THEN (array_agg(l.id ORDER BY l.line_number DESC))[1] ELSE NULL END
  FROM invoice_lines l
  WHERE l.company_id=NEW.company_id AND l.invoice_id=NEW.id AND l.quantity>0
  GROUP BY l.item_id
  ON CONFLICT(company_id,item_id) DO UPDATE SET
    last_sale_invoice_id=GREATEST(
      item_statistics.last_sale_invoice_id,EXCLUDED.last_sale_invoice_id
    ),
    last_purchase_line_id=CASE
      WHEN EXCLUDED.last_purchase_line_id IS NULL
        THEN item_statistics.last_purchase_line_id
      WHEN item_statistics.last_purchase_line_id IS NULL
        THEN EXCLUDED.last_purchase_line_id
      WHEN (SELECT previous.invoice_id FROM invoice_lines previous
            WHERE previous.company_id=item_statistics.company_id
              AND previous.id=item_statistics.last_purchase_line_id) <= NEW.id
        THEN EXCLUDED.last_purchase_line_id
      ELSE item_statistics.last_purchase_line_id END,
    updated_at=clock_timestamp();
  RETURN NULL;
END $$;

-- A physical count is authoritative even when no stock movement was produced.
CREATE OR REPLACE FUNCTION refresh_item_statistics_after_count() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.creation_payload->>'itemId') ~ '^[1-9][0-9]{0,9}$'
    AND (NEW.creation_payload->>'itemId')::numeric <= 2147483647 THEN
    UPDATE item_statistics SET
      last_adjustment_operation_id=GREATEST(last_adjustment_operation_id,NEW.id),
      updated_at=clock_timestamp()
    WHERE company_id=NEW.company_id
      AND item_id=(NEW.creation_payload->>'itemId')::integer;
  END IF;
  RETURN NULL;
END $$;

-- Count additions in O(1); only a change to the two threshold dates needs
-- a historical recalculation using refresh_item_adjustment_counts(...).
CREATE OR REPLACE FUNCTION update_item_adjustment_counts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='items' THEN
    PERFORM refresh_item_adjustment_counts(NEW.company_id,NEW.id);
  ELSIF (NEW.creation_payload->>'itemId') ~ '^[1-9][0-9]{0,9}$'
      AND (NEW.creation_payload->>'itemId')::numeric <= 2147483647 THEN
    UPDATE item_statistics s SET
      adjustments_all_time=s.adjustments_all_time+1,
      adjustments_since_approval=s.adjustments_since_approval+
        CASE WHEN i.settlement_approval_date IS NOT NULL
          AND NEW.document_date>=i.settlement_approval_date THEN 1 ELSE 0 END,
      adjustments_since_display=s.adjustments_since_display+
        CASE WHEN i.settlement_display_date IS NOT NULL
          AND NEW.document_date>=i.settlement_display_date THEN 1 ELSE 0 END,
      last_showroom_adjustment_at=CASE
        WHEN l.kind='showroom'
          THEN GREATEST(s.last_showroom_adjustment_at,NEW.created_at)
        ELSE s.last_showroom_adjustment_at END,
      updated_at=clock_timestamp()
    FROM items i
    LEFT JOIN locations l ON l.company_id=i.company_id
      AND l.id=CASE
        WHEN (NEW.creation_payload->>'locationId') ~ '^[1-9][0-9]{0,9}$'
         AND (NEW.creation_payload->>'locationId')::numeric<=2147483647
        THEN (NEW.creation_payload->>'locationId')::integer
        ELSE NULL END
    WHERE i.company_id=NEW.company_id
      AND i.id=(NEW.creation_payload->>'itemId')::integer
      AND s.company_id=i.company_id AND s.item_id=i.id;
  END IF;
  RETURN NULL;
END $$;

-- Changing location classification moves existing stock between buckets,
-- without scanning invoice, movement or count history.
CREATE OR REPLACE FUNCTION refresh_location_item_statistics() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE item_statistics s SET
    stock_showroom=s.stock_showroom+
      CASE WHEN NEW.kind='showroom' THEN b.quantity ELSE -b.quantity END,
    stock_warehouse=s.stock_warehouse+
      CASE WHEN NEW.kind='warehouse' THEN b.quantity ELSE -b.quantity END,
    updated_at=clock_timestamp()
  FROM (
    SELECT item_id,sum(quantity_smallest) AS quantity
    FROM stock_balances
    WHERE company_id=NEW.company_id AND location_id=NEW.id
    GROUP BY item_id
  ) b
  WHERE s.company_id=NEW.company_id AND s.item_id=b.item_id;
  RETURN NULL;
END $$;
CREATE INDEX IF NOT EXISTS stock_balances_stats_location
  ON stock_balances(company_id,location_id,item_id);
