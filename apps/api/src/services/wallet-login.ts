import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { User } from "../../../../packages/contracts/src/index.ts";
import { audit } from "./audit.ts";

/**
 * Credits the first admitted entry into ONE company per Asia/Aden calendar day.
 * Global sign-in alone cannot fan out points to every company membership.
 * Called in the same transaction as company activation; disabled by default.
 */
export async function awardCompanyDailyLogin(
  client: PoolClient,
  companyId: number,
  user: User,
): Promise<{ rewarded: boolean }> {
  const task = await client.query(
    `SELECT s.points::text AS points,s.revision
     FROM reward_task_settings s JOIN reward_task_definitions d ON d.code=s.code
     WHERE s.company_id=$1 AND s.code='DAILY_LOGIN' AND s.enabled
       AND d.implemented AND s.points>0 AND s.repeat_rule='daily'
     FOR SHARE OF s`,
    [companyId],
  );
  if (!task.rows[0]) return { rewarded: false };

  const employee = await client.query(
    `SELECT e.id,e.name FROM employees e JOIN users u ON u.id=e.user_id
     WHERE e.company_id=$1 AND e.user_id=$2 AND e.active AND NOT u.archived
     FOR SHARE OF e`,
    [companyId, user.id],
  );
  if (!employee.rows[0]) return { rewarded: false };
  const staff = employee.rows[0];

  const eligible = await client.query(
    `SELECT (
      NOT EXISTS(SELECT 1 FROM reward_task_roles WHERE company_id=$1 AND code='DAILY_LOGIN')
      OR EXISTS(
        SELECT 1 FROM reward_task_roles r
        JOIN company_roles cr ON cr.company_id=r.company_id AND cr.id=r.role_id AND cr.active
        JOIN employee_role_assignments a ON a.company_id=r.company_id
          AND a.role_id=r.role_id AND a.employee_id=$2 AND a.active
        WHERE r.company_id=$1 AND r.code='DAILY_LOGIN'
      )
    ) AS allowed`,
    [companyId, staff.id],
  );
  if (!eligible.rows[0].allowed) return { rewarded: false };

  // A single wallet row lock serializes simultaneous tabs and repeated
  // activation requests even when their sessions are different.
  await client.query(
    "SELECT 1 FROM employee_wallets WHERE company_id=$1 AND employee_id=$2 FOR UPDATE",
    [companyId, staff.id],
  );
  const earnedToday = await client.query(
    `SELECT 1 FROM employee_wallet_entries
     WHERE company_id=$1 AND employee_id=$2 AND kind='automatic' AND task_code='DAILY_LOGIN'
       AND (created_at AT TIME ZONE 'Asia/Aden')::date =
           (clock_timestamp() AT TIME ZONE 'Asia/Aden')::date
     LIMIT 1`,
    [companyId, staff.id],
  );
  if (earnedToday.rowCount) return { rewarded: false };

  const snapshot = {
    source: "company-workspace-entry",
    companyId,
    timeZone: "Asia/Aden",
    taskCode: "DAILY_LOGIN",
    taskRevision: task.rows[0].revision,
    pointsPerUnit: task.rows[0].points,
    units: 1,
    totalPoints: task.rows[0].points,
  };
  const inserted = await client.query(
    `INSERT INTO employee_wallet_entries(
       company_id,employee_id,employee_name,kind,points,reason,
       task_code,task_revision,logical_line_count,idempotency_key,
       request_payload,created_by,created_by_name)
     VALUES($1,$2,$3,'automatic',$4,$5,'DAILY_LOGIN',$6,1,$7,$8,$9,$10)
     RETURNING id`,
    [
      companyId, staff.id, staff.name, task.rows[0].points,
      "مكافأة الدخول اليومي إلى الشركة", task.rows[0].revision,
      randomUUID(), JSON.stringify(snapshot), user.id, user.displayName,
    ],
  );
  await audit(
    client, user, "wallet.auto-award", "wallet-entry", inserted.rows[0].id,
    null, snapshot, companyId,
  );
  return { rewarded: true };
}
