/** Precomputed, incrementally maintained read-only historical source activity.
 * Source/import triggers update this table on stage, status change and post.
 * Search and reports must never rebuild aggregate counts from invoice JSON.
 */
export function stagedDailyActivitySql(asOfSql: string, fromSql?: string): string {
  return \`SELECT company_id,item_id,document_date,
    sale_invoices,sale_return_invoices,sale_lines,sale_return_lines,
    sale_quantity,sale_return_quantity,purchase_invoices,purchase_return_invoices,
    purchase_lines,purchase_return_lines,purchase_quantity,purchase_return_quantity
    FROM staged_item_daily_activity_cache
    WHERE company_id=$1 AND document_date<=\${asOfSql}
    \${fromSql ? \`AND document_date>=\${fromSql}\` : ""}\`;
}
export const activityColumns=[
  "company_id","item_id","document_date",
  "sale_invoices","sale_return_invoices","sale_lines","sale_return_lines",
  "sale_quantity","sale_return_quantity",
  "purchase_invoices","purchase_return_invoices","purchase_lines","purchase_return_lines",
  "purchase_quantity","purchase_return_quantity",
] as const;
