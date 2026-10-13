import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { User } from "../../../../packages/contracts/src/index.ts";
import { audit } from "./audit.ts";

/**
 * Only the explicit /companies/:id/activate endpoint awards the configured
 * company-entry task. An ordinary login to the public platform does not.
 * One entry per eligible employee/company/Aden calendar day.
 */
export async function rewardCompanyEntry(
  client: PoolClient,
  companyId: number,
  user: User,
): Promise<boolean> {
  const task = await client.query(
    `SELECT s.points::text AS points,s.revision FROM reward_task_settings s
     JOIN reward_task_definitions d ON d.code=s.code
     WHERE s.company_id=$1 AND s.code='DAILY_LOGIN' AND s.enabled AND d.implemented
       AND s.repeat_rule='daily' AND s.points>0 FOR SHARE OF s`,
    [companyId],
  );
  if (!task.rows[0]) return false;
  const staff = await client.query(
    `SELECT e.id,e.name FROM employees e JOIN users u ON u.id=e.user_id
     WHERE e.company_id=$1 AND e.user_id=$2 AND e.active AND NOT u.archived
     FOR SHARE OF e`,
    [companyId, user.id],
  );
  if (!staff.rows[0]) return false;
  const employee = staff.rows[0];
  const eligible = await client.query(
    `SELECT (
       NOT EXISTS(SELECT 1 FROM reward_task_roles r WHERE r.company_id=$1 AND r.code='DAILY_LOGIN')
       OR EXISTS(
         SELECT 1 FROM reward_task_roles r
         JOIN company_roles cr ON cr.company_id=r.company_id AND cr.id=r.role_id AND cr.active
         JOIN employee_role_assignments a ON a.company_id=r.company_id
           AND a.role_id=r.role_id AND a.employee_id=$2 AND a.active
         WHERE r.company_id=$1 AND r.code='DAILY_LOGIN'
       )
     ) AS allowed`,
    [companyId, employee.id],
  );
  if (!eligible.rows[0].allowed) return false;
  await client.query(
    "SELECT 1 FROM employee_wallets WHERE company_id=$1 AND employee_id=$2 FOR UPDATE",
    [companyId, employee.id],
  );
  const now = await client.query(
    "SELECT (clock_timestamp() AT TIME ZONE 'Asia/Aden')::date::text AS day",
  );
  const day = now.rows[0].day as string;
  const exists = await client.query(
    `SELECT 1 FROM employee_wallet_entries WHERE company_id=$1 AND employee_id=$2
     AND kind='automatic' AND task_code='DAILY_LOGIN' AND reward_day=$3::date LIMIT 1`,
    [companyId, employee.id, day],
  );
  if (exists.rowCount) return false;
  const snapshot = {
    source: "company-entry", companyId, employeeId: employee.id,
    rewardDay: day, taskCode: "DAILY_LOGIN",
    taskRevision: task.rows[0].revision,
    pointsPerUnit: task.rows[0].points,
    units: 1, totalPoints: task.rows[0].points,
  };
  const inserted = await client.query(
    `INSERT INTO employee_wallet_entries(
       company_id,employee_id,employee_name,kind,points,reason,
       reward_day,task_code,task_revision,logical_line_count,idempotency_key,
       request_payload,created_by,created_by_name)
     VALUES($1,$2,$3,'automatic',$4,$5,$6,'DAILY_LOGIN',$7,1,$8,$9,$10,$11)
     RETURNING id`,
    [
      companyId, employee.id, employee.name, task.rows[0].points,
      `مكافأة دخول الشركة يوم ${day}`, day, task.rows[0].revision,
      randomUUID(), JSON.stringify(snapshot), user.id, user.displayName,
    ],
  );
  await audit(
    client, user, "wallet.auto-award", "wallet-entry", inserted.rows[0].id,
    null, snapshot, companyId,
  );
  return true;
}
