// Only the original, posted medical disbursements count. Never sum their
// journal lines or include slip payouts or movements merely funding custody.
export const medicalPaymentSortKeys = ["name", "count", "total"] as const;
export type MedicalPaymentSortKey = typeof medicalPaymentSortKeys[number];

const medicalPaymentEventsSql = `
WITH custody AS (
  SELECT t.doctor_id, t.doctor_main_name, t.doctor_name, t.doctor_kind,
    t.amount, fd.document_date, t.created_by, t.created_at
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
    p.amount, fd.document_date, p.created_by, p.created_at
  FROM direct_medical_payments p
  JOIN financial_documents fd
    ON fd.company_id=p.company_id AND fd.id=p.financial_document_id
  WHERE p.company_id=$1 AND p.expense_kind='medical' AND p.amount>0
    AND fd.status='posted' AND fd.document_date BETWEEN $2::date AND $3::date
), named AS (
  SELECT COALESCE(NULLIF(btrim(d.shared_name),''),
           NULLIF(btrim(d.name),''), NULLIF(btrim(e.doctor_main_name),''),
           NULLIF(btrim(e.doctor_name),'')) AS name,
    COALESCE(d.kind,e.doctor_kind) AS kind, e.amount, e.document_date, e.created_by, e.created_at
  FROM events e
  LEFT JOIN doctors d ON d.company_id=$1 AND d.id=e.doctor_id
), eligible AS (
  SELECT regexp_replace(name,'[[:space:]]+',' ','g') AS name,
    amount, document_date, created_by, created_at
  FROM named WHERE name IS NOT NULL AND kind IN ('doctor','nurse')
)`;

export function medicalPaymentSummarySql(sort: MedicalPaymentSortKey, direction: "asc"|"desc") {
  const column = { name: "name", count: "movement_count", total: "total_amount" }[sort];
  return `${medicalPaymentEventsSql}, grouped AS (
  SELECT min(name) AS name, count(*)::integer AS movement_count, sum(amount) AS total_amount
  FROM eligible
  WHERE translate(name,'ة','ه') ILIKE translate($4::text,'ة','ه') ESCAPE '\\'
  GROUP BY lower(name)
)
SELECT grouped.name, movement_count AS "movementCount", total_amount::text AS "totalAmount",
  CASE WHEN $5::boolean THEN sum(total_amount) OVER ()::text END AS "periodTotal"
FROM grouped ORDER BY grouped.${column} ${direction === "asc" ? "ASC" : "DESC"}, grouped.name ASC
`;
}

export const medicalPaymentDetailSql = `${medicalPaymentEventsSql}
SELECT e.document_date::text AS "date", e.amount::text AS "amount",
  to_char(e.created_at AT TIME ZONE 'Asia/Aden', 'HH24:MI') AS "time",
  COALESCE(u.display_name,'') AS "actor"
FROM eligible e LEFT JOIN users u ON u.id=e.created_by
WHERE lower(e.name)=lower($4::text)
ORDER BY e.document_date DESC, e.created_at DESC, e.amount DESC, e.created_by
`;

/** Compare date-only values from the validated request and the Aden DB clock. */
export function validMedicalPaymentRange(from: string, to: string, today: string, minDate: string) {
  return from >= minDate && from <= to && to <= today;
}
