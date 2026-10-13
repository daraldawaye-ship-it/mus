import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { User } from "../../../../packages/contracts/src/index.ts";
import { audit } from "./audit.ts";

/**
 * Called exclusively inside the same transaction that posts a NEW invoice.
 * An idempotent invoice replay returns before this function is reached.
 * Settings, recipient roles, event snapshots and wallet ledger are server-side.
 */
export async function awardPostedInvoice(
  client: PoolClient,
  companyId: number,
  invoiceId: number,
  user: User,
): Promise<void> {
  const invoice = await client.query(
    `SELECT id,number,kind,posted,created_by FROM invoices
     WHERE company_id=$1 AND id=$2 AND posted`,
    [companyId, invoiceId],
  );
  const document = invoice.rows[0];
  if (!document || document.created_by !== user.id)
    throw new Error("Invoice reward requires a newly posted invoice by its creator");

  const codes =
    document.kind === "sale"
      ? ["SALE_SAVED", "SALE_LINES"]
      : ["PURCHASE_SAVED", "PURCHASE_LINES"];
  const settings = await client.query(
    `SELECT s.code,s.points::text AS points,s.repeat_rule,s.revision
     FROM reward_task_settings s JOIN reward_task_definitions d ON d.code=s.code
     WHERE s.company_id=$1 AND s.code=ANY($2::varchar[])
       AND s.enabled AND d.implemented AND s.points>0
     ORDER BY s.code FOR SHARE OF s`,
    [companyId, codes],
  );
  if (!settings.rowCount) return;

  const employee = await client.query(
    `SELECT e.id,e.name FROM employees e
     JOIN users u ON u.id=e.user_id AND NOT u.archived
     WHERE e.company_id=$1 AND e.user_id=$2 AND e.active
     ORDER BY e.id LIMIT 1 FOR SHARE OF e`,
    [companyId, user.id],
  );
  if (!employee.rows[0]) return;
  const { id: employeeId, name: employeeName } = employee.rows[0];

  // Locking the wallet serializes the date/rolling-window checks even when
  // concurrent invoices from the same employee are posted in parallel.
  const wallet = await client.query(
    `SELECT 1 FROM employee_wallets WHERE company_id=$1 AND employee_id=$2 FOR UPDATE`,
    [companyId, employeeId],
  );
  if (!wallet.rowCount) throw new Error("Active employee has no wallet");

  // Each logical line is a unique item + selling unit + unit price + expiry batch.
  // Splitting a quantity between identical physical rows does not mint points.
  const lines = await client.query(
    `SELECT count(*)::integer AS units FROM
      (SELECT DISTINCT item_id,unit,unit_price,expiry_date
       FROM invoice_lines WHERE company_id=$1 AND invoice_id=$2) AS logical_lines`,
    [companyId, invoiceId],
  );
  const logicalLines = Number(lines.rows[0].units);
  for (const task of settings.rows) {
    const role = await client.query(
      `SELECT
         (SELECT count(*)::integer FROM reward_task_roles r
          WHERE r.company_id=$1 AND r.code=$2) AS assigned,
         EXISTS(
           SELECT 1 FROM reward_task_roles r
           JOIN company_roles cr ON cr.company_id=r.company_id AND cr.id=r.role_id AND cr.active
           JOIN employee_role_assignments era ON era.company_id=r.company_id
             AND era.role_id=r.role_id AND era.employee_id=$3 AND era.active
           WHERE r.company_id=$1 AND r.code=$2
         ) AS eligible`,
      [companyId, task.code, employeeId],
    );
    if (role.rows[0].assigned > 0 && !role.rows[0].eligible) continue;

    // Every document is a single event even under "unlimited" repeats.
    // Daily boundaries use the company's operational timezone (Asia/Aden).
    if (task.repeat_rule === "daily" || task.repeat_rule === "rolling-seven-days") {
      const repeated = await client.query(
        `SELECT 1 FROM employee_wallet_entries
         WHERE company_id=$1 AND employee_id=$2 AND task_code=$3 AND kind='automatic'
         AND CASE WHEN $4='daily'
              THEN (created_at AT TIME ZONE 'Asia/Aden')::date =
                   (clock_timestamp() AT TIME ZONE 'Asia/Aden')::date
              ELSE created_at > clock_timestamp()-interval '7 days' END
         LIMIT 1`,
        [companyId, employeeId, task.code, task.repeat_rule],
      );
      if (repeated.rowCount) continue;
    }
    const units = task.code.endsWith("_LINES") ? logicalLines : 1;
    const points = BigInt(task.points) * BigInt(units);
    if (points <= 0n) continue;
    const reason = task.code.endsWith("_LINES")
      ? `مكافأة ${units} سطر منطقي في فاتورة ${document.kind === "sale" ? "مبيعات" : "مشتريات"} رقم ${document.number}`
      : `مكافأة حفظ فاتورة ${document.kind === "sale" ? "مبيعات" : "مشتريات"} رقم ${document.number}`;
    const snapshot = {
      kind: "automatic",
      taskCode: task.code,
      taskRevision: task.revision,
      repeatRule: task.repeat_rule,
      invoiceId,
      invoiceNumber: document.number,
      rewardedUnits: units,
      points: points.toString(),
    };
    const saved = await client.query(
      `INSERT INTO employee_wallet_entries(
         company_id,employee_id,employee_name,kind,points,reason,idempotency_key,
         request_payload,created_by,created_by_name,task_code,invoice_id,rewarded_units)
       VALUES($1,$2,$3,'automatic',$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING id`,
      [
        companyId, employeeId, employeeName, points.toString(), reason,
        randomUUID(), JSON.stringify(snapshot), user.id, user.displayName,
        task.code, invoiceId, units,
      ],
    );
    await audit(
      client, user, "wallet.automatic", "wallet-entry", saved.rows[0].id,
      null, snapshot, companyId,
    );
  }
}
