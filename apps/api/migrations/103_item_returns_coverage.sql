-- Account for stock held in locations classified as returns.
-- Stock stays in the authoritative stock_balances and in stock_total;
-- it is excluded only from sale-stock sufficiency calculations.
ALTER TABLE item_statistics
  ADD COLUMN stock_returns numeric(40,0) NOT NULL DEFAULT 0;
ALTER TABLE item_statistics
  DROP CONSTRAINT IF EXISTS item_statistics_check;
ALTER TABLE item_statistics
  ADD CONSTRAINT item_statistics_check
  CHECK (stock_total = stock_showroom + stock_warehouse + stock_returns);

-- Retain the latest-operation fields and all existing projection semantics
-- from migration 065, adding the returns category to explicit rebuilds.
CREATE OR REPLACE FUNCTION refresh_item_statistics(p_company integer,p_item integer)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO item_statistics(
  company_id,item_id,stock_total,stock_showroom,stock_warehouse,stock_returns,
  last_movement_id,last_sale_invoice_id,last_purchase_line_id,
  last_adjustment_movement_id,last_adjustment_operation_id)
 SELECT p_company,p_item,
  COALESCE((SELECT sum(s.quantity_smallest) FROM stock_balances s WHERE s.company_id=p_company AND s.item_id=p_item),0),
  COALESCE((SELECT sum(s.quantity_smallest) FROM stock_balances s JOIN locations l ON l.company_id=s.company_id AND l.id=s.location_id WHERE s.company_id=p_company AND s.item_id=p_item AND l.kind='showroom'),0),
  COALESCE((SELECT sum(s.quantity_smallest) FROM stock_balances s JOIN locations l ON l.company_id=s.company_id AND l.id=s.location_id WHERE s.company_id=p_company AND s.item_id=p_item AND l.kind='warehouse'),0),
  COALESCE((SELECT sum(s.quantity_smallest) FROM stock_balances s JOIN locations l ON l.company_id=s.company_id AND l.id=s.location_id WHERE s.company_id=p_company AND s.item_id=p_item AND l.kind='returns'),0),
  (SELECT m.id FROM stock_movements m WHERE m.company_id=p_company AND m.item_id=p_item ORDER BY m.id DESC LIMIT 1),
  (SELECT l.invoice_id FROM invoice_lines l JOIN invoices i ON i.company_id=l.company_id AND i.id=l.invoice_id WHERE l.company_id=p_company AND l.item_id=p_item AND l.quantity>0 AND i.posted AND NOT i.is_return AND i.kind='sale' ORDER BY l.invoice_id DESC,l.line_number DESC LIMIT 1),
  (SELECT l.id FROM invoice_lines l JOIN invoices i ON i.company_id=l.company_id AND i.id=l.invoice_id WHERE l.company_id=p_company AND l.item_id=p_item AND l.quantity>0 AND i.posted AND NOT i.is_return AND i.kind='purchase' ORDER BY l.invoice_id DESC,l.line_number DESC LIMIT 1),
  (SELECT m.id FROM stock_movements m WHERE m.company_id=p_company AND m.item_id=p_item AND m.kind IN('adjustment_surplus','adjustment_shortage') ORDER BY m.id DESC LIMIT 1),
  (SELECT o.id FROM stock_operations o WHERE o.company_id=p_company AND o.kind='adjustment' AND o.creation_payload->>'itemId'=p_item::text ORDER BY o.id DESC LIMIT 1)
 ON CONFLICT(company_id,item_id) DO UPDATE SET
  stock_total=EXCLUDED.stock_total,
  stock_showroom=EXCLUDED.stock_showroom,
  stock_warehouse=EXCLUDED.stock_warehouse,
  stock_returns=EXCLUDED.stock_returns,
  last_movement_id=EXCLUDED.last_movement_id,
  last_sale_invoice_id=EXCLUDED.last_sale_invoice_id,
  last_purchase_line_id=EXCLUDED.last_purchase_line_id,
  last_adjustment_movement_id=EXCLUDED.last_adjustment_movement_id,
  last_adjustment_operation_id=EXCLUDED.last_adjustment_operation_id,
  updated_at=clock_timestamp();
END $$;

-- Keep incremental stock projections O(1) per balance change.
CREATE OR REPLACE FUNCTION apply_item_statistics_stock_delta(
  p_company integer, p_item integer, p_location integer, p_delta numeric
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_delta = 0 THEN RETURN; END IF;
  INSERT INTO item_statistics(
    company_id,item_id,stock_total,stock_showroom,stock_warehouse,stock_returns
  )
  SELECT p_company,p_item,p_delta,
    CASE WHEN l.kind='showroom' THEN p_delta ELSE 0 END,
    CASE WHEN l.kind='warehouse' THEN p_delta ELSE 0 END,
    CASE WHEN l.kind='returns' THEN p_delta ELSE 0 END
  FROM locations l WHERE l.company_id=p_company AND l.id=p_location
  ON CONFLICT(company_id,item_id) DO UPDATE SET
    stock_total=item_statistics.stock_total+EXCLUDED.stock_total,
    stock_showroom=item_statistics.stock_showroom+EXCLUDED.stock_showroom,
    stock_warehouse=item_statistics.stock_warehouse+EXCLUDED.stock_warehouse,
    stock_returns=item_statistics.stock_returns+EXCLUDED.stock_returns,
    updated_at=clock_timestamp();
END $$;

-- Future classification changes move balances between exactly the old and new buckets.
CREATE OR REPLACE FUNCTION refresh_location_item_statistics()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE item_statistics s SET
    stock_showroom=s.stock_showroom+
      (CASE WHEN NEW.kind='showroom' THEN b.quantity ELSE 0 END)-
      (CASE WHEN OLD.kind='showroom' THEN b.quantity ELSE 0 END),
    stock_warehouse=s.stock_warehouse+
      (CASE WHEN NEW.kind='warehouse' THEN b.quantity ELSE 0 END)-
      (CASE WHEN OLD.kind='warehouse' THEN b.quantity ELSE 0 END),
    stock_returns=s.stock_returns+
      (CASE WHEN NEW.kind='returns' THEN b.quantity ELSE 0 END)-
      (CASE WHEN OLD.kind='returns' THEN b.quantity ELSE 0 END),
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

-- Existing rows are refreshed from authoritative balances. This changes only
-- the derived projection, not physical balances or transaction history.
UPDATE item_statistics s SET
  stock_returns=COALESCE((
    SELECT sum(sb.quantity_smallest)
    FROM stock_balances sb JOIN locations l
      ON l.company_id=sb.company_id AND l.id=sb.location_id
    WHERE sb.company_id=s.company_id AND sb.item_id=s.item_id AND l.kind='returns'
  ),0),
  updated_at=clock_timestamp()
WHERE EXISTS (
  SELECT 1 FROM stock_balances sb JOIN locations l
    ON l.company_id=sb.company_id AND l.id=sb.location_id
  WHERE sb.company_id=s.company_id AND sb.item_id=s.item_id AND l.kind='returns'
);
