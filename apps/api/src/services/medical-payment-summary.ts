// Only the original, posted medical disbursements count. Never sum their
// journal lines or include slip payouts or movements merely funding custody.
export const medicalPaymentSortKeys = ["name", "direct", "custody", "total"] as const;
export type MedicalPaymentSortKey = typeof medicalPaymentSortKeys[number];

export function medicalPaymentSummarySql(sort: MedicalPaymentSortKey, direction: "asc"|"desc") {
  const column = { name: "name", direct: "direct_amount", custody: "custody_amount", total: "total_amount" }[sort];
  return `
WITH custody AS (
  SELECT t.doctor_id, t.doctor_main_name, t.doctor_name, t.doctor_kind,
    t.amount, 'custody' AS source
  FROM administrative_custody_transfers t
  JOIN financial_documents fd
    ON fd.company_id=t.company_id AND fd.id=t.financial_document_id
  WHERE t.company_id=$1 AND t.expense_kind='medical' AND t.amount>0
    AND fd.status='posted' AND fd.document_date BETWEEN $2::date AND $3::date
    AND NOT EXISTS (SELECT 1 FROM administrative_custody_medical_corrections c
      WHERE c.company_id=t.company_id AND c.source_transfer_id=t.id)
), events AS (
  SELECT * FROM custody
  UNION ALL
  SELECT p.doctor_id, p.doctor_main_name, p.doctor_name, p.doctor_kind,
    p.amount, 'direct' AS source
  FROM direct_medical_payments p
  JOIN financial_documents fd
    ON fd.company_id=p.company_id AND fd.id=p.financial_document_id
  WHERE p.company_id=$1 AND p.expense_kind='medical' AND p.amount>0
    AND fd.status='posted' AND fd.document_date BETWEEN $2::date AND $3::date
), named AS (
  SELECT COALESCE(NULLIF(btrim(d.shared_name),''),
           NULLIF(btrim(d.name),''), NULLIF(btrim(e.doctor_main_name),''),
           NULLIF(btrim(e.doctor_name),'')) AS name,
    COALESCE(d.kind,e.doctor_kind) AS kind, e.amount, e.source
  FROM events e
  LEFT JOIN doctors d ON d.company_id=$1 AND d.id=e.doctor_id
), grouped AS (
  SELECT min(name) AS name, array_agg(DISTINCT kind ORDER BY kind) AS kinds,
    COALESCE(sum(amount) FILTER (WHERE source='direct'),0) AS direct_amount,
    COALESCE(sum(amount) FILTER (WHERE source='custody'),0) AS custody_amount,
    sum(amount) AS total_amount
  FROM named WHERE name IS NOT NULL AND kind IN ('doctor','nurse')
  GROUP BY lower(regexp_replace(name,'[[:space:]]+',' ','g'))
)
SELECT grouped.name, kinds, direct_amount::text AS "directAmount",
  custody_amount::text AS "custodyAmount", total_amount::text AS "totalAmount",
  sum(direct_amount) OVER ()::text AS "directTotal",
  sum(custody_amount) OVER ()::text AS "custodyTotal",
  sum(total_amount) OVER ()::text AS "periodTotal"
FROM grouped ORDER BY grouped.${column} ${direction === "asc" ? "ASC" : "DESC"}, grouped.name ASC
`;
}

/** Compare date-only values from the validated request and the Aden DB clock. */
export function validMedicalPaymentRange(from: string, to: string, today: string, minDate: string) {
  return from >= minDate && from <= to && to <= today;
}
