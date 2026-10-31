import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { User } from "../../../../packages/contracts/src/index.ts";
import { audit } from "./audit.ts";

/** Credit one eligible employee for a successful due-count adjustment.
 * The caller has already validated that this item was due, the request came
 * from the required-count page, and the count operation was newly created.
 * The operation, task event, award and audit all share one transaction.
 */
export async function awardRequiredStockCount(
  client: PoolClient,
  companyId: number,
  operationId: number,
  itemId: number,
  user: User,
): Promise<void> {
  const employee = (await client.query(
    `SELECT e.id,e.name FROM employees e JOIN users u ON u.id=e.user_id
     WHERE e.company_id=$1 AND e.user_id=$2 AND e.active AND NOT u.archived
     FOR SHARE OF e`,
    [companyId, user.id],
  )).rows[0] as { id: number; name: string } | undefined;
  if (!employee) return;

  const task = (await client.query(
    `SELECT s.points::text AS points,s.revision
     FROM reward_task_settings s JOIN reward_task_definitions d ON d.code=s.code
     WHERE s.company_id=$1 AND s.code='STOCK_COUNT_REQUIRED'
       AND s.enabled AND d.implemented AND s.repeat_rule='per-document'
       AND (
         NOT EXISTS(SELECT 1 FROM reward_task_roles r WHERE r.company_id=s.company_id AND r.code=s.code)
         OR EXISTS (
           SELECT 1 FROM reward_task_roles r
           JOIN employee_role_assignments a ON a.company_id=r.company_id AND a.role_id=r.role_id
           JOIN company_roles cr ON cr.company_id=r.company_id AND cr.id=r.role_id
           WHERE r.company_id=s.company_id AND r.code=s.code
             AND a.employee_id=$2 AND a.active AND cr.active
         )
       )
     FOR SHARE OF s`,
    [companyId, employee.id],
  )).rows[0] as { points: string; revision: number } | undefined;
  if (!task || BigInt(task.points) <= 0n) return;

  const snapshot = {
    source: "required-stock-count",
    operationId,
    itemId,
    taskCode: "STOCK_COUNT_REQUIRED",
    taskRevision: task.revision,
    pointsPerUnit: task.points,
    units: 1,
    totalPoints: task.points,
  };
  const inserted = await client.query(
    `INSERT INTO employee_wallet_entries(
       company_id,employee_id,employee_name,kind,points,reason,
       stock_operation_id,task_code,task_revision,logical_line_count,
       idempotency_key,request_payload,created_by,created_by_name)
     VALUES($1,$2,$3,'automatic',$4,$5,$6,'STOCK_COUNT_REQUIRED',$7,1,$8,$9,$10,$11)
     ON CONFLICT DO NOTHING RETURNING id`,
    [
      companyId, employee.id, employee.name, task.points,
      `مكافأة تسوية صنف مطلوب جرده — الصنف ${itemId}، التسوية ${operationId}`,
      operationId, task.revision, randomUUID(), JSON.stringify(snapshot),
      user.id, user.displayName,
    ],
  );
  if (!inserted.rows[0]) return;
  await audit(client, user, "wallet.auto-award", "wallet-entry",
    inserted.rows[0].id, null, snapshot, companyId);
}
