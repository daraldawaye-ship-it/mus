-- A rebuildable read projection. Authoritative stock and operational history remain unchanged.
CREATE TABLE item_statistics (
 company_id integer NOT NULL,item_id integer NOT NULL,
 stock_total numeric(40,0) NOT NULL DEFAULT 0,stock_showroom numeric(40,0) NOT NULL DEFAULT 0,stock_warehouse numeric(40,0) NOT NULL DEFAULT 0,
 last_movement_id integer,last_sale_invoice_id integer,last_purchase_line_id integer,last_adjustment_movement_id integer,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(company_id,item_id),FOREIGN KEY(company_id,item_id) REFERENCES items(company_id,id),
 FOREIGN KEY(company_id,last_movement_id) REFERENCES stock_movements(company_id,id),
 FOREIGN KEY(company_id,last_sale_invoice_id) REFERENCES invoices(company_id,id),
 FOREIGN KEY(company_id,last_purchase_line_id) REFERENCES invoice_lines(company_id,id),
 FOREIGN KEY(company_id,last_adjustment_movement_id) REFERENCES stock_movements(company_id,id),
 CHECK(stock_total=stock_showroom+stock_warehouse)
);
CREATE INDEX stock_movements_statistics ON stock_movements(company_id,item_id,id DESC);
CREATE INDEX invoice_lines_statistics ON invoice_lines(company_id,item_id,invoice_id DESC,line_number DESC);
CREATE FUNCTION refresh_item_statistics(p_company integer,p_item integer) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO item_statistics(company_id,item_id,stock_total,stock_showroom,stock_warehouse,last_movement_id,last_sale_invoice_id,last_purchase_line_id,last_adjustment_movement_id)
 SELECT p_company,p_item,
 COALESCE((SELECT sum(s.quantity_smallest) FROM stock_balances s WHERE s.company_id=p_company AND s.item_id=p_item),0),
 COALESCE((SELECT sum(s.quantity_smallest) FROM stock_balances s JOIN locations l ON l.company_id=s.company_id AND l.id=s.location_id WHERE s.company_id=p_company AND s.item_id=p_item AND l.kind='showroom'),0),
 COALESCE((SELECT sum(s.quantity_smallest) FROM stock_balances s JOIN locations l ON l.company_id=s.company_id AND l.id=s.location_id WHERE s.company_id=p_company AND s.item_id=p_item AND l.kind='warehouse'),0),
 (SELECT m.id FROM stock_movements m WHERE m.company_id=p_company AND m.item_id=p_item ORDER BY m.id DESC LIMIT 1),
 (SELECT l.invoice_id FROM invoice_lines l JOIN invoices i ON i.company_id=l.company_id AND i.id=l.invoice_id WHERE l.company_id=p_company AND l.item_id=p_item AND l.quantity>0 AND i.posted AND NOT i.is_return AND i.kind='sale' ORDER BY l.invoice_id DESC,l.line_number DESC LIMIT 1),
 (SELECT l.id FROM invoice_lines l JOIN invoices i ON i.company_id=l.company_id AND i.id=l.invoice_id WHERE l.company_id=p_company AND l.item_id=p_item AND l.quantity>0 AND i.posted AND NOT i.is_return AND i.kind='purchase' ORDER BY l.invoice_id DESC,l.line_number DESC LIMIT 1),
 (SELECT m.id FROM stock_movements m WHERE m.company_id=p_company AND m.item_id=p_item AND m.kind IN('adjustment_surplus','adjustment_shortage') ORDER BY m.id DESC LIMIT 1)
 ON CONFLICT(company_id,item_id) DO UPDATE SET stock_total=EXCLUDED.stock_total,stock_showroom=EXCLUDED.stock_showroom,stock_warehouse=EXCLUDED.stock_warehouse,
 last_movement_id=EXCLUDED.last_movement_id,last_sale_invoice_id=EXCLUDED.last_sale_invoice_id,last_purchase_line_id=EXCLUDED.last_purchase_line_id,
 last_adjustment_movement_id=EXCLUDED.last_adjustment_movement_id,updated_at=clock_timestamp();
END $$;
CREATE FUNCTION refresh_item_statistics_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='items' THEN PERFORM refresh_item_statistics(NEW.company_id,NEW.id);
 ELSIF TG_OP='DELETE' THEN PERFORM refresh_item_statistics(OLD.company_id,OLD.item_id);
 ELSE PERFORM refresh_item_statistics(NEW.company_id,NEW.item_id); END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER item_statistics_new AFTER INSERT ON items FOR EACH ROW EXECUTE FUNCTION refresh_item_statistics_row();
CREATE TRIGGER item_statistics_balance AFTER INSERT OR UPDATE OR DELETE ON stock_balances FOR EACH ROW EXECUTE FUNCTION refresh_item_statistics_row();
CREATE TRIGGER item_statistics_movement AFTER INSERT ON stock_movements FOR EACH ROW EXECUTE FUNCTION refresh_item_statistics_row();
CREATE FUNCTION refresh_invoice_item_statistics() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE affected integer;
BEGIN
 FOR affected IN SELECT DISTINCT item_id FROM invoice_lines WHERE company_id=NEW.company_id AND invoice_id=NEW.id ORDER BY item_id
 LOOP PERFORM refresh_item_statistics(NEW.company_id,affected); END LOOP;
 RETURN NULL;
END $$;
CREATE TRIGGER item_statistics_invoice AFTER UPDATE OF posted ON invoices FOR EACH ROW WHEN(NEW.posted AND NOT OLD.posted) EXECUTE FUNCTION refresh_invoice_item_statistics();
CREATE FUNCTION refresh_location_item_statistics() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE affected integer;
BEGIN
 FOR affected IN SELECT DISTINCT item_id FROM stock_balances WHERE company_id=NEW.company_id AND location_id=NEW.id ORDER BY item_id
 LOOP PERFORM refresh_item_statistics(NEW.company_id,affected); END LOOP;
 RETURN NULL;
END $$;
CREATE TRIGGER item_statistics_location AFTER UPDATE OF kind ON locations FOR EACH ROW WHEN(NEW.kind IS DISTINCT FROM OLD.kind) EXECUTE FUNCTION refresh_location_item_statistics();
-- Existing items are populated automatically on deployment; no initialization button.
SELECT refresh_item_statistics(company_id,id) FROM items ORDER BY company_id,id;
