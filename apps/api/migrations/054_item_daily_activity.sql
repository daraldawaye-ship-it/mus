-- Rebuildable daily invoice facts. Source of truth remains immutable posted invoice lines.
-- Quantities are always in the item's smallest unit and returns are positive magnitudes.
CREATE TABLE item_daily_activity (
 company_id integer NOT NULL,
 item_id integer NOT NULL,
 document_date date NOT NULL,
 sale_invoices bigint NOT NULL DEFAULT 0 CHECK (sale_invoices>=0),
 sale_return_invoices bigint NOT NULL DEFAULT 0 CHECK (sale_return_invoices>=0),
 sale_lines bigint NOT NULL DEFAULT 0 CHECK (sale_lines>=0),
 sale_return_lines bigint NOT NULL DEFAULT 0 CHECK (sale_return_lines>=0),
 sale_quantity numeric(40,0) NOT NULL DEFAULT 0 CHECK (sale_quantity>=0),
 sale_return_quantity numeric(40,0) NOT NULL DEFAULT 0 CHECK (sale_return_quantity>=0),
 purchase_invoices bigint NOT NULL DEFAULT 0 CHECK (purchase_invoices>=0),
 purchase_return_invoices bigint NOT NULL DEFAULT 0 CHECK (purchase_return_invoices>=0),
 purchase_lines bigint NOT NULL DEFAULT 0 CHECK (purchase_lines>=0),
 purchase_return_lines bigint NOT NULL DEFAULT 0 CHECK (purchase_return_lines>=0),
 purchase_quantity numeric(40,0) NOT NULL DEFAULT 0 CHECK (purchase_quantity>=0),
 purchase_return_quantity numeric(40,0) NOT NULL DEFAULT 0 CHECK (purchase_return_quantity>=0),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(company_id,item_id,document_date),
 FOREIGN KEY(company_id,item_id) REFERENCES items(company_id,id)
);

-- Only the first transition to posted qualifies. Existing posted invoices cannot be edited.
-- All changes occur inside the same transaction as the invoice and stock journals.
CREATE FUNCTION add_posted_invoice_to_item_daily_activity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO item_daily_activity(company_id,item_id,document_date,sale_invoices,sale_return_invoices,sale_lines,sale_return_lines,sale_quantity,sale_return_quantity,purchase_invoices,purchase_return_invoices,purchase_lines,purchase_return_lines,purchase_quantity,purchase_return_quantity)
 SELECT NEW.company_id,l.item_id,NEW.document_date,
    CASE WHEN NEW.kind='sale' AND bool_or(l.smallest_quantity>0) THEN 1 ELSE 0 END,
    CASE WHEN NEW.kind='sale' AND bool_or(l.smallest_quantity<0) THEN 1 ELSE 0 END,
    CASE WHEN NEW.kind='sale' THEN count(*) FILTER (WHERE l.smallest_quantity>0) ELSE 0 END,
    CASE WHEN NEW.kind='sale' THEN count(*) FILTER (WHERE l.smallest_quantity<0) ELSE 0 END,
    CASE WHEN NEW.kind='sale' THEN coalesce(sum(l.smallest_quantity) FILTER (WHERE l.smallest_quantity>0),0) ELSE 0 END,
    CASE WHEN NEW.kind='sale' THEN -coalesce(sum(l.smallest_quantity) FILTER (WHERE l.smallest_quantity<0),0) ELSE 0 END,
    CASE WHEN NEW.kind='purchase' AND bool_or(l.smallest_quantity>0) THEN 1 ELSE 0 END,
    CASE WHEN NEW.kind='purchase' AND bool_or(l.smallest_quantity<0) THEN 1 ELSE 0 END,
    CASE WHEN NEW.kind='purchase' THEN count(*) FILTER (WHERE l.smallest_quantity>0) ELSE 0 END,
    CASE WHEN NEW.kind='purchase' THEN count(*) FILTER (WHERE l.smallest_quantity<0) ELSE 0 END,
    CASE WHEN NEW.kind='purchase' THEN coalesce(sum(l.smallest_quantity) FILTER (WHERE l.smallest_quantity>0),0) ELSE 0 END,
    CASE WHEN NEW.kind='purchase' THEN -coalesce(sum(l.smallest_quantity) FILTER (WHERE l.smallest_quantity<0),0) ELSE 0 END
 FROM invoice_lines l
 WHERE l.company_id=NEW.company_id AND l.invoice_id=NEW.id
 GROUP BY l.item_id
 ON CONFLICT(company_id,item_id,document_date) DO UPDATE SET
    sale_invoices=item_daily_activity.sale_invoices+EXCLUDED.sale_invoices,
    sale_return_invoices=item_daily_activity.sale_return_invoices+EXCLUDED.sale_return_invoices,
    sale_lines=item_daily_activity.sale_lines+EXCLUDED.sale_lines,
    sale_return_lines=item_daily_activity.sale_return_lines+EXCLUDED.sale_return_lines,
    sale_quantity=item_daily_activity.sale_quantity+EXCLUDED.sale_quantity,
    sale_return_quantity=item_daily_activity.sale_return_quantity+EXCLUDED.sale_return_quantity,
    purchase_invoices=item_daily_activity.purchase_invoices+EXCLUDED.purchase_invoices,
    purchase_return_invoices=item_daily_activity.purchase_return_invoices+EXCLUDED.purchase_return_invoices,
    purchase_lines=item_daily_activity.purchase_lines+EXCLUDED.purchase_lines,
    purchase_return_lines=item_daily_activity.purchase_return_lines+EXCLUDED.purchase_return_lines,
    purchase_quantity=item_daily_activity.purchase_quantity+EXCLUDED.purchase_quantity,
    purchase_return_quantity=item_daily_activity.purchase_return_quantity+EXCLUDED.purchase_return_quantity,
    updated_at=clock_timestamp();
 RETURN NULL;
