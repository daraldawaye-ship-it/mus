-- Manual quantities affect only the dedicated sales activity read projections.
-- Neither migration nor editing updates invoice, stock, journal or canonical daily facts.
CREATE TABLE sales_quantity_corrections (
  company_id integer NOT NULL REFERENCES companies(id),
  source_key text NOT NULL,
  item_id integer NOT NULL,
  invoice_line_id integer,
  source_system varchar(100),
  source_id varchar(100),
  line_number integer NOT NULL,
  source_origin text NOT NULL CHECK (source_origin IN ('posted','staged')),
  source_document_date date NOT NULL,
  source_staged_unit integer,
  source_staged_quantity numeric,
  original_smallest numeric NOT NULL,
  first_unit_multiplier numeric NOT NULL CHECK (first_unit_multiplier>0),
  corrected_quantity numeric(26,4),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  revision integer NOT NULL DEFAULT 1 CHECK (revision>=1),
  changed_by integer NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(company_id,source_key),
  CHECK ((invoice_line_id IS NOT NULL AND source_system IS NULL AND source_id IS NULL AND source_origin='posted')
      OR (invoice_line_id IS NULL AND source_system IS NOT NULL AND source_id IS NOT NULL)),
  CHECK ((source_origin='posted' AND source_staged_unit IS NULL AND source_staged_quantity IS NULL)
      OR (source_origin='staged' AND source_staged_unit IS NOT NULL AND source_staged_quantity IS NOT NULL))
);
CREATE INDEX sales_quantity_corrections_item
  ON sales_quantity_corrections(company_id,item_id) WHERE corrected_quantity IS NOT NULL;

-- Historical sign repairs have already changed the canonical activity
-- projection. Match the same official snapshot used by the invoice DTO.
CREATE VIEW sales_quantity_posting_basis AS
SELECT l.company_id,l.id,l.invoice_id,l.item_id,l.line_number,
  i.document_date,i.number,l.unit,l.unit_name,
  (l.factor2::numeric*l.factor3::numeric) AS pack,
  CASE WHEN fix.invoice_id IS NULL THEN l.smallest_quantity::numeric
       ELSE snapshot.smallest_quantity END AS raw
FROM invoice_lines l
JOIN invoices i ON i.company_id=l.company_id AND i.id=l.invoice_id AND i.posted AND i.kind='sale'
LEFT JOIN legacy_sales_sign_repairs fix ON fix.company_id=i.company_id AND fix.invoice_id=i.id
LEFT JOIN LATERAL (
  SELECT CASE WHEN count(*)=1 THEN
    max(CASE WHEN value->>'smallestQuantity' ~ '^-?[0-9]{1,40}$'
             THEN (value->>'smallestQuantity')::numeric END) END AS smallest_quantity
  FROM jsonb_array_elements(fix.line_snapshots)
  WHERE value->>'lineNumber'=l.line_number::text
) snapshot ON fix.invoice_id IS NOT NULL
WHERE l.factor2>0 AND l.factor3>0;

CREATE VIEW sales_quantity_correction_posted_sources AS
SELECT l.company_id,l.item_id,
  CASE WHEN m.invoice_id IS NULL THEN jsonb_build_array('posted',l.id)
       ELSE jsonb_build_array('legacy',m.source_system,m.source_id,l.line_number) END::text AS source_key,
  CASE WHEN m.invoice_id IS NULL THEN l.id END AS invoice_line_id,
  m.source_system,m.source_id,l.line_number,
  'posted'::text AS source_kind,l.document_date,l.number AS invoice_number,
  l.raw AS original_smallest,l.pack AS first_unit_multiplier,
  COALESCE(CASE WHEN l.unit=1 THEN NULLIF(l.unit_name,'') END,it.unit1_name) AS unit_name,
  NULL::integer AS staged_unit,NULL::numeric AS staged_quantity,
  (l.raw IS NOT NULL) AS can_correct
FROM sales_quantity_posting_basis l
JOIN items it ON it.company_id=l.company_id AND it.id=l.item_id
LEFT JOIN transaction_source_imports m ON m.company_id=l.company_id AND m.invoice_id=l.invoice_id AND m.source_kind='invoice';

CREATE VIEW sales_quantity_correction_staged_sources AS
SELECT l.company_id,l.item_id,jsonb_build_array('legacy',l.source_system,l.source_id,l.line_number)::text AS source_key,
  NULL::integer AS invoice_line_id,l.source_system,l.source_id,l.line_number,
  'staged'::text AS source_kind,l.document_date,NULL::text AS invoice_number,
  CASE WHEN l.unit=3 THEN l.quantity
       WHEN l.quantity=0 THEN 0::numeric
       WHEN totals.known_unit_multiplier>0 THEN l.quantity*totals.known_unit_multiplier END AS original_smallest,
  CASE WHEN l.unit=1 AND totals.known_unit_multiplier>0 THEN totals.known_unit_multiplier
       ELSE it.factor2::numeric*it.factor3::numeric END AS first_unit_multiplier,
  it.unit1_name AS unit_name,l.unit AS staged_unit,l.quantity AS staged_quantity,
  (it.factor2>0 AND it.factor3>0 AND (l.unit=3 OR l.quantity=0 OR COALESCE(totals.known_unit_multiplier,0)>0)) AS can_correct
