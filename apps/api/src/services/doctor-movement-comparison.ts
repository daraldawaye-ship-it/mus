/**
 * Both 168h windows use transaction_timestamp() and the invoice/payment
 * creation instant, never document_date. All sums are numeric in base YER.
 *
 * Medical (commission) and slips are distinct payment types, counted from
 * the original immutable operation rows only, NEVER their journal lines.
 * Two supported sources: administrative_custody_transfers and
 * direct_medical_payments. Both require the linked voucher to be posted.
 *
 * $1 companyId, $2 escaped name pattern, $3 limit, $4 offset,
 * $5 finance-view authorized.
 */
export const doctorMovementComparisonSql = `
WITH cutoff AS (SELECT transaction_timestamp() AS until_at),
recent_sales AS MATERIALIZED (
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
sales_by_name AS (
 SELECT lower(regexp_replace(btrim(doctor_name),'[[:space:]]+',' ','g')) AS name_key,
   MIN(doctor_name) AS doctor_name,
   COALESCE(SUM(amount) FILTER (WHERE period_index=1),0) AS recent_amount,
   COALESCE(SUM(amount) FILTER (WHERE period_index=0),0) AS previous_amount,
   COUNT(*) FILTER (WHERE period_index=1)::bigint AS recent_invoice_count,
   COUNT(*) FILTER (WHERE period_index=0)::bigint AS previous_invoice_count
 FROM recent_sales
 GROUP BY lower(regexp_replace(btrim(doctor_name),'[[:space:]]+',' ','g'))
),
payout_events AS MATERIALIZED (
 SELECT
   COALESCE(NULLIF(btrim(d.shared_name),''),
            NULLIF(btrim(d.name),''),
            NULLIF(btrim(t.doctor_main_name),'')) AS doctor_name,
   t.expense_kind,
   t.amount::numeric AS amount,
   CASE WHEN t.created_at >= cutoff.until_at - interval '168 hours' THEN 1 ELSE 0 END AS period_index
 FROM administrative_custody_transfers t
 CROSS JOIN cutoff
 JOIN financial_documents fd ON fd.company_id=t.company_id
   AND fd.id=t.financial_document_id AND fd.status='posted'
 LEFT JOIN doctors d ON d.company_id=t.company_id AND d.id=t.doctor_id
 WHERE $5::boolean AND t.company_id=$1
   AND t.expense_kind IN ('medical','slips') AND t.amount>0
   AND NOT EXISTS (SELECT 1 FROM administrative_custody_medical_corrections c
     WHERE c.company_id=t.company_id AND c.source_transfer_id=t.id AND c.created_at < cutoff.until_at)
   AND t.created_at >= cutoff.until_at - interval '336 hours'
   AND t.created_at < cutoff.until_at
 UNION ALL
 SELECT
   COALESCE(NULLIF(btrim(d.shared_name),''),
            NULLIF(btrim(d.name),''),
            NULLIF(btrim(p.doctor_main_name),'')) AS doctor_name,
   p.expense_kind,
   p.amount::numeric AS amount,
   CASE WHEN p.created_at >= cutoff.until_at - interval '168 hours' THEN 1 ELSE 0 END AS period_index
 FROM direct_medical_payments p
 CROSS JOIN cutoff
 JOIN financial_documents fd ON fd.company_id=p.company_id
   AND fd.id=p.financial_document_id AND fd.status='posted'
 LEFT JOIN doctors d ON d.company_id=p.company_id AND d.id=p.doctor_id
 WHERE $5::boolean AND p.company_id=$1
   AND p.expense_kind IN ('medical','slips')
   AND p.created_at >= cutoff.until_at - interval '336 hours'
   AND p.created_at < cutoff.until_at
),
payout_by_name AS (
 SELECT lower(regexp_replace(btrim(doctor_name),'[[:space:]]+',' ','g')) AS name_key,
   MIN(doctor_name) AS doctor_name,
   COALESCE(SUM(amount) FILTER (WHERE expense_kind='medical' AND period_index=1),0) AS paid_recent,
   COALESCE(SUM(amount) FILTER (WHERE expense_kind='medical' AND period_index=0),0) AS paid_previous,
   COALESCE(SUM(amount) FILTER (WHERE expense_kind='slips' AND period_index=1),0) AS slips_recent,
   COALESCE(SUM(amount) FILTER (WHERE expense_kind='slips' AND period_index=0),0) AS slips_previous
 FROM payout_events
 WHERE NULLIF(btrim(doctor_name),'') IS NOT NULL
 GROUP BY lower(regexp_replace(btrim(doctor_name),'[[:space:]]+',' ','g'))
),
doctor_details AS (
 SELECT lower(regexp_replace(
    btrim(COALESCE(NULLIF(btrim(d.shared_name),''),d.name)),
    '[[:space:]]+',' ','g')) AS name_key,
   (array_agg(d.kind ORDER BY
     (btrim(d.name)=btrim(COALESCE(NULLIF(btrim(d.shared_name),''),d.name))) DESC,
     d.active DESC,d.id ASC))[1] AS category,
   (array_agg(NULLIF(btrim(d.department),'') ORDER BY
     (btrim(d.name)=btrim(COALESCE(NULLIF(btrim(d.shared_name),''),d.name))) DESC,
     d.active DESC,d.id ASC)
     FILTER (WHERE NULLIF(btrim(d.department),'') IS NOT NULL))[1] AS department,
   (array_agg(NULLIF(btrim(d.phone),'') ORDER BY
     (btrim(d.name)=btrim(COALESCE(NULLIF(btrim(d.shared_name),''),d.name))) DESC,
     d.active DESC,d.id ASC)
     FILTER (WHERE NULLIF(btrim(d.phone),'') IS NOT NULL))[1] AS phone
 FROM doctors d WHERE d.company_id=$1
 GROUP BY lower(regexp_replace(
    btrim(COALESCE(NULLIF(btrim(d.shared_name),''),d.name)),
    '[[:space:]]+',' ','g'))
),
name_keys AS (
 SELECT name_key FROM sales_by_name UNION SELECT name_key FROM payout_by_name
),
compared AS (
 SELECT COALESCE(s.doctor_name,p.doctor_name,'غير محدد') AS doctor_name,
   COALESCE(meta.category,'') AS category,
   COALESCE(meta.department,'') AS department,
   COALESCE(meta.phone,'') AS phone,
   COALESCE(s.recent_amount,0) AS current_amount,
   COALESCE(s.previous_amount,0) AS prior_amount,
   COALESCE(s.recent_amount,0)-COALESCE(s.previous_amount,0) AS difference,
   COALESCE(s.recent_invoice_count,0)::bigint AS invoice_count_current,
   COALESCE(s.previous_invoice_count,0)::bigint AS invoice_count_previous,
   (COALESCE(s.recent_invoice_count,0)-COALESCE(s.previous_invoice_count,0))::bigint AS invoice_count_difference,
   CASE WHEN $5::boolean THEN COALESCE(p.paid_recent,0) ELSE NULL::numeric END AS paid_current,
   CASE WHEN $5::boolean THEN COALESCE(p.paid_previous,0) ELSE NULL::numeric END AS paid_previous,
   CASE WHEN $5::boolean THEN COALESCE(p.slips_recent,0) ELSE NULL::numeric END AS slips_current,
   CASE WHEN $5::boolean THEN COALESCE(p.slips_previous,0) ELSE NULL::numeric END AS slips_previous
 FROM name_keys nk
 LEFT JOIN sales_by_name s ON s.name_key=nk.name_key
 LEFT JOIN payout_by_name p ON p.name_key=nk.name_key
 LEFT JOIN doctor_details meta ON meta.name_key=nk.name_key
 WHERE COALESCE(s.doctor_name,p.doctor_name,'غير محدد') ILIKE $2 ESCAPE '\\'
)
SELECT doctor_name AS "doctorName",
 category,department,phone,
 current_amount::text AS "currentAmount",
 prior_amount::text AS "previousAmount",
 difference::text AS "difference",
 invoice_count_current::text AS "invoiceCountCurrent",
 invoice_count_previous::text AS "invoiceCountPrevious",
 invoice_count_difference::text AS "invoiceCountDifference",
 paid_current::text AS "paidCurrent",
 paid_previous::text AS "paidPrevious",
 slips_current::text AS "slipsCurrent",
 slips_previous::text AS "slipsPrevious",
 count(*) OVER()::integer AS "totalNames",
 COALESCE(sum(current_amount) OVER(),0)::text AS "totalCurrent",
 COALESCE(sum(prior_amount) OVER(),0)::text AS "totalPrevious",
 COALESCE(sum(difference) OVER(),0)::text AS "totalDifference",
 (SELECT until_at FROM cutoff) AS "untilAt"
FROM compared
ORDER BY compared.difference DESC, compared.current_amount DESC, compared.doctor_name ASC
LIMIT $3 OFFSET $4
`;

