-- Track the most recent physical count, including a count with zero difference.
-- Keep stock_movements as the source of quantities; a zero-difference count has no movement.
ALTER TABLE item_statistics ADD COLUMN last_adjustment_operation_id integer;
ALTER TABLE item_statistics ADD CONSTRAINT item_statistics_latest_count_fk
 FOREIGN KEY(company_id,last_adjustment_operation_id) REFERENCES stock_operations(company_id,id);

-- Restrict index contents to adjustment operations; the item is stored in the immutable request payload.
CREATE INDEX stock_operations_latest_count_item
 ON stock_operations(company_id, (creation_payload ->> 'itemId'), id DESC)
 WHERE kind='adjustment';

CREATE OR REPLACE FUNCTION refresh_item_statistics(p_company integer,p_item integer) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO item_statistics(company_id,item_id,stock_total,stock_showroom,stock_warehouse,last_movement_id,last_sale_invoice_id,last_purchase_line_id,last_adjustment_movement_id,last_adjustment_operation_id)
 SELECT p_company,p_item,
 COALESCE((SELECT sum(s.quantity_smallest) FROM stock_balances s WHERE s.company_id=p_company AND s.item_id=p_item),0),
 COALESCE((SELECT sum(s.quantity_smallest) FROM stock_balances s JOIN locations l ON l.company_id=s.company_id AND l.id=s.location_id WHERE s.company_id=p_company AND s.item_id=p_item AND l.kind='showroom'),0),
 COALESCE((SELECT sum(s.quantity_smallest) FROM stock_balances s JOIN locations l ON l.company_id=s.company_id AND l.id=s.location_id WHERE s.company_id=p_company AND s.item_id=p_item AND l.kind='warehouse'),0),
 (SELECT m.id FROM stock_movements m WHERE m.company_id=p_company AND m.item_id=p_item ORDER BY m.id DESC LIMIT 1),
 (SELECT l.invoice_id FROM invoice_lines l JOIN invoices i ON i.company_id=l.company_id AND i.id=l.invoice_id WHERE l.company_id=p_company AND l.item_id=p_item AND l.quantity>0 AND i.posted AND NOT i.is_return AND i.kind='sale' ORDER BY l.invoice_id DESC,l.line_number DESC LIMIT 1),
 (SELECT l.id FROM invoice_lines l JOIN invoices i ON i.company_id=l.company_id AND i.id=l.invoice_id WHERE l.company_id=p_company AND l.item_id=p_item AND l.quantity>0 AND i.posted AND NOT i.is_return AND i.kind='purchase' ORDER BY l.invoice_id DESC,l.line_number DESC LIMIT 1),
 (SELECT m.id FROM stock_movements m WHERE m.company_id=p_company AND m.item_id=p_item AND m.kind IN('adjustment_surplus','adjustment_shortage') ORDER BY m.id DESC LIMIT 1),
 (SELECT o.id FROM stock_operations o WHERE o.company_id=p_company AND o.kind='adjustment' AND o.creation_payload->>'itemId'=p_item::text ORDER BY o.id DESC LIMIT 1)
 ON CONFLICT(company_id,item_id) DO UPDATE SET stock_total=EXCLUDED.stock_total,stock_showroom=EXCLUDED.stock_showroom,stock_warehouse=EXCLUDED.stock_warehouse,
 last_movement_id=EXCLUDED.last_movement_id,last_sale_invoice_id=EXCLUDED.last_sale_invoice_id,last_purchase_line_id=EXCLUDED.last_purchase_line_id,
 last_adjustment_movement_id=EXCLUDED.last_adjustment_movement_id,last_adjustment_operation_id=EXCLUDED.last_adjustment_operation_id,updated_at=clock_timestamp();
END $$;

-- The count operation is inserted even when there is no difference.
-- This trigger runs in the same transaction; other stock triggers still refresh the stock snapshot.
CREATE FUNCTION refresh_item_statistics_after_count() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.creation_payload ->> 'itemId') ~ '^[0-9]+$' THEN
  PERFORM refresh_item_statistics(NEW.company_id, (NEW.creation_payload ->> 'itemId')::integer);
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER item_statistics_count_operation
 AFTER INSERT ON stock_operations FOR EACH ROW WHEN (NEW.kind='adjustment')
 EXECUTE FUNCTION refresh_item_statistics_after_count();

-- Historical counts: update only the derived projection, never a source document or stock balance.
UPDATE item_statistics s
 SET last_adjustment_operation_id=x.operation_id,updated_at=clock_timestamp()
 FROM (
  SELECT DISTINCT ON (o.company_id, (o.creation_payload ->> 'itemId'))
    o.company_id,(o.creation_payload ->> 'itemId') AS item_key,o.id AS operation_id
  FROM stock_operations o
  WHERE o.kind='adjustment' AND (o.creation_payload ->> 'itemId') ~ '^[0-9]+$'
  ORDER BY o.company_id,(o.creation_payload ->> 'itemId'),o.id DESC
 ) x
 WHERE s.company_id=x.company_id AND s.item_id::text=x.item_key
   AND s.last_adjustment_operation_id IS DISTINCT FROM x.operation_id;
