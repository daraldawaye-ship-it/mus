/**
 * Rolling comparison uses posted invoice creation timestamps, not document
 * dates: [now - 168h, now) versus [now - 336h, now - 168h).
 * Group every child doctor/entity/nurse card by its current shared name.
 * Keep net totals exact until presentation (whole numbers in the UI).
 * Historical sign repairs follow doctorSalesReportSql.
 *
 * Parameters: companyId, escaped name search, pageSize, offset.
 */
export const doctorMovementComparisonSql = `
WITH cutoff AS (SELECT transaction_timestamp() AS until_at),
recent AS MATERIALIZED (
 SELECT
   COALESCE(NULLIF(btrim(d.shared_name),''),
            NULLIF(btrim(d.name),''),
            NULLIF(btrim(i.doctor_name),''),
            'غير محدد') AS doctor_name,
   CASE WHEN i.created_at >= cutoff.until_at - interval '168 hours'
        THEN 1 ELSE 0 END AS period_index,
   CASE WHEN fix.invoice_id IS NOT NULL
        THEN -i.base_total ELSE i.base_total END AS amount
 FROM invoices i
 CROSS JOIN cutoff
 LEFT JOIN doctors d ON d.company_id=i.company_id AND d.id=i.doctor_id
 LEFT JOIN legacy_sales_sign_repairs fix
   ON fix.company_id=i.company_id AND fix.invoice_id=i.id
 WHERE i.company_id=$1 AND i.kind='sale' AND i.posted=true
   AND i.created_at >= cutoff.until_at - interval '336 hours'
   AND i.created_at < cutoff.until_at
),
by_name AS (
 SELECT
   MIN(doctor_name) AS doctor_name,
   SUM(amount) FILTER (WHERE period_index=1) AS recent_amount,
   SUM(amount) FILTER (WHERE period_index=0) AS previous_amount
 FROM recent
 GROUP BY lower(regexp_replace(btrim(doctor_name),'[[:space:]]+',' ','g'))
),
compared AS (
 SELECT doctor_name,
   COALESCE(recent_amount,0) AS current_amount,
   COALESCE(previous_amount,0) AS prior_amount,
   COALESCE(recent_amount,0)-COALESCE(previous_amount,0) AS difference
 FROM by_name
 WHERE doctor_name ILIKE $2 ESCAPE '\\'
)
SELECT doctor_name AS "doctorName",
 current_amount::text AS "currentAmount",
 prior_amount::text AS "previousAmount",
 difference::text AS "difference",
 count(*) OVER()::integer AS "totalNames",
 COALESCE(sum(current_amount) OVER(),0)::text AS "totalCurrent",
 COALESCE(sum(prior_amount) OVER(),0)::text AS "totalPrevious",
 COALESCE(sum(difference) OVER(),0)::text AS "totalDifference",
 (SELECT until_at FROM cutoff) AS "untilAt"
FROM compared
ORDER BY compared.difference DESC, compared.current_amount DESC, compared.doctor_name ASC
LIMIT $3 OFFSET $4
`;

/** Sort only with a hard-coded SQL whitelist. Values remain numeric for ordering. */
export type DoctorMovementSortKey = "doctorName" | "currentAmount" | "previousAmount" | "difference";
const sortExpressions: Record<DoctorMovementSortKey, string> = {
  doctorName: "lower(compared.doctor_name)",
  currentAmount: "compared.current_amount",
  previousAmount: "compared.prior_amount",
  difference: "compared.difference",
};
export function sortedDoctorMovementComparisonSql(
  key: DoctorMovementSortKey, direction: "asc" | "desc",
): string {
  const expression = sortExpressions[key];
  const directionSql = direction === "asc" ? "ASC" : "DESC";
  return doctorMovementComparisonSql.replace(
    "ORDER BY compared.difference DESC, compared.current_amount DESC, compared.doctor_name ASC",
    `ORDER BY ${expression} ${directionSql}, compared.current_amount DESC, compared.doctor_name ASC`,
  );
}
