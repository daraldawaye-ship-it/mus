import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { User } from "../../../../packages/contracts/src/index.ts";
import { audit } from "./audit.ts";

/**
 * Award enabled invoice tasks inside the SAME database transaction as posting.
 * No reward for an owner/general user without an active employee record.
 * Exactly one ledger entry per employee, invoice and task, protected by a unique index.
 */
export async function awardPostedInvoice(
  client: PoolClient,
  companyId: number,
  invoiceId: number,
  kind: "sale" | "purchase",
  user: User,
  number: string,
): Promise<void> {
  const employee = (
    await client.query(
      `SELECT e.id,e.name FROM employees e JOIN users u ON u.id=e.user_id
       WHERE e.company_id=$1 AND e.user_id=$2 AND e.active AND NOT u.archived
       FOR SHARE OF e`,
      [companyId, user.id],
    )
  ).rows[0] as { id: number; name: string } | undefined;
  if (!employee) return;

  const codes =
    kind === "sale"
      ? (["SALE_SAVED", "SALE_LINES"] as const)
      : (["PURCHASE_SAVED", "PURCHASE_LINES"] as const);
  // The caller holds the company row's update lock throughout this transaction,
  // serializing changes to the task settings with posting for this company.
  const tasks = await client.query(
    `SELECT s.code,s.points::text,s.revision
     FROM reward_task_settings s JOIN reward_task_definitions d ON d.code=s.code
     WHERE s.company_id=$1 AND s.code=ANY($2::varchar(100)[])
       AND s.enabled AND d.implemented AND s.repeat_rule='per-document'
       AND (
         NOT EXISTS(SELECT 1 FROM reward_task_roles r WHERE r.company_id=s.company_id AND r.code=s.code)
         OR EXISTS(
           SELECT 1 FROM reward_task_roles r
           JOIN employee_role_assignments a ON a.company_id=r.company_id AND a.role_id=r.role_id
           JOIN company_roles cr ON cr.company_id=r.company_id AND cr.id=r.role_id
           WHERE r.company_id=s.company_id AND r.code=s.code AND a.employee_id=$3 AND a.active AND cr.active
         )
       )
     ORDER BY s.code FOR SHARE OF s`,
    [companyId, [...codes], employee.id],
  );
  if (!tasks.rowCount) return;

  // Logical lines: splitting one item/price/unit/expiry batch into several
  // UI rows does not multiply the reward. Returns are counted positively.
  const logicalLines = Number(
    (
      await client.query(
        `SELECT count(DISTINCT (item_id,unit,unit_price,expiry_date))::integer AS count
         FROM invoice_lines WHERE company_id=$1 AND invoice_id=$2`,
        [companyId, invoiceId],
      )
    ).rows[0].count,
  );

  for (const task of tasks.rows as {
    code: string;
    points: string;
    revision: number;
  }[]) {
    const units = task.code.endsWith("_LINES") ? logicalLines : 1;
    const value = BigInt(task.points) * BigInt(units);
    if (value === 0n) continue; // An unset/zero-value task yields no empty entry.
    const reason = `مكافأة ${task.code.endsWith("_LINES") ? "سطور" : "حفظ"} فاتورة ${kind === "sale" ? "مبيعات" : "مشتريات"} رقم ${number}`;
    const snapshot = {
      source: "posted-invoice",
      invoiceId,
      taskCode: task.code,
      taskRevision: task.revision,
      pointsPerUnit: task.points,
      units,
      totalPoints: value.toString(),
    };
    const inserted = await client.query(
      `INSERT INTO employee_wallet_entries(
         company_id,employee_id,employee_name,kind,points,reason,
         invoice_id,task_code,task_revision,logical_line_count,
         idempotency_key,request_payload,created_by,created_by_name)
       VALUES($1,$2,$3,'automatic',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING id`,
      [
        companyId,
        employee.id,
        employee.name,
        value.toString(),
        reason,
        invoiceId,
        task.code,
        task.revision,
        units,
        randomUUID(),
        JSON.stringify(snapshot),
        user.id,
        user.displayName,
      ],
    );
    await audit(
      client,
      user,
      "wallet.auto-award",
      "wallet-entry",
      inserted.rows[0].id,
      null,
      snapshot,
      companyId,
    );
  }
}
