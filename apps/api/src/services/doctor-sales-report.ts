/**
 * Posted sales only. Invoice totals are signed (returns/negative rows reduce
 * sales). Legacy sign repairs must match the customer-visible invoice DTO.
 * Aggregate across currencies in each doctor's company base currency, while
 * also showing original-currency breakdowns rather than adding unlike money.
 *
 * Database parameters: companyId, from, to, nameLike, limit, offset.
 */
export const doctorSalesReportSql = `
WITH eligible AS MATERIALIZED (
  SELECT
    CASE WHEN i.doctor_id IS NOT NULL
      THEN 'id:' || i.doctor_id::text
      WHEN NULLIF(btrim(i.doctor_name),'') IS NOT NULL
      THEN 'name:' || lower(regexp_replace(btrim(i.doctor_name),'[[:space:]]+',' ','g'))
      ELSE 'unassigned' END AS doctor_key,
    COALESCE(NULLIF(btrim(d.name),''),NULLIF(btrim(i.doctor_name),''),'غير محدد') AS doctor_name,
    d.kind AS doctor_kind,
    i.currency_code,
    i.base_currency_code,
    CASE WHEN fix.invoice_id IS NOT NULL
      THEN fix.corrected_total::numeric ELSE i.total END AS net_amount,
    CASE WHEN fix.invoice_id IS NOT NULL
      THEN -i.base_total ELSE i.base_total END AS net_base_amount,
    CASE WHEN fix.invoice_id IS NOT NULL
      THEN fix.corrected_total::numeric < 0 ELSE i.is_return END AS is_return
  FROM invoices i
  LEFT JOIN doctors d ON d.company_id=i.company_id AND d.id=i.doctor_id
  LEFT JOIN legacy_sales_sign_repairs fix
    ON fix.company_id=i.company_id AND fix.invoice_id=i.id
  WHERE i.company_id=$1 AND i.kind='sale' AND i.posted=true
    AND i.document_date >= $2::date AND i.document_date <= $3::date
    AND COALESCE(NULLIF(btrim(d.name),''),NULLIF(btrim(i.doctor_name),''),'غير محدد')
      ILIKE $4 ESCAPE '\\'
),
per_currency AS (
  SELECT doctor_key,MIN(doctor_name) AS doctor_name,
    MAX(doctor_kind) AS doctor_kind,currency_code,base_currency_code,
    count(*)::integer AS invoice_count,
    count(*) FILTER (WHERE is_return)::integer AS return_count,
    sum(net_amount) AS net_amount,
    sum(net_base_amount) AS net_base_amount
  FROM eligible
  GROUP BY doctor_key,currency_code,base_currency_code
),
per_doctor AS (
  SELECT doctor_key,MIN(doctor_name) AS doctor_name,
    MAX(doctor_kind) AS doctor_kind,
    sum(invoice_count)::integer AS invoice_count,
    sum(return_count)::integer AS return_count,
    sum(net_base_amount) AS net_base_amount,
    MIN(base_currency_code) AS base_currency_code,
    json_agg(json_build_object(
      'currencyCode',currency_code,
      'netAmount',net_amount::text,
      'invoiceCount',invoice_count,
      'returnCount',return_count
    ) ORDER BY currency_code) AS currencies
  FROM per_currency
  GROUP BY doctor_key
)
SELECT doctor_key AS "doctorKey",doctor_name AS "doctorName",
  doctor_kind AS "doctorKind",invoice_count AS "invoiceCount",
  return_count AS "returnCount",
  net_base_amount::text AS "netBaseAmount",
  base_currency_code AS "baseCurrencyCode",
  currencies,
  count(*) OVER()::integer AS "totalDoctors",
  sum(net_base_amount) OVER()::text AS "periodBaseTotal",
  sum(invoice_count) OVER()::integer AS "periodInvoiceCount",
  sum(return_count) OVER()::integer AS "periodReturnCount"
FROM per_doctor
ORDER BY net_base_amount DESC,doctor_name ASC,doctor_key ASC
LIMIT $5 OFFSET $6
`;