/** SQL sort expressions remain numeric. No client sorting after pagination. */
export type DoctorMovementSortKey =
  | "doctorName" | "category" | "department" | "phone"
  | "currentAmount" | "previousAmount" | "difference"
  | "invoiceCountCurrent" | "invoiceCountPrevious" | "invoiceCountDifference"
  | "paidCurrent" | "paidPrevious" | "slipsCurrent" | "slipsPrevious";
const sortExpressions: Record<DoctorMovementSortKey,string> = {
  doctorName:"lower(compared.doctor_name)",
  category:"lower(compared.category)",
  department:"lower(compared.department)",
  phone:"compared.phone",
  currentAmount:"compared.current_amount",
  previousAmount:"compared.prior_amount",
  difference:"compared.difference",
  invoiceCountCurrent:"compared.invoice_count_current",
  invoiceCountPrevious:"compared.invoice_count_previous",
  invoiceCountDifference:"compared.invoice_count_difference",
  paidCurrent:"compared.paid_current",
  paidPrevious:"compared.paid_previous",
  slipsCurrent:"compared.slips_current",
  slipsPrevious:"compared.slips_previous",
};
export function sortedDoctorMovementComparisonSql(
  key:DoctorMovementSortKey,direction:"asc"|"desc",
):string {
  const expression=sortExpressions[key];
  const dir=direction==="asc"?"ASC":"DESC";
  return doctorMovementComparisonSql.replace(
    "ORDER BY compared.difference DESC, compared.current_amount DESC, compared.doctor_name ASC",
    `ORDER BY ${expression} ${dir} NULLS LAST, compared.current_amount DESC, compared.doctor_name ASC`,
  );
}
