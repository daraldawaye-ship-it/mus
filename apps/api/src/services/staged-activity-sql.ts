/** Read-only, deduplicated source invoice overlay; NEVER posts accounting or stock. */
export function stagedDailyActivitySql(asOfSql:string, fromSql?:string):string {
  return `WITH source_lines AS (
    SELECT s.company_id,s.source_system,s.source_id,s.posting_date AS document_date,
      s.source_document->'payload'->>'kind' AS kind, i.id AS item_id,
      (part.value->>'quantity')::numeric AS qty,
      (part.value->>'quantity')::numeric *
        CASE (part.value->>'unit')::integer WHEN 1 THEN i.factor2::numeric*i.factor3::numeric
          WHEN 2 THEN i.factor3::numeric ELSE 1::numeric END AS smallest
    FROM legacy_import_staging s
    CROSS JOIN LATERAL jsonb_array_elements(s.source_document->'payload'->'lines') AS part(value)
    JOIN items i ON i.company_id=s.company_id AND i.id=(part.value->>'itemId')::integer
    WHERE s.company_id=$1 AND s.source_kind='invoice'
      AND s.status IN ('pending','failed','excluded')
      AND s.source_document->>'type'='invoice'
      AND s.source_document->'payload'->>'kind' IN ('sale','purchase')
      AND s.posting_date<=${asOfSql}
      ${fromSql?`AND s.posting_date>=${fromSql}`:""}
      AND NOT EXISTS (SELECT 1 FROM transaction_source_imports posted
        WHERE posted.company_id=s.company_id AND posted.source_system=s.source_system
          AND posted.source_kind=s.source_kind AND posted.source_id=s.source_id)
  ), invoice_item AS (
    SELECT company_id,source_system,source_id,document_date,kind,item_id,
      COUNT(*) FILTER(WHERE qty>0) AS positive_lines,
      COUNT(*) FILTER(WHERE qty<0) AS negative_lines,
      COALESCE(SUM(smallest) FILTER(WHERE qty>0),0) AS positive_quantity,
      COALESCE(-SUM(smallest) FILTER(WHERE qty<0),0) AS negative_quantity
    FROM source_lines
    GROUP BY company_id,source_system,source_id,document_date,kind,item_id
  )
  SELECT company_id,item_id,document_date,
    COUNT(*) FILTER(WHERE kind='sale' AND positive_lines>0)::bigint AS sale_invoices,
    COUNT(*) FILTER(WHERE kind='sale' AND negative_lines>0)::bigint AS sale_return_invoices,
    COALESCE(SUM(positive_lines) FILTER(WHERE kind='sale'),0)::bigint AS sale_lines,
    COALESCE(SUM(negative_lines) FILTER(WHERE kind='sale'),0)::bigint AS sale_return_lines,
    COALESCE(SUM(positive_quantity) FILTER(WHERE kind='sale'),0) AS sale_quantity,
    COALESCE(SUM(negative_quantity) FILTER(WHERE kind='sale'),0) AS sale_return_quantity,
    COUNT(*) FILTER(WHERE kind='purchase' AND positive_lines>0)::bigint AS purchase_invoices,
    COUNT(*) FILTER(WHERE kind='purchase' AND negative_lines>0)::bigint AS purchase_return_invoices,
    COALESCE(SUM(positive_lines) FILTER(WHERE kind='purchase'),0)::bigint AS purchase_lines,
    COALESCE(SUM(negative_lines) FILTER(WHERE kind='purchase'),0)::bigint AS purchase_return_lines,
    COALESCE(SUM(positive_quantity) FILTER(WHERE kind='purchase'),0) AS purchase_quantity,
    COALESCE(SUM(negative_quantity) FILTER(WHERE kind='purchase'),0) AS purchase_return_quantity
  FROM invoice_item GROUP BY company_id,item_id,document_date`;
}
export const activityColumns=[
  "company_id","item_id","document_date",
  "sale_invoices","sale_return_invoices","sale_lines","sale_return_lines",
  "sale_quantity","sale_return_quantity",
  "purchase_invoices","purchase_return_invoices","purchase_lines","purchase_return_lines",
  "purchase_quantity","purchase_return_quantity",
] as const;
