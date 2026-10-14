import type { Database } from "../db.ts";
import type { QueryResultRow } from "pg";
import type {
  WalletEntry,
  WalletSummary,
  RewardTask,
} from "../../../../packages/contracts/src/wallet.ts";
import { HttpError } from "../errors.ts";

export const walletSummaryQuery = `SELECT w.employee_id,e.name AS employee_name,(w.points-COALESCE(reserved.points,0))::text AS points,w.points::text AS total_points,COALESCE(reserved.points,0)::text AS reserved_points,w.money::text,c.code AS currency_code
 FROM employee_wallets w JOIN employees e ON e.company_id=w.company_id AND e.id=w.employee_id
 LEFT JOIN LATERAL (SELECT sum(points) AS points FROM wallet_conversions WHERE company_id=w.company_id AND employee_id=w.employee_id AND status='pending') reserved ON true
 LEFT JOIN finance_settings f ON f.company_id=w.company_id
 LEFT JOIN company_currencies c ON c.company_id=f.company_id AND c.id=f.base_currency_id`;
export const walletEntryQuery = `SELECT l.*,l.points::text,l.money::text,r.id AS reversed_by_entry_id,attendance_source.attendance_record_id
 FROM employee_wallet_entries l LEFT JOIN employee_wallet_entries r ON r.company_id=l.company_id AND r.reference_id=l.id AND r.kind='reversal'
 LEFT JOIN attendance_point_entries attendance_source ON attendance_source.company_id=l.company_id AND attendance_source.id=l.attendance_entry_id`;
export const rewardTaskQuery = `SELECT d.*,COALESCE(s.points,d.default_points)::text AS points,
 COALESCE(s.repeat_rule,d.default_repeat_rule) AS repeat_rule,COALESCE(s.enabled,false) AS enabled,s.page_key,s.daily_limit,s.revision,
 COALESCE((SELECT array_agg(r.role_id ORDER BY r.role_id) FROM reward_task_roles r WHERE r.company_id=s.company_id AND r.code=s.code),'{}'::integer[]) AS role_ids
 FROM reward_task_definitions d LEFT JOIN reward_task_settings s ON s.code=d.code AND s.company_id=$1`;

export const walletSummaryDTO = (row: QueryResultRow): WalletSummary => ({
  employeeId: row.employee_id,
  employeeName: row.employee_name,
  points: row.points,
  totalPoints: row.total_points,
  reservedPoints: row.reserved_points,
  money: row.money === "0.000000" ? "0" : row.money,
  currencyCode: row.currency_code ?? "",
});
export const walletEntryDTO = (row: QueryResultRow): WalletEntry => ({
  id: row.id,
  employeeId: row.employee_id,
  employeeName: row.employee_name,
  kind: row.kind,
  attendanceEntryId: row.attendance_entry_id ?? null,
  attendanceRecordId: row.attendance_record_id ?? null,
  points: row.points,
  money: row.money === "0.000000" ? "0" : row.money,
  reason: row.reason,
  referenceId: row.reference_id,
  invoiceId: row.invoice_id ?? null,
  conversionId: row.conversion_id ?? null,
  financialDocumentId: row.financial_document_id ?? null,
  pageKey: row.page_key ?? null,
  taskCode: row.task_code ?? null,
  taskRevision: row.task_revision ?? null,
  logicalLineCount: row.logical_line_count ?? null,
  reversedByEntryId: row.reversed_by_entry_id ?? null,
  createdAt: row.created_at.toISOString(),
  createdByName: row.created_by_name,
});
export const rewardTaskDTO = (row: QueryResultRow): RewardTask => ({
  code: row.code,
  name: row.name,
  description: row.description,
  implemented: row.implemented,
  points: row.points,
  repeatRule: row.repeat_rule,
  enabled: row.enabled,
  roleIds: row.role_ids,
  pageKey: row.page_key ?? null,
  dailyLimit: row.daily_limit ?? null,
  revision: row.revision ?? null,
});

export async function walletSummary(
  db: Database,
  companyId: number,
  employeeId: number,
): Promise<WalletSummary | null> {
  const found = await db.query(
    walletSummaryQuery + " WHERE w.company_id=$1 AND w.employee_id=$2",
    [companyId, employeeId],
  );
  return found.rows[0] ? walletSummaryDTO(found.rows[0]) : null;
}
export async function rewardTask(
  db: Database,
  companyId: number,
  code: string,
): Promise<RewardTask | null> {
  const found = await db.query(rewardTaskQuery + " WHERE d.code=$2", [
    companyId,
    code,
  ]);
  return found.rows[0] ? rewardTaskDTO(found.rows[0]) : null;
}
export async function replayWalletEntry(
  db: Database,
  companyId: number,
  userId: number,
  idempotencyKey: string,
  payload: object,
): Promise<WalletEntry | null> {
  const found = await db.query(
    walletEntryQuery + ` WHERE l.company_id=$1 AND l.idempotency_key=$2`,
    [companyId, idempotencyKey],
  );
  if (!found.rows[0]) return null;
  const matches = await db.query(
    `SELECT 1 FROM employee_wallet_entries WHERE company_id=$1 AND idempotency_key=$2 AND created_by=$3 AND request_payload=$4::jsonb`,
    [companyId, idempotencyKey, userId, JSON.stringify(payload)],
  );
  if (!matches.rowCount)
    throw new HttpError(
      409,
      "idempotency_conflict",
      "استُخدم مفتاح العملية سابقًا ببيانات أخرى؛ لا يمكن تكراره بتغيير البيانات",
    );
  return walletEntryDTO(found.rows[0]);
}
