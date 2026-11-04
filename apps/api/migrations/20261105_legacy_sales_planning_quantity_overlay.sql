-- Company 2 only: correct a narrowly provable legacy SALES unit mismatch for
-- planning statistics. Never mutate invoice_lines, stock, ledgers, or daily facts.
-- Confidence test: imported line wrongly marked unit 1, while its exact price
-- matches the card's smaller unit 2 (not the outer unit 1), with factor2>1.
-- Unmatched/ambiguous history remains unchanged for a separate audit.
CREATE TABLE legacy_sales_planning_line_deltas (
  company_id integer NOT NULL CHECK(company_id=2),
  source_system text NOT NULL,
  source_id text NOT NULL,
  line_number integer NOT NULL,
  origin text NOT NULL CHECK(origin IN ('posted','staged')),
  item_id integer NOT NULL,
  document_date date NOT NULL,
  quantity_delta numeric NOT NULL,
  PRIMARY KEY(company_id,source_system,source_id,line_number),
  CHECK(quantity_delta<>0)
);
CREATE INDEX legacy_sales_planning_line_deltas_day
  ON legacy_sales_planning_line_deltas(company_id,item_id,document_date);

CREATE TABLE legacy_sales_planning_daily_deltas (
  company_id integer NOT NULL CHECK(company_id=2),
  item_id integer NOT NULL,
  document_date date NOT NULL,
  quantity_delta numeric NOT NULL DEFAULT 0,
  PRIMARY KEY(company_id,item_id,document_date)
);

-- Maintain one compact daily correction for fast four-month coverage, and one
-- per-line provenance record so a later stage-to-post transfer cannot double
-- count the same imported invoice.
CREATE FUNCTION apply_legacy_sales_planning_daily_delta()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE','UPDATE') THEN
    INSERT INTO legacy_sales_planning_daily_deltas AS d
      (company_id,item_id,document_date,quantity_delta)
    VALUES(OLD.company_id,OLD.item_id,OLD.document_date,-OLD.quantity_delta)
    ON CONFLICT(company_id,item_id,document_date) DO UPDATE
       SET quantity_delta=d.quantity_delta+EXCLUDED.quantity_delta;
  END IF;
  IF TG_OP IN ('INSERT','UPDATE') THEN
    INSERT INTO legacy_sales_planning_daily_deltas AS d
      (company_id,item_id,document_date,quantity_delta)
    VALUES(NEW.company_id,NEW.item_id,NEW.document_date,NEW.quantity_delta)
    ON CONFLICT(company_id,item_id,document_date) DO UPDATE
       SET quantity_delta=d.quantity_delta+EXCLUDED.quantity_delta;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER legacy_sales_planning_daily_delta
AFTER INSERT OR UPDATE OR DELETE ON legacy_sales_planning_line_deltas
FOR EACH ROW EXECUTE FUNCTION apply_legacy_sales_planning_daily_delta();

-- Staged rows are already an indexed projection, not raw invoice JSON.
-- Only exact small-unit-price matches qualify; never guess based on names.
CREATE FUNCTION track_staged_legacy_sales_planning_delta()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    DELETE FROM legacy_sales_planning_line_deltas d
    WHERE d.company_id=OLD.company_id AND d.source_system=OLD.source_system
      AND d.source_id=OLD.source_id AND d.line_number=OLD.line_number
      AND d.origin='staged';
    RETURN NULL;
  END IF;
  INSERT INTO legacy_sales_planning_line_deltas
    (company_id,source_system,source_id,line_number,origin,item_id,document_date,quantity_delta)
  SELECT NEW.company_id,NEW.source_system,NEW.source_id,NEW.line_number,
    'staged',NEW.item_id,NEW.document_date,
    NEW.quantity*(i.factor3::numeric-i.factor2::numeric*i.factor3)
  FROM items i
  WHERE NEW.company_id=2
    AND NEW.source_system='dar-aldawa-legacy-2026-10'
    AND NEW.kind='sale' AND NEW.unit=1 AND NEW.quantity<>0
    AND i.company_id=NEW.company_id AND i.id=NEW.item_id
    AND i.factor2>1 AND i.sale_price2>0
    AND i.sale_price1>i.sale_price2*2
    AND NEW.unit_price=i.sale_price2
  ON CONFLICT(company_id,source_system,source_id,line_number) DO UPDATE
    SET origin=EXCLUDED.origin,item_id=EXCLUDED.item_id,
        document_date=EXCLUDED.document_date,quantity_delta=EXCLUDED.quantity_delta
  WHERE legacy_sales_planning_line_deltas.origin='staged';
  RETURN NULL;
