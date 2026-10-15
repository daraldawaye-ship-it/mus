-- Read-only projections of immutable positive purchase lines (not stock valuations).
CREATE TABLE item_purchase_price_facts (
 company_id integer NOT NULL,
 item_id integer NOT NULL,
 invoice_line_id integer NOT NULL,
 invoice_id integer NOT NULL,
 document_date date NOT NULL,
 base_currency_id integer NOT NULL,
 invoice_number text NOT NULL,
 supplier_account_id integer,
 supplier_account_name text,
 original_currency_code text NOT NULL,
 original_unit_name text NOT NULL,
 original_unit_price numeric(28,6) NOT NULL CHECK(original_unit_price>=0),
 unit_multiplier numeric(30,0) NOT NULL CHECK(unit_multiplier>0),
 base_price_smallest numeric(70,30) NOT NULL CHECK(base_price_smallest>=0),
 PRIMARY KEY(company_id,invoice_line_id),
 FOREIGN KEY(company_id,item_id) REFERENCES items(company_id,id),
 FOREIGN KEY(company_id,invoice_id) REFERENCES invoices(company_id,id),
 FOREIGN KEY(company_id,invoice_line_id) REFERENCES invoice_lines(company_id,id),
 FOREIGN KEY(company_id,base_currency_id) REFERENCES company_currencies(company_id,id)
);
CREATE INDEX item_purchase_price_facts_day
 ON item_purchase_price_facts(company_id,item_id,document_date,base_currency_id);

-- One row per item/day/base-currency regardless of invoice-line volume.
CREATE TABLE item_purchase_price_daily (
 company_id integer NOT NULL,
 item_id integer NOT NULL,
 document_date date NOT NULL,
 base_currency_id integer NOT NULL,
 min_line_id integer NOT NULL,
 max_line_id integer NOT NULL,
 latest_line_id integer NOT NULL,
 min_price numeric(70,30) NOT NULL CHECK(min_price>=0),
 max_price numeric(70,30) NOT NULL CHECK(max_price>=min_price),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(company_id,item_id,document_date,base_currency_id),
 FOREIGN KEY(company_id,item_id) REFERENCES items(company_id,id),
 FOREIGN KEY(company_id,base_currency_id) REFERENCES company_currencies(company_id,id),
 FOREIGN KEY(company_id,min_line_id) REFERENCES item_purchase_price_facts(company_id,invoice_line_id),
 FOREIGN KEY(company_id,max_line_id) REFERENCES item_purchase_price_facts(company_id,invoice_line_id),
 FOREIGN KEY(company_id,latest_line_id) REFERENCES item_purchase_price_facts(company_id,invoice_line_id)
);

