-- Read-only source projections for fast item search, statistics and invoice sidebar.
-- No stock, ledger, invoice or financial balance tables are mutated.
CREATE TABLE IF NOT EXISTS staged_invoice_item_lines_cache (
  company_id integer NOT NULL,
  source_system varchar(100) NOT NULL,
  source_kind varchar(20) NOT NULL,
  source_id varchar(100) NOT NULL,
  line_number integer NOT NULL,
  document_date date NOT NULL,
  kind text NOT NULL CHECK (kind IN ('sale','purchase')),
  item_id integer NOT NULL,
  unit integer NOT NULL,
  quantity numeric NOT NULL,
  unit_price numeric NOT NULL,
  counterparty_account_id integer,
  supplier_account_id integer,
  currency_id integer,
  PRIMARY KEY (company_id,source_system,source_kind,source_id,line_number)
);
CREATE INDEX IF NOT EXISTS staged_invoice_item_lines_latest
  ON staged_invoice_item_lines_cache
  (company_id,item_id,kind,document_date DESC,source_id DESC,line_number DESC);

CREATE TABLE IF NOT EXISTS staged_invoice_item_contributions (
  company_id integer NOT NULL,
  source_system varchar(100) NOT NULL,
  source_kind varchar(20) NOT NULL,
  source_id varchar(100) NOT NULL,
  document_date date NOT NULL,
  kind text NOT NULL CHECK (kind IN ('sale','purchase')),
  item_id integer NOT NULL,
  positive_lines bigint NOT NULL,
  negative_lines bigint NOT NULL,
  positive_quantity numeric NOT NULL,
  negative_quantity numeric NOT NULL,
  PRIMARY KEY (company_id,source_system,source_kind,source_id,item_id)
);

CREATE TABLE IF NOT EXISTS staged_item_daily_activity_cache (
  company_id integer NOT NULL,
  item_id integer NOT NULL,
  document_date date NOT NULL,
  sale_invoices bigint NOT NULL DEFAULT 0,
  sale_return_invoices bigint NOT NULL DEFAULT 0,
  sale_lines bigint NOT NULL DEFAULT 0,
  sale_return_lines bigint NOT NULL DEFAULT 0,
  sale_quantity numeric NOT NULL DEFAULT 0,
  sale_return_quantity numeric NOT NULL DEFAULT 0,
  purchase_invoices bigint NOT NULL DEFAULT 0,
  purchase_return_invoices bigint NOT NULL DEFAULT 0,
  purchase_lines bigint NOT NULL DEFAULT 0,
  purchase_return_lines bigint NOT NULL DEFAULT 0,
  purchase_quantity numeric NOT NULL DEFAULT 0,
  purchase_return_quantity numeric NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id,item_id,document_date)
);
CREATE INDEX IF NOT EXISTS staged_daily_company_date
  ON staged_item_daily_activity_cache (company_id,document_date,item_id);

-- Populate once from preserved source documents, with posted identities excluded.
-- Joining to items preserves the prior overlay's treatment of unknown item IDs.
INSERT INTO staged_invoice_item_lines_cache
  (company_id,source_system,source_kind,source_id,line_number,document_date,
   kind,item_id,unit,quantity,unit_price,counterparty_account_id,supplier_account_id,currency_id)
SELECT s.company_id,s.source_system,s.source_kind,s.source_id,line.ordinality::integer,
  s.posting_date,s.source_document->'payload'->>'kind',
  item.id,(line.value->>'unit')::integer,(line.value->>'quantity')::numeric,
  (line.value->>'unitPrice')::numeric,
  (s.source_document->'payload'->>'counterpartyAccountId')::integer,
  NULLIF(s.source_document->'payload'->>'supplierAccountId','')::integer,
  (s.source_document->'payload'->>'currencyId')::integer
FROM legacy_import_staging s
CROSS JOIN LATERAL jsonb_array_elements(s.source_document->'payload'->'lines')
  WITH ORDINALITY AS line(value,ordinality)
