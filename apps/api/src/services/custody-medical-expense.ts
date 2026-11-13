import type { PoolClient } from "pg";
import type { AdministrativeCustodyTransferInput } from "../../../../packages/contracts/src/administrative-custody.ts";
import { HttpError } from "../errors.ts";

export async function custodyMedicalBeneficiary(client: PoolClient, companyId: number, input: AdministrativeCustodyTransferInput) {
  if (!input.expenseKind || input.expenseKind === "other") return null;
  const result = await client.query<{ id: number; name: string; mainName: string; kind: "doctor" | "nurse" }>(
    `SELECT id,name,COALESCE(NULLIF(btrim(shared_name),''),name) AS "mainName",kind
     FROM doctors WHERE company_id=$1 AND id=$2 AND active=true
     AND (kind='nurse' OR (kind='doctor' AND $3='medical')) FOR SHARE`,
    [companyId, input.doctorId, input.expenseKind],
  );
  if (!result.rows[0]) throw new HttpError(400, "custody_beneficiary_invalid", "اختر مستفيدًا نشطًا: طبيبًا أو ممرضًا للصرف، وممرضًا للقصاصات.");
  return result.rows[0];
}

// Runs in the SAME transaction as the journal. The cutoff excludes later sales,
// while the primary name includes child cards and all earlier dates.
export async function markCustodyMedicalSales(client: PoolClient, companyId: number, userId: number,
  beneficiary: { mainName: string; kind: string } | null, expenseKind: string) {
  if (expenseKind !== "medical" || !beneficiary) return { cutoffInvoiceId: null, newlyMarked: 0 };
  const latest = await client.query<{ id: number }>(
    `SELECT i.id FROM invoices i JOIN doctors d ON d.company_id=i.company_id AND d.id=i.doctor_id
     WHERE i.company_id=$1 AND i.kind='sale' AND i.posted=true AND d.kind=$2
     AND COALESCE(NULLIF(btrim(d.shared_name),''),d.name)=$3::text
     ORDER BY i.created_at DESC,i.id DESC LIMIT 1 FOR SHARE OF i`,
    [companyId, beneficiary.kind, beneficiary.mainName],
  );
  const cutoffInvoiceId = latest.rows[0]?.id ?? null;
  if (cutoffInvoiceId === null) return { cutoffInvoiceId, newlyMarked: 0 };
  const marked = await client.query(
    `INSERT INTO doctor_sales_accounted_invoices(company_id,invoice_id,main_name,cutoff_invoice_id,marked_by)
     SELECT i.company_id,i.id,$3::text,$2,$4 FROM invoices i
     JOIN doctors d ON d.company_id=i.company_id AND d.id=i.doctor_id
     JOIN invoices cutoff ON cutoff.company_id=i.company_id AND cutoff.id=$2
     WHERE i.company_id=$1 AND i.kind='sale' AND i.posted=true AND d.kind=$5
     AND COALESCE(NULLIF(btrim(d.shared_name),''),d.name)=$3::text
     AND (i.created_at,i.id)<=(cutoff.created_at,cutoff.id)
     ON CONFLICT(company_id,invoice_id) DO NOTHING RETURNING invoice_id`,
    [companyId, cutoffInvoiceId, beneficiary.mainName, userId, beneficiary.kind],
  );
  return { cutoffInvoiceId, newlyMarked: marked.rows.length };
}
