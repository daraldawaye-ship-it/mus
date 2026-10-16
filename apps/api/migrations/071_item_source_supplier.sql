-- Keep the current purchase supplier on the item and the supplier at the
-- time of every NEW stock movement. Existing history remains untouched:
-- assigning today's supplier to older movements would misstate provenance.
ALTER TABLE items ADD COLUMN supplier_account_id integer;
ALTER TABLE items ADD CONSTRAINT items_supplier_account_company_fk
 FOREIGN KEY(company_id,supplier_account_id) REFERENCES accounts(company_id,id);
CREATE INDEX items_supplier_account_lookup ON items(company_id,supplier_account_id)
 WHERE supplier_account_id IS NOT NULL;

ALTER TABLE stock_movements
 ADD COLUMN supplier_account_id integer,
 ADD COLUMN supplier_account_code text,
 ADD COLUMN supplier_account_name text,
 ADD CONSTRAINT stock_movements_supplier_account_company_fk
   FOREIGN KEY(company_id,supplier_account_id) REFERENCES accounts(company_id,id);
CREATE INDEX stock_movements_supplier_date
 ON stock_movements(company_id,supplier_account_id,document_date DESC,id DESC)
 WHERE supplier_account_id IS NOT NULL;

-- A BEFORE INSERT snapshot is immutable together with the movement.
-- Purchase lines use the actual invoice supplier even when the item card is
-- changed later; returns of an original sale retain its original attribution.
CREATE FUNCTION snapshot_stock_movement_supplier() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_id integer; source_code text; source_name text;
BEGIN
 IF NEW.original_movement_id IS NOT NULL THEN
   SELECT m.supplier_account_id,m.supplier_account_code,m.supplier_account_name
     INTO source_id,source_code,source_name
   FROM stock_movements m WHERE m.company_id=NEW.company_id AND m.id=NEW.original_movement_id;
 ELSIF NEW.kind IN('purchase','purchase_return') AND NEW.invoice_id IS NOT NULL THEN
   SELECT i.supplier_account_id,i.supplier_account_code,i.supplier_account_name
     INTO source_id,source_code,source_name
   FROM invoices i WHERE i.company_id=NEW.company_id AND i.id=NEW.invoice_id;
 ELSE
   SELECT a.id,a.code,a.name INTO source_id,source_code,source_name
   FROM items i LEFT JOIN accounts a
     ON a.company_id=i.company_id AND a.id=i.supplier_account_id
   WHERE i.company_id=NEW.company_id AND i.id=NEW.item_id;
 END IF;
 NEW.supplier_account_id:=source_id;
 NEW.supplier_account_code:=source_code;
 NEW.supplier_account_name:=source_name;
 RETURN NEW;
END $$;
CREATE TRIGGER stock_movements_supplier_snapshot
 BEFORE INSERT ON stock_movements
 FOR EACH ROW EXECUTE FUNCTION snapshot_stock_movement_supplier();

-- For purchases, compare the sum of positive received units with stock
-- BEFORE this invoice (all signed lines removed from current pooled stock).
-- Count all invoice lines for the item once; mixed/negative lines are not
-- mistaken for a fresh supplier selection. Skip invoices without a supplier.
CREATE FUNCTION promote_item_supplier_on_purchase() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.kind<>'purchase' OR NEW.supplier_account_id IS NULL
    OR NOT NEW.posted OR OLD.posted THEN RETURN NEW; END IF;

 UPDATE items i SET supplier_account_id=NEW.supplier_account_id,
   revision=i.revision+1,updated_at=clock_timestamp()
 FROM (
   SELECT l.item_id,
     sum(l.smallest_quantity) FILTER(WHERE l.smallest_quantity>0) AS purchased,
     sum(l.smallest_quantity) AS signed_total
   FROM invoice_lines l WHERE l.company_id=NEW.company_id AND l.invoice_id=NEW.id
   GROUP BY l.item_id
 ) lines
 JOIN stock_item_valuations v ON v.company_id=NEW.company_id AND v.item_id=lines.item_id
 WHERE i.company_id=NEW.company_id AND i.id=lines.item_id
   AND lines.purchased IS NOT NULL AND lines.purchased>0
   AND lines.purchased>(v.quantity_smallest-lines.signed_total)
   AND i.supplier_account_id IS DISTINCT FROM NEW.supplier_account_id;
 RETURN NEW;
END $$;
CREATE TRIGGER invoice_promote_item_supplier
 AFTER UPDATE OF posted ON invoices
 FOR EACH ROW WHEN(NEW.posted AND NOT OLD.posted)
 EXECUTE FUNCTION promote_item_supplier_on_purchase();