JOIN items item ON item.company_id=s.company_id AND item.id=(line.value->>'itemId')::integer
WHERE s.source_kind='invoice' AND s.status IN ('pending','failed','excluded')
  AND s.source_document->>'type'='invoice'
  AND s.source_document->'payload'->>'kind' IN ('sale','purchase')
  AND NOT EXISTS (
    SELECT 1 FROM transaction_source_imports posted
    WHERE posted.company_id=s.company_id AND posted.source_system=s.source_system
      AND posted.source_kind=s.source_kind AND posted.source_id=s.source_id
  )
ON CONFLICT DO NOTHING;

INSERT INTO staged_invoice_item_contributions
  (company_id,source_system,source_kind,source_id,document_date,kind,item_id,
   positive_lines,negative_lines,positive_quantity,negative_quantity)
SELECT l.company_id,l.source_system,l.source_kind,l.source_id,l.document_date,l.kind,l.item_id,
  count(*) FILTER (WHERE l.quantity>0),count(*) FILTER (WHERE l.quantity<0),
  coalesce(sum(l.quantity*(CASE l.unit WHEN 1 THEN item.factor2::numeric*item.factor3::numeric
    WHEN 2 THEN item.factor3::numeric ELSE 1::numeric END)) FILTER (WHERE l.quantity>0),0),
  coalesce(-sum(l.quantity*(CASE l.unit WHEN 1 THEN item.factor2::numeric*item.factor3::numeric
    WHEN 2 THEN item.factor3::numeric ELSE 1::numeric END)) FILTER (WHERE l.quantity<0),0)
FROM staged_invoice_item_lines_cache l
JOIN items item ON item.company_id=l.company_id AND item.id=l.item_id
GROUP BY l.company_id,l.source_system,l.source_kind,l.source_id,l.document_date,l.kind,l.item_id
ON CONFLICT DO NOTHING;

INSERT INTO staged_item_daily_activity_cache
(company_id,item_id,document_date,
 sale_invoices,sale_return_invoices,sale_lines,sale_return_lines,sale_quantity,sale_return_quantity,
 purchase_invoices,purchase_return_invoices,purchase_lines,purchase_return_lines,purchase_quantity,purchase_return_quantity)
SELECT company_id,item_id,document_date,
  count(*) FILTER (WHERE kind='sale' AND positive_lines>0),
  count(*) FILTER (WHERE kind='sale' AND negative_lines>0),
  coalesce(sum(positive_lines) FILTER (WHERE kind='sale'),0),
  coalesce(sum(negative_lines) FILTER (WHERE kind='sale'),0),
  coalesce(sum(positive_quantity) FILTER (WHERE kind='sale'),0),
  coalesce(sum(negative_quantity) FILTER (WHERE kind='sale'),0),
  count(*) FILTER (WHERE kind='purchase' AND positive_lines>0),
  count(*) FILTER (WHERE kind='purchase' AND negative_lines>0),
  coalesce(sum(positive_lines) FILTER (WHERE kind='purchase'),0),
  coalesce(sum(negative_lines) FILTER (WHERE kind='purchase'),0),
  coalesce(sum(positive_quantity) FILTER (WHERE kind='purchase'),0),
  coalesce(sum(negative_quantity) FILTER (WHERE kind='purchase'),0)
FROM staged_invoice_item_contributions
GROUP BY company_id,item_id,document_date
ON CONFLICT DO NOTHING;

-- A change to a source invoice affects only that invoice and its distinct items.
-- Financial posting automatically removes the source from these read-only projections.
CREATE OR REPLACE FUNCTION update_staged_daily_activity_delta()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  rec staged_invoice_item_contributions%ROWTYPE;
  sign integer;