END $$;
CREATE TRIGGER legacy_sales_planning_staged_insert
  AFTER INSERT ON staged_invoice_item_lines_cache
  FOR EACH ROW EXECUTE FUNCTION track_staged_legacy_sales_planning_delta();
CREATE TRIGGER legacy_sales_planning_staged_delete
  AFTER DELETE ON staged_invoice_item_lines_cache
  FOR EACH ROW EXECUTE FUNCTION track_staged_legacy_sales_planning_delta();

-- Posted invoices are immutable; the import mapping arrives after posting.
-- Preserve one source identity across staged and posted so delta is not doubled.
CREATE FUNCTION track_posted_legacy_sales_planning_delta()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.company_id<>2 OR NEW.source_system<>'dar-aldawa-legacy-2026-10'
    OR NEW.source_kind<>'invoice' OR NEW.invoice_id IS NULL THEN RETURN NULL; END IF;
  INSERT INTO legacy_sales_planning_line_deltas
    (company_id,source_system,source_id,line_number,origin,item_id,document_date,quantity_delta)
  SELECT NEW.company_id,NEW.source_system,NEW.source_id,l.line_number,
    'posted',l.item_id,inv.document_date,
    l.quantity*(l.factor3::numeric-l.factor2::numeric*l.factor3)
  FROM invoices inv
  JOIN invoice_lines l ON l.company_id=inv.company_id AND l.invoice_id=inv.id
  JOIN items i ON i.company_id=l.company_id AND i.id=l.item_id
  WHERE inv.company_id=2 AND inv.id=NEW.invoice_id AND inv.kind='sale'
    AND l.unit=1 AND l.quantity<>0 AND l.factor2>1
    AND l.factor2=i.factor2 AND l.factor3=i.factor3
    AND i.sale_price2>0 AND i.sale_price1>i.sale_price2*2
    AND l.unit_price=i.sale_price2
  ON CONFLICT(company_id,source_system,source_id,line_number) DO UPDATE
    SET origin='posted',item_id=EXCLUDED.item_id,
        document_date=EXCLUDED.document_date,quantity_delta=EXCLUDED.quantity_delta;
  RETURN NULL;
END $$;
CREATE TRIGGER legacy_sales_planning_posted_insert
  AFTER INSERT ON transaction_source_imports
  FOR EACH ROW EXECUTE FUNCTION track_posted_legacy_sales_planning_delta();

-- Existing staged history is inserted once, then posted mappings take
-- precedence. Each row triggers an increment to the daily projection.
INSERT INTO legacy_sales_planning_line_deltas
  (company_id,source_system,source_id,line_number,origin,item_id,document_date,quantity_delta)
SELECT l.company_id,l.source_system,l.source_id,l.line_number,
  'staged',l.item_id,l.document_date,
  l.quantity*(i.factor3::numeric-i.factor2::numeric*i.factor3)
FROM staged_invoice_item_lines_cache l
JOIN items i ON i.company_id=l.company_id AND i.id=l.item_id
WHERE l.company_id=2 AND l.source_system='dar-aldawa-legacy-2026-10'
  AND l.kind='sale' AND l.unit=1 AND l.quantity<>0 AND i.factor2>1
  AND i.sale_price2>0 AND i.sale_price1>i.sale_price2*2
  AND l.unit_price=i.sale_price2
ON CONFLICT DO NOTHING;

INSERT INTO legacy_sales_planning_line_deltas
  (company_id,source_system,source_id,line_number,origin,item_id,document_date,quantity_delta)
SELECT m.company_id,m.source_system,m.source_id,l.line_number,
  'posted',l.item_id,inv.document_date,
  l.quantity*(l.factor3::numeric-l.factor2::numeric*l.factor3)
FROM transaction_source_imports m
JOIN invoices inv ON inv.company_id=m.company_id AND inv.id=m.invoice_id
  AND inv.kind='sale'
JOIN invoice_lines l ON l.company_id=inv.company_id AND l.invoice_id=inv.id
JOIN items i ON i.company_id=l.company_id AND i.id=l.item_id
WHERE m.company_id=2 AND m.source_system='dar-aldawa-legacy-2026-10'
  AND m.source_kind='invoice'
  AND l.unit=1 AND l.quantity<>0 AND l.factor2>1
  AND l.factor2=i.factor2 AND l.factor3=i.factor3
  AND i.sale_price2>0 AND i.sale_price1>i.sale_price2*2
  AND l.unit_price=i.sale_price2
ON CONFLICT(company_id,source_system,source_id,line_number) DO UPDATE
  SET origin='posted',item_id=EXCLUDED.item_id,
      document_date=EXCLUDED.document_date,quantity_delta=EXCLUDED.quantity_delta;

-- No invoice, financial document, stock balance, source document, or canonical
-- item_daily_activity rows are changed by this migration.
