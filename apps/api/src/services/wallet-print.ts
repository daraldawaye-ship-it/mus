import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { User } from "../../../../packages/contracts/src/index.ts";
import { audit } from "./audit.ts";

/**
 * Logs a server-observed request to open printing for a posted cash voucher.
 * This does not claim that a printer produced a sheet.
 * Repeated requests by the same employee for the same voucher are idempotent.
 */
export async function rewardVoucherPrintRequest(
  client: PoolClient,
  companyId: number,
  documentId: number,
  user: User,
): Promise<{ rewarded: boolean; entryId: number | null }> {
  const doc = await client.query(
    `SELECT id,number,kind,status FROM financial_documents
     WHERE company_id=$1 AND id=$2 FOR SHARE`,
    [companyId, documentId],
  );
  const voucher = doc.rows[0];
  if (!voucher) return { rewarded: false, entryId: null };
  if (voucher.status !== "posted" || !["receipt", "payment"].includes(voucher.kind))
    return { rewarded: false, entryId: null };
  const code = voucher.kind === "receipt" ? "RECEIPT_PRINT" : "PAYMENT_PRINT";
  const task = await client.query(
    `SELECT s.code,s.points::text AS points,s.revision
     FROM reward_task_settings s JOIN reward_task_definitions d ON d.code=s.code
     WHERE s.company_id=$1 AND s.code=$2 AND s.enabled AND d.implemented
       AND s.repeat_rule='per-document' AND s.points>0
     FOR SHARE OF s`,
    [companyId, code],
  );
  if (!task.rows[0]) return { rewarded: false, entryId: null };
  const employee = await client.query(
    `SELECT e.id,e.name FROM employees e JOIN users u ON u.id=e.user_id
     WHERE e.company_id=$1 AND e.user_id=$2 AND e.active AND NOT u.archived
     FOR SHARE OF e`,
    [companyId, user.id],
  );
  if (!employee.rows[0]) return { rewarded: false, entryId: null };
  const staff = employee.rows[0];
  const eligible = await client.query(
    `SELECT (
       NOT EXISTS (SELECT 1 FROM reward_task_roles r WHERE r.company_id=$1 AND r.code=$2)
       OR EXISTS(
         SELECT 1 FROM reward_task_roles r
         JOIN company_roles cr ON cr.company_id=r.company_id AND cr.id=r.role_id AND cr.active
         JOIN employee_role_assignments a ON a.company_id=r.company_id
           AND a.role_id=r.role_id AND a.employee_id=$3 AND a.active
         WHERE r.company_id=$1 AND r.code=$2
       )
     ) AS allowed`,
    [companyId, code, staff.id],
  );
  if (!eligible.rows[0].allowed) return { rewarded: false, entryId: null };

  // Serialize this employee's requests and preserve one credit per voucher.
  await client.query(
    "SELECT 1 FROM employee_wallets WHERE company_id=$1 AND employee_id=$2 FOR UPDATE",
    [companyId, staff.id],
  );
  const previous = await client.query(
    `SELECT id FROM employee_wallet_entries
     WHERE company_id=$1 AND employee_id=$2 AND task_code=$3
       AND financial_document_id=$4 AND kind='automatic'`,
    [companyId, staff.id, code, documentId],
  );
  if (previous.rows[0]) return { rewarded: false, entryId: previous.rows[0].id };
  const reason =
    `مكافأة طلب طباعة سند ${voucher.kind === "receipt" ? "قبض" : "صرف"} رقم ${voucher.number}`;
  const snapshot = {
    source: "voucher-print-request",
    documentId,
    documentNumber: voucher.number,
    taskCode: code,
    taskRevision: task.rows[0].revision,
    pointsPerUnit: task.rows[0].points,
    units: 1,
    totalPoints: task.rows[0].points,
    actualPrintingConfirmed: false,
  };
  const inserted = await client.query(
    `INSERT INTO employee_wallet_entries(
       company_id,employee_id,employee_name,kind,points,reason,
       financial_document_id,task_code,task_revision,logical_line_count,
       idempotency_key,request_payload,created_by,created_by_name)
     VALUES($1,$2,$3,'automatic',$4,$5,$6,$7,$8,1,$9,$10,$11,$12)
     RETURNING id`,
    [
      companyId, staff.id, staff.name, task.rows[0].points, reason,
      documentId, code, task.rows[0].revision,
      randomUUID(), JSON.stringify(snapshot), user.id, user.displayName,
    ],
  );
  await audit(
    client, user, "wallet.auto-award", "wallet-entry", inserted.rows[0].id,
    null, snapshot, companyId,
  );
  return { rewarded: true, entryId: inserted.rows[0].id };
}