BEGIN
  IF TG_OP='DELETE' THEN rec=OLD; sign=-1;
  ELSE rec=NEW; sign=1; END IF;
  INSERT INTO staged_item_daily_activity_cache AS daily
  (company_id,item_id,document_date,
   sale_invoices,sale_return_invoices,sale_lines,sale_return_lines,sale_quantity,sale_return_quantity,
   purchase_invoices,purchase_return_invoices,purchase_lines,purchase_return_lines,purchase_quantity,purchase_return_quantity)
  VALUES (rec.company_id,rec.item_id,rec.document_date,
    CASE WHEN rec.kind='sale' AND rec.positive_lines>0 THEN sign ELSE 0 END,
    CASE WHEN rec.kind='sale' AND rec.negative_lines>0 THEN sign ELSE 0 END,
    CASE WHEN rec.kind='sale' THEN sign*rec.positive_lines ELSE 0 END,
    CASE WHEN rec.kind='sale' THEN sign*rec.negative_lines ELSE 0 END,
    CASE WHEN rec.kind='sale' THEN sign*rec.positive_quantity ELSE 0 END,
    CASE WHEN rec.kind='sale' THEN sign*rec.negative_quantity ELSE 0 END,
    CASE WHEN rec.kind='purchase' AND rec.positive_lines>0 THEN sign ELSE 0 END,
    CASE WHEN rec.kind='purchase' AND rec.negative_lines>0 THEN sign ELSE 0 END,
    CASE WHEN rec.kind='purchase' THEN sign*rec.positive_lines ELSE 0 END,
    CASE WHEN rec.kind='purchase' THEN sign*rec.negative_lines ELSE 0 END,
    CASE WHEN rec.kind='purchase' THEN sign*rec.positive_quantity ELSE 0 END,
    CASE WHEN rec.kind='purchase' THEN sign*rec.negative_quantity ELSE 0 END)
  ON CONFLICT(company_id,item_id,document_date) DO UPDATE SET
    sale_invoices=daily.sale_invoices+EXCLUDED.sale_invoices,
    sale_return_invoices=daily.sale_return_invoices+EXCLUDED.sale_return_invoices,
    sale_lines=daily.sale_lines+EXCLUDED.sale_lines,
    sale_return_lines=daily.sale_return_lines+EXCLUDED.sale_return_lines,
    sale_quantity=daily.sale_quantity+EXCLUDED.sale_quantity,
    sale_return_quantity=daily.sale_return_quantity+EXCLUDED.sale_return_quantity,
    purchase_invoices=daily.purchase_invoices+EXCLUDED.purchase_invoices,
    purchase_return_invoices=daily.purchase_return_invoices+EXCLUDED.purchase_return_invoices,
    purchase_lines=daily.purchase_lines+EXCLUDED.purchase_lines,
    purchase_return_lines=daily.purchase_return_lines+EXCLUDED.purchase_return_lines,
    purchase_quantity=daily.purchase_quantity+EXCLUDED.purchase_quantity,
    purchase_return_quantity=daily.purchase_return_quantity+EXCLUDED.purchase_return_quantity;
  RETURN NULL;
END $$;
CREATE TRIGGER staged_source_contribution_added
  AFTER INSERT ON staged_invoice_item_contributions
  FOR EACH ROW EXECUTE FUNCTION update_staged_daily_activity_delta();
CREATE TRIGGER staged_source_contribution_removed
  AFTER DELETE ON staged_invoice_item_contributions
  FOR EACH ROW EXECUTE FUNCTION update_staged_daily_activity_delta();