END $$;
CREATE TRIGGER item_daily_activity_invoice_posted
 AFTER UPDATE OF posted ON invoices
 FOR EACH ROW WHEN (NEW.posted AND NOT OLD.posted)
 EXECUTE FUNCTION add_posted_invoice_to_item_daily_activity();

-- Historical backfill: group by invoice/item before grouping by day.
-- A mixed invoice can count once as a sale and once as a return for this item.
INSERT INTO item_daily_activity(company_id,item_id,document_date,sale_invoices,sale_return_invoices,sale_lines,sale_return_lines,sale_quantity,sale_return_quantity,purchase_invoices,purchase_return_invoices,purchase_lines,purchase_return_lines,purchase_quantity,purchase_return_quantity)
SELECT company_id,item_id,document_date,
 sum(sale_invoices),
 sum(sale_return_invoices),
 sum(sale_lines),
 sum(sale_return_lines),
 sum(sale_quantity),
 sum(sale_return_quantity),
 sum(purchase_invoices),
 sum(purchase_return_invoices),
 sum(purchase_lines),
 sum(purchase_return_lines),
 sum(purchase_quantity),
 sum(purchase_return_quantity)
FROM (
 SELECT i.company_id,l.item_id,i.document_date,i.id AS invoice_id,
    CASE WHEN i.kind='sale' AND bool_or(l.smallest_quantity>0) THEN 1 ELSE 0 END,
    CASE WHEN i.kind='sale' AND bool_or(l.smallest_quantity<0) THEN 1 ELSE 0 END,
    CASE WHEN i.kind='sale' THEN count(*) FILTER (WHERE l.smallest_quantity>0) ELSE 0 END,
    CASE WHEN i.kind='sale' THEN count(*) FILTER (WHERE l.smallest_quantity<0) ELSE 0 END,
    CASE WHEN i.kind='sale' THEN coalesce(sum(l.smallest_quantity) FILTER (WHERE l.smallest_quantity>0),0) ELSE 0 END,
    CASE WHEN i.kind='sale' THEN -coalesce(sum(l.smallest_quantity) FILTER (WHERE l.smallest_quantity<0),0) ELSE 0 END,
    CASE WHEN i.kind='purchase' AND bool_or(l.smallest_quantity>0) THEN 1 ELSE 0 END,
    CASE WHEN i.kind='purchase' AND bool_or(l.smallest_quantity<0) THEN 1 ELSE 0 END,
    CASE WHEN i.kind='purchase' THEN count(*) FILTER (WHERE l.smallest_quantity>0) ELSE 0 END,
    CASE WHEN i.kind='purchase' THEN count(*) FILTER (WHERE l.smallest_quantity<0) ELSE 0 END,
    CASE WHEN i.kind='purchase' THEN coalesce(sum(l.smallest_quantity) FILTER (WHERE l.smallest_quantity>0),0) ELSE 0 END,
    CASE WHEN i.kind='purchase' THEN -coalesce(sum(l.smallest_quantity) FILTER (WHERE l.smallest_quantity<0),0) ELSE 0 END
 FROM invoices i
 JOIN invoice_lines l ON l.company_id=i.company_id AND l.invoice_id=i.id
 WHERE i.posted
 GROUP BY i.company_id,l.item_id,i.document_date,i.id,i.kind
) historic
GROUP BY company_id,item_id,document_date;