CREATE FUNCTION refresh_item_purchase_price_day(
 p_company integer,p_item integer,p_date date,p_base_currency integer
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO item_purchase_price_daily(
   company_id,item_id,document_date,base_currency_id,
   min_line_id,max_line_id,latest_line_id,min_price,max_price
 )
 SELECT company_id,item_id,document_date,base_currency_id,
   (array_agg(invoice_line_id ORDER BY base_price_smallest ASC,invoice_line_id DESC))[1],
   (array_agg(invoice_line_id ORDER BY base_price_smallest DESC,invoice_line_id DESC))[1],
   (array_agg(invoice_line_id ORDER BY invoice_id DESC,invoice_line_id DESC))[1],
   min(base_price_smallest),max(base_price_smallest)
 FROM item_purchase_price_facts
 WHERE company_id=p_company AND item_id=p_item
   AND document_date=p_date AND base_currency_id=p_base_currency
 GROUP BY company_id,item_id,document_date,base_currency_id
 ON CONFLICT(company_id,item_id,document_date,base_currency_id) DO UPDATE SET
   min_line_id=EXCLUDED.min_line_id,max_line_id=EXCLUDED.max_line_id,
   latest_line_id=EXCLUDED.latest_line_id,min_price=EXCLUDED.min_price,
   max_price=EXCLUDED.max_price,updated_at=clock_timestamp();
END $$;

CREATE FUNCTION capture_item_purchase_price_facts() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE changed_item integer;
BEGIN
 INSERT INTO item_purchase_price_facts(company_id,item_id,invoice_line_id,invoice_id,document_date,base_currency_id,invoice_number,supplier_account_id,supplier_account_name,original_currency_code,original_unit_name,original_unit_price,unit_multiplier,base_price_smallest)
 SELECT i.company_id,l.item_id,l.id,i.id,i.document_date,i.base_currency_id,
  i.number,i.supplier_account_id,i.supplier_account_name,i.currency_code,l.unit_name,
  l.unit_price,CASE WHEN l.unit=1 THEN l.factor2::numeric*l.factor3::numeric WHEN l.unit=2 THEN l.factor3::numeric ELSE 1::numeric END,
  round(l.unit_price*i.exchange_rate/(CASE WHEN l.unit=1 THEN l.factor2::numeric*l.factor3::numeric WHEN l.unit=2 THEN l.factor3::numeric ELSE 1::numeric END),30)
 FROM invoices i JOIN invoice_lines l ON l.company_id=i.company_id AND l.invoice_id=i.id
 WHERE i.company_id=NEW.company_id AND i.id=NEW.id AND i.posted
   AND i.kind='purchase' AND l.smallest_quantity>0
 ON CONFLICT(company_id,invoice_line_id) DO NOTHING;
 FOR changed_item IN
   SELECT DISTINCT l.item_id FROM invoice_lines l
   WHERE l.company_id=NEW.company_id AND l.invoice_id=NEW.id
     AND l.smallest_quantity>0 ORDER BY l.item_id
 LOOP
   PERFORM refresh_item_purchase_price_day(
     NEW.company_id,changed_item,NEW.document_date,NEW.base_currency_id
   );
 END LOOP;
 RETURN NULL;
END $$;
CREATE TRIGGER item_purchase_price_on_post AFTER UPDATE OF posted ON invoices
 FOR EACH ROW WHEN (NEW.posted AND NOT OLD.posted AND NEW.kind='purchase')
 EXECUTE FUNCTION capture_item_purchase_price_facts();

-- Historical one-time backfill, without touching source invoices, stock or journals.
INSERT INTO item_purchase_price_facts(company_id,item_id,invoice_line_id,invoice_id,document_date,base_currency_id,invoice_number,supplier_account_id,supplier_account_name,original_currency_code,original_unit_name,original_unit_price,unit_multiplier,base_price_smallest)
 SELECT i.company_id,l.item_id,l.id,i.id,i.document_date,i.base_currency_id,
  i.number,i.supplier_account_id,i.supplier_account_name,i.currency_code,l.unit_name,
  l.unit_price,CASE WHEN l.unit=1 THEN l.factor2::numeric*l.factor3::numeric WHEN l.unit=2 THEN l.factor3::numeric ELSE 1::numeric END,round(l.unit_price*i.exchange_rate/(CASE WHEN l.unit=1 THEN l.factor2::numeric*l.factor3::numeric WHEN l.unit=2 THEN l.factor3::numeric ELSE 1::numeric END),30)
 FROM invoices i JOIN invoice_lines l ON l.company_id=i.company_id AND l.invoice_id=i.id
 WHERE i.posted AND i.kind='purchase' AND l.smallest_quantity>0;

INSERT INTO item_purchase_price_daily(
 company_id,item_id,document_date,base_currency_id,
 min_line_id,max_line_id,latest_line_id,min_price,max_price
)
SELECT company_id,item_id,document_date,base_currency_id,
 (array_agg(invoice_line_id ORDER BY base_price_smallest ASC,invoice_line_id DESC))[1],
 (array_agg(invoice_line_id ORDER BY base_price_smallest DESC,invoice_line_id DESC))[1],
 (array_agg(invoice_line_id ORDER BY invoice_id DESC,invoice_line_id DESC))[1],
 min(base_price_smallest),max(base_price_smallest)
FROM item_purchase_price_facts
GROUP BY company_id,item_id,document_date,base_currency_id;
