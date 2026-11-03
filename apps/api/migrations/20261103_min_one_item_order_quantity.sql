-- Correct *order_quantity*, not stock, reserve_quantity or sale/purchase quantities.
-- Each previously zero-valued master gets revision +1 for protect_item_master_identity.
-- Historical invoices, inventory balances and valuations are never updated.
-- One aggregated audit event per company avoids flooding the audit log with
-- thousands of mechanically identical item-card changes.
WITH corrected AS (
  UPDATE items
     SET order_quantity=1,
         revision=revision+1,
         updated_at=clock_timestamp()
   WHERE order_quantity=0
   RETURNING company_id,id
)
INSERT INTO audit_events
  (actor_id,actor_name,scope,company_id,action,target_type,target_id,before_value,after_value)
SELECT NULL,'النظام','company',company_id,'item.field.update','items',NULL,
       jsonb_build_object('field','orderQuantity','value','0','count',COUNT(*)),
       jsonb_build_object('field','orderQuantity','value','1','count',COUNT(*))
  FROM corrected GROUP BY company_id;

-- Going forward a new item is ordered in positive whole units by default.
-- The original constraint was created implicitly in 006_items.sql.
ALTER TABLE items ALTER COLUMN order_quantity SET DEFAULT 1;
ALTER TABLE items DROP CONSTRAINT IF EXISTS items_order_quantity_check;
ALTER TABLE items ADD CONSTRAINT items_order_quantity_check CHECK (order_quantity>=1);
