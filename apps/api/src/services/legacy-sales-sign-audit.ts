import type { PoolClient } from "pg";

/**
 * Read-only forensic view of posted October 2026 legacy sales.
 *
 * Source quantities are stock deltas; posted invoice quantities are sale
 * quantities. Matching signs therefore indicate a conversion error.
 *
 * This report NEVER writes to stock, invoices, valuations or ledgers.
 * In particular, a later physical count must be reconciled independently
 * before authorizing any monetary or inventory remediation.
 */
export const LEGACY_SOURCE_SYSTEM = "dar-aldawa-legacy-2026-10";

export function classifyLegacySaleSign(
  originalQuantity: string,
  postedQuantity: string,
): "unconverted" | "converted" | "invalid" {
  const decimal = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
  if (!decimal.test(originalQuantity) || !decimal.test(postedQuantity))
    return "invalid";
  const original = Number(originalQuantity);
  const posted = Number(postedQuantity);
  if (!Number.isFinite(original) || !Number.isFinite(posted) || !original || !posted)
    return "invalid";
  return Math.sign(original) === Math.sign(posted) ? "unconverted" : "converted";
}

const sourceCte = `
WITH source_lines AS MATERIALIZED (
  SELECT i.id AS invoice_id, i.document_date, s.source_id,
    l.id AS line_id, l.line_number, l.item_id,
    l.quantity AS posted_qty, l.smallest_quantity AS posted_smallest,
    l.total AS posted_line_total, l.original_line_id,
    it.legacy_id::text AS mapped_legacy_item_id,
    r.source_row,
    (r.source_row->>'الكمية_المحسوبة_اخيرا') AS source_qty_text
  FROM transaction_source_imports s
  JOIN invoices i ON i.company_id=s.company_id AND i.id=s.invoice_id AND i.kind='sale'
  JOIN invoice_lines l ON l.company_id=i.company_id AND l.invoice_id=i.id
  JOIN items it ON it.company_id=l.company_id AND it.id=l.item_id
  LEFT JOIN LATERAL (
    SELECT value AS source_row, ordinality AS n
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(s.source_metadata->'sourceRows')='array'
      THEN s.source_metadata->'sourceRows' ELSE '[]'::jsonb END
    ) WITH ORDINALITY
  ) r ON r.n=l.line_number
  WHERE s.company_id=$1 AND s.source_system='dar-aldawa-legacy-2026-10'
    AND s.source_kind='invoice'
    AND s.source_id>='261001' AND s.source_id<'261101'
),
checked AS MATERIALIZED (
  SELECT x.*,
    CASE WHEN source_qty_text ~ '^-?[0-9]+(?:\\.[0-9]+)?$'
    THEN source_qty_text::numeric ELSE NULL END AS source_qty,
    ((source_row->>'معرف_الصنف') IS DISTINCT FROM mapped_legacy_item_id)
      AS wrong_item,
    (source_row->>'نوع_العمليه') IS DISTINCT FROM 'فاتورة مبيعات'
      AS wrong_source_kind
  FROM source_lines x
),
classified AS MATERIALIZED (
  SELECT x.*,
    (source_qty IS NOT NULL AND source_qty<>0 AND posted_qty*source_qty>0)
      AS unconverted_sign,
    (source_qty IS NOT NULL AND source_qty<>0 AND posted_qty*source_qty<0)
      AS converted_sign,
    (source_qty IS NULL OR source_qty=0 OR wrong_item OR wrong_source_kind)
      AS invalid_source,
    EXISTS(
      SELECT 1 FROM stock_movements m
      WHERE m.company_id=$1 AND m.invoice_line_id=x.line_id AND m.operation_id IS NULL
      HAVING count(*)<>1
    ) AS split_movement,
    EXISTS(
      SELECT 1 FROM stock_movements m
      WHERE m.company_id=$1 AND m.item_id=x.item_id
        AND m.operation_id IS NOT NULL AND m.document_date >= x.document_date
    ) AS later_stock_operation
  FROM checked x
)
`;

