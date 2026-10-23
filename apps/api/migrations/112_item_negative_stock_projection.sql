-- Cached per-item negative-location flag. A negative batch is not sufficient:
-- the sum of all batches at the same location must be below zero.
ALTER TABLE item_statistics ADD COLUMN has_negative_stock boolean NOT NULL DEFAULT false;

-- Rebuild only the affected item, using existing stock balance rows (never movement history).
CREATE OR REPLACE FUNCTION refresh_item_negative_stock(p_company integer,p_item integer)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE item_statistics s SET
    has_negative_stock=EXISTS (
      SELECT 1 FROM stock_balances b
      WHERE b.company_id=p_company AND b.item_id=p_item
      GROUP BY b.location_id
      HAVING SUM(b.quantity_smallest)<0
    )
  WHERE s.company_id=p_company AND s.item_id=p_item;
END $$;

-- Explicit statistics repairs must also restore the cached flag.
-- The stock-delta trigger keeps ordinary posting incremental.
CREATE OR REPLACE FUNCTION update_item_negative_stock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    PERFORM refresh_item_negative_stock(OLD.company_id,OLD.item_id);
  ELSIF TG_OP='INSERT' THEN
    PERFORM refresh_item_negative_stock(NEW.company_id,NEW.item_id);
  ELSE
    PERFORM refresh_item_negative_stock(NEW.company_id,NEW.item_id);
    IF (OLD.company_id,OLD.item_id) IS DISTINCT FROM (NEW.company_id,NEW.item_id) THEN
      PERFORM refresh_item_negative_stock(OLD.company_id,OLD.item_id);
    END IF;
  END IF;
  RETURN NULL;
END $$;

-- The existing statistics trigger runs first; the flag is then updated in
-- the same transaction as the stock change.
CREATE TRIGGER item_statistics_negative_balance
AFTER INSERT OR UPDATE OR DELETE ON stock_balances
FOR EACH ROW EXECUTE FUNCTION update_item_negative_stock();

-- Set-based one-time backfill from current balances, not historical movements.
UPDATE item_statistics s SET has_negative_stock=true
WHERE EXISTS (
  SELECT 1 FROM stock_balances b
  WHERE b.company_id=s.company_id AND b.item_id=s.item_id
  GROUP BY b.location_id
  HAVING SUM(b.quantity_smallest)<0
);

CREATE INDEX item_statistics_negative_stock_lookup
ON item_statistics(company_id,item_id) WHERE has_negative_stock;
