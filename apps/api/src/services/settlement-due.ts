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
    LEFT JOIN stock_operations last_count
      ON last_count.company_id=stats.company_id AND last_count.id=stats.last_adjustment_operation_id AND last_count.kind='adjustment'
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