FROM staged_invoice_item_lines_cache l
JOIN items it ON it.company_id=l.company_id AND it.id=l.item_id
JOIN staged_invoice_item_contributions a ON a.company_id=l.company_id AND a.source_system=l.source_system
  AND a.source_kind=l.source_kind AND a.source_id=l.source_id AND a.item_id=l.item_id
CROSS JOIN LATERAL (
  -- Staged facts did not store per-line factors. If all same-sign lines
  -- use one unit, the signed contribution proves their exact multiplier.
  SELECT CASE WHEN COUNT(DISTINCT siblings.unit)=1 AND SUM(abs(siblings.quantity))>0
    AND mod(CASE WHEN l.quantity>0 THEN a.positive_quantity ELSE a.negative_quantity END,
            NULLIF(SUM(abs(siblings.quantity)),0))=0
    THEN (CASE WHEN l.quantity>0 THEN a.positive_quantity ELSE a.negative_quantity END) /
         NULLIF(SUM(abs(siblings.quantity)),0) END AS known_unit_multiplier
  FROM staged_invoice_item_lines_cache siblings
  WHERE siblings.company_id=l.company_id AND siblings.source_system=l.source_system
    AND siblings.source_kind=l.source_kind AND siblings.source_id=l.source_id
    AND siblings.item_id=l.item_id AND sign(siblings.quantity)=sign(l.quantity)
) totals
WHERE l.source_kind='invoice' AND l.kind='sale' AND l.unit IN (1,2,3)
  AND NOT EXISTS (SELECT 1 FROM transaction_source_imports m
    WHERE m.company_id=l.company_id AND m.source_system=l.source_system
      AND m.source_kind=l.source_kind AND m.source_id=l.source_id);

-- Per correction we resolve the immutable posted line by PK or unique import
-- mapping plus ordinal. If it is still staged, retain the signed source
-- snapshot and never reuse it for an edited source row or another item.
CREATE VIEW sales_quantity_activity_deltas AS
WITH resolved AS (
  SELECT c.company_id,c.item_id,
    CASE WHEN posted.item_id IS NOT NULL THEN posted.document_date ELSE s.document_date END AS document_date,
    CASE WHEN posted.item_id IS NOT NULL THEN posted.raw ELSE c.original_smallest END AS original_smallest,
    c.corrected_quantity * CASE WHEN posted.item_id IS NOT NULL THEN posted.pack
         ELSE c.first_unit_multiplier END AS corrected_smallest
  FROM sales_quantity_corrections c
  LEFT JOIN transaction_source_imports m ON c.source_system IS NOT NULL
    AND m.company_id=c.company_id AND m.source_kind='invoice'
    AND m.source_system=c.source_system AND m.source_id=c.source_id
  LEFT JOIN LATERAL (
    SELECT l.item_id,l.document_date,l.raw,l.pack
    FROM sales_quantity_posting_basis l
    WHERE c.invoice_line_id IS NOT NULL AND l.company_id=c.company_id AND l.id=c.invoice_line_id
      AND l.item_id=c.item_id AND l.raw IS NOT NULL
    UNION ALL
    SELECT l.item_id,l.document_date,l.raw,l.pack
    FROM sales_quantity_posting_basis l
    WHERE m.invoice_id IS NOT NULL AND l.company_id=c.company_id AND l.invoice_id=m.invoice_id
      AND l.line_number=c.line_number AND l.item_id=c.item_id AND l.raw IS NOT NULL
  ) posted ON TRUE
  LEFT JOIN staged_invoice_item_lines_cache s ON m.invoice_id IS NULL AND c.source_origin='staged'
    AND s.company_id=c.company_id AND s.source_kind='invoice' AND s.kind='sale'
    AND s.source_system=c.source_system AND s.source_id=c.source_id AND s.line_number=c.line_number
    AND s.item_id=c.item_id AND s.document_date=c.source_document_date
    AND s.unit=c.source_staged_unit AND s.quantity=c.source_staged_quantity
  WHERE c.corrected_quantity IS NOT NULL AND (posted.item_id IS NOT NULL OR s.item_id IS NOT NULL)
)
SELECT company_id,item_id,document_date,
  GREATEST(corrected_smallest,0)-GREATEST(original_smallest,0) AS sale_quantity,
  GREATEST(-corrected_smallest,0)-GREATEST(-original_smallest,0) AS sale_return_quantity
FROM resolved;
