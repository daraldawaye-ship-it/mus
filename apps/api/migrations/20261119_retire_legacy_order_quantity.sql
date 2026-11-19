-- The historical items.order_quantity is unrelated to the visible
-- "كمية الطلب" limit (items.order_alert_quantity).
-- Preserve every nonzero historical value before dropping the obsolete column.
CREATE TABLE IF NOT EXISTS retired_item_order_quantities (
  company_id integer NOT NULL,
  item_id integer NOT NULL,
  legacy_quantity numeric NOT NULL,
  archived_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (company_id, item_id)
);
INSERT INTO retired_item_order_quantities(company_id,item_id,legacy_quantity)
SELECT company_id,id,order_quantity
FROM items
WHERE order_quantity IS NOT NULL AND order_quantity<>0
ON CONFLICT (company_id,item_id) DO NOTHING;

ALTER TABLE items DROP COLUMN IF EXISTS order_quantity;

INSERT INTO page_registry(key) VALUES ('company.stopped-order-items')
ON CONFLICT (key) DO NOTHING;
