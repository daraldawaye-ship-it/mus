-- Ordering projection: showroom stock already exists as stock_showroom.
-- Exclude all returns locations from orderable stock without scanning balances.
-- STORED generated column stays consistent with incremental statistics updates.
ALTER TABLE item_statistics
  ADD COLUMN stock_without_returns numeric(40,0)
  GENERATED ALWAYS AS (stock_total - stock_returns) STORED;
COMMENT ON COLUMN item_statistics.stock_without_returns IS
  'Stock in showroom and regular warehouses, excluding returns locations; smallest units.';