CREATE OR REPLACE FUNCTION refresh_staged_source_invoice_cache()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_row legacy_import_staging%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN source_row=OLD; ELSE source_row=NEW; END IF;
  DELETE FROM staged_invoice_item_contributions c
  WHERE c.company_id=source_row.company_id AND c.source_system=source_row.source_system
    AND c.source_kind=source_row.source_kind AND c.source_id=source_row.source_id;
  DELETE FROM staged_invoice_item_lines_cache l
  WHERE l.company_id=source_row.company_id AND l.source_system=source_row.source_system
    AND l.source_kind=source_row.source_kind AND l.source_id=source_row.source_id;
  IF TG_OP='DELETE' THEN RETURN NULL; END IF;
  IF NEW.source_kind<>'invoice' OR NEW.status NOT IN ('pending','failed','excluded')
    OR NEW.source_document->>'type'<>'invoice'
    OR NEW.source_document->'payload'->>'kind' NOT IN ('sale','purchase')
    OR EXISTS(SELECT 1 FROM transaction_source_imports p
      WHERE p.company_id=NEW.company_id AND p.source_system=NEW.source_system
        AND p.source_kind=NEW.source_kind AND p.source_id=NEW.source_id)
  THEN RETURN NULL; END IF;

  INSERT INTO staged_invoice_item_lines_cache
    (company_id,source_system,source_kind,source_id,line_number,document_date,
     kind,item_id,unit,quantity,unit_price,counterparty_account_id,supplier_account_id,currency_id)
  SELECT NEW.company_id,NEW.source_system,NEW.source_kind,NEW.source_id,line.ordinality::integer,
    NEW.posting_date,NEW.source_document->'payload'->>'kind',item.id,
    (line.value->>'unit')::integer,(line.value->>'quantity')::numeric,
    (line.value->>'unitPrice')::numeric,
    (NEW.source_document->'payload'->>'counterpartyAccountId')::integer,
    NULLIF(NEW.source_document->'payload'->>'supplierAccountId','')::integer,
    (NEW.source_document->'payload'->>'currencyId')::integer
  FROM jsonb_array_elements(NEW.source_document->'payload'->'lines')
    WITH ORDINALITY AS line(value,ordinality)
  JOIN items item ON item.company_id=NEW.company_id AND item.id=(line.value->>'itemId')::integer;

  INSERT INTO staged_invoice_item_contributions
    (company_id,source_system,source_kind,source_id,document_date,kind,item_id,
     positive_lines,negative_lines,positive_quantity,negative_quantity)
  SELECT l.company_id,l.source_system,l.source_kind,l.source_id,l.document_date,l.kind,l.item_id,
    count(*) FILTER (WHERE l.quantity>0),count(*) FILTER (WHERE l.quantity<0),
    coalesce(sum(l.quantity*(CASE l.unit WHEN 1 THEN item.factor2::numeric*item.factor3::numeric
      WHEN 2 THEN item.factor3::numeric ELSE 1::numeric END)) FILTER (WHERE l.quantity>0),0),
    coalesce(-sum(l.quantity*(CASE l.unit WHEN 1 THEN item.factor2::numeric*item.factor3::numeric
      WHEN 2 THEN item.factor3::numeric ELSE 1::numeric END)) FILTER (WHERE l.quantity<0),0)
  FROM staged_invoice_item_lines_cache l
  JOIN items item ON item.company_id=l.company_id AND item.id=l.item_id
  WHERE l.company_id=NEW.company_id AND l.source_system=NEW.source_system
    AND l.source_kind=NEW.source_kind AND l.source_id=NEW.source_id
  GROUP BY l.company_id,l.source_system,l.source_kind,l.source_id,l.document_date,l.kind,l.item_id;
  RETURN NULL;
END $$;
CREATE TRIGGER staged_invoice_cache_insert
  AFTER INSERT ON legacy_import_staging FOR EACH ROW
  EXECUTE FUNCTION refresh_staged_source_invoice_cache();
CREATE TRIGGER staged_invoice_cache_update
  AFTER UPDATE OF status,source_document,posting_date ON legacy_import_staging FOR EACH ROW
  EXECUTE FUNCTION refresh_staged_source_invoice_cache();
CREATE TRIGGER staged_invoice_cache_delete
  AFTER DELETE ON legacy_import_staging FOR EACH ROW
  EXECUTE FUNCTION refresh_staged_source_invoice_cache();

CREATE OR REPLACE FUNCTION drop_posted_staged_source_invoice_cache()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_kind='invoice' THEN
    DELETE FROM staged_invoice_item_contributions c
      WHERE c.company_id=NEW.company_id AND c.source_system=NEW.source_system
        AND c.source_kind=NEW.source_kind AND c.source_id=NEW.source_id;
    DELETE FROM staged_invoice_item_lines_cache l
      WHERE l.company_id=NEW.company_id AND l.source_system=NEW.source_system
        AND l.source_kind=NEW.source_kind AND l.source_id=NEW.source_id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER posted_source_drops_staged_invoice_cache
  AFTER INSERT ON transaction_source_imports FOR EACH ROW
  EXECUTE FUNCTION drop_posted_staged_source_invoice_cache();