export async function getLegacySalesSignAudit(
  client: PoolClient,
  companyId: number,
  afterSourceId: string,
  limit: number,
) {
  const params = [companyId, afterSourceId, limit];
  const summary = await client.query(
    `${sourceCte}
    SELECT count(*)::int AS checked_lines,
      count(DISTINCT invoice_id)::int AS checked_invoices,
      count(*) FILTER(WHERE unconverted_sign AND NOT invalid_source)::int AS unconverted_lines,
      count(DISTINCT invoice_id) FILTER(WHERE unconverted_sign AND NOT invalid_source)::int AS affected_invoices,
      count(DISTINCT item_id) FILTER(WHERE unconverted_sign AND NOT invalid_source)::int AS affected_items,
      count(*) FILTER(WHERE converted_sign AND NOT invalid_source)::int AS already_converted_lines,
      count(*) FILTER(WHERE unconverted_sign AND posted_qty<0)::int AS sales_recorded_as_returns,
      count(*) FILTER(WHERE unconverted_sign AND posted_qty>0)::int AS returns_recorded_as_sales,
      count(*) FILTER(WHERE invalid_source)::int AS invalid_source_lines,
      count(*) FILTER(WHERE unconverted_sign AND split_movement)::int AS split_movement_lines,
      count(*) FILTER(WHERE unconverted_sign AND abs(source_qty)<>abs(posted_qty))::int AS quantity_conversion_lines,
      count(DISTINCT item_id) FILTER(WHERE unconverted_sign AND later_stock_operation)::int AS affected_items_with_later_stock_operations,
      count(DISTINCT invoice_id) FILTER(WHERE unconverted_sign AND later_stock_operation)::int AS affected_invoices_with_later_stock_operations,
      COALESCE(sum(CASE WHEN unconverted_sign AND NOT invalid_source THEN -2*posted_line_total ELSE 0 END),0)::text AS indicative_sales_difference
    FROM classified`,
    [companyId],
  );
  const page = await client.query(
    `${sourceCte}
    SELECT source_id, invoice_id, min(document_date)::text AS document_date,
      count(*) FILTER(WHERE unconverted_sign AND NOT invalid_source)::int AS wrong_lines,
      count(*) FILTER(WHERE invalid_source)::int AS invalid_lines,
      count(*) FILTER(WHERE split_movement AND unconverted_sign)::int AS split_movements,
      count(*) FILTER(WHERE unconverted_sign AND abs(source_qty)<>abs(posted_qty))::int AS quantity_conversions,
      bool_or(unconverted_sign AND later_stock_operation) AS has_later_stock_operation,
      coalesce(sum(CASE WHEN unconverted_sign AND NOT invalid_source THEN -2*posted_line_total ELSE 0 END),0)::text AS indicative_sales_difference
    FROM classified
    WHERE source_id>$2
    GROUP BY source_id,invoice_id
    HAVING count(*) FILTER(WHERE unconverted_sign AND NOT invalid_source)>0
    ORDER BY source_id
    LIMIT $3`, params,
  );
  const anyCount = await client.query(
    `SELECT count(*)::int AS completed_runs,coalesce(sum(changed_count),0)::int AS counted_changes
     FROM opening_inventory_runs WHERE company_id=$1 AND status='completed'
       AND document_date >= '2026-10-01' AND document_date<'2026-11-01'`,
    [companyId],
  );
  return {
    companyId,
    sourceSystem: LEGACY_SOURCE_SYSTEM,
    sourceMonth: "2026-10",
    readOnly: true,
    correctionApplied: false,
    note: "لا تُصحح مخزونًا أو قيودًا من هذا التقرير: قد تكون تسويات الجرد اللاحقة قد أعادت مطابقة الأرصدة.",
    summary: summary.rows[0],
    openingCount: anyCount.rows[0],
    invoices: page.rows,
    nextAfterSourceId: page.rows.length === limit ? page.rows.at(-1)?.source_id : null,
  };
}
