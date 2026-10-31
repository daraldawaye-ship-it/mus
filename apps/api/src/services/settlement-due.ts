/**
 * One source of truth for the "الأصناف المطلوب جردها فقط" filter in
 * متابعة التسويات. The task candidate list and reconciliation rewards
 * deliberately reuse this exact relation + predicate. Keep changes to
 * the due rules here, not independently in other routes.
 */
export const settlementDuePredicate = `(
  last_count.id IS NULL
  OR ((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Aden')::date - last_count.document_date) > count_limit.raw_limit
  OR COALESCE(stats.stock_showroom, 0) < 0
  OR (i.stocktake_required_at IS NOT NULL AND i.stocktake_required_at > last_count.created_at)
)`;

export function settlementFollowUpFrom(importanceParameter: string): string {
  return `FROM items i
    JOIN company_currencies c
      ON c.company_id=i.company_id AND c.id=i.currency_id
    LEFT JOIN item_statistics stats
      ON stats.company_id=i.company_id AND stats.item_id=i.id
    LEFT JOIN LATERAL (
      -- Prefer the cached latest operation. Some imported/legacy items have
      -- no statistics row: use the indexed immutable operation history then.
      SELECT o.id,o.document_date,o.created_at
      FROM stock_operations o
      WHERE o.company_id=i.company_id AND o.kind='adjustment'
        AND o.id=stats.last_adjustment_operation_id
      UNION ALL
      SELECT o.id,o.document_date,o.created_at
      FROM stock_operations o
      WHERE o.company_id=i.company_id AND o.kind='adjustment'
        AND stats.last_adjustment_operation_id IS NULL
        AND o.creation_payload->>'itemId'=i.id::text
      ORDER BY id DESC LIMIT 1
    ) last_count ON true
    LEFT JOIN LATERAL (
      SELECT sum(d.sale_invoices - d.sale_return_invoices) AS monthly_sales
      FROM item_daily_activity d
      WHERE d.company_id=i.company_id AND d.item_id=i.id
        AND d.document_date BETWEEN
          ((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Aden')::date - interval '1 month' + interval '1 day')::date
          AND (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Aden')::date
    ) activity ON true
    LEFT JOIN LATERAL (
      SELECT (${importanceParameter}::numeric * 30) / (GREATEST(COALESCE(activity.monthly_sales, 0), 0) + 5) AS raw_limit
    ) count_limit ON true`;
}
