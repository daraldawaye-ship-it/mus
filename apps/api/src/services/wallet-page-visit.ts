import type { PoolClient } from "pg";
import type { User } from "../../../../packages/contracts/src/index.ts";
import { audit } from "./audit.ts";
import { directoryEntries } from "./pages.ts";
import { HttpError } from "../errors.ts";

/**
 * A route transition in the company workspace (not background data fetching).
 * Rewards are always opt-in: configured page, active recipient, eligible role,
 * and the task's current repetition rule. Repeat checks are serialized by wallet.
 */
export async function awardCompanyPageVisit(
  client: PoolClient,
  companyId: number,
  user: User,
  pageKey: string,
  eventKey: string,
): Promise<{ rewarded: boolean }> {
  const previous = await client.query(
    `SELECT id,created_by,task_code,page_key FROM employee_wallet_entries
     WHERE company_id=$1 AND idempotency_key=$2`,
    [companyId, eventKey],
  );
  if (previous.rows[0]) {
    const accepted = previous.rows[0];
    if (accepted.created_by !== user.id || accepted.task_code !== "PAGE_VISIT" || accepted.page_key !== pageKey)
      throw new HttpError(
        409, "idempotency_conflict",
        "استُخدم مفتاح العملية سابقًا ببيانات أخرى؛ لا يمكن تكراره بتغيير المستخدم أو الصفحة",
      );
    return { rewarded: false };
  }
  const task = await client.query(
    `SELECT s.points::text AS points,s.repeat_rule,s.revision,s.page_key,s.daily_limit
     FROM reward_task_settings s JOIN reward_task_definitions d ON d.code=s.code
     WHERE s.company_id=$1 AND s.code='PAGE_VISIT' AND s.page_key=$2
       AND s.enabled AND d.implemented AND s.points>0
       AND s.repeat_rule IN ('daily','rolling-seven-days','unlimited')
     FOR SHARE OF s`,
    [companyId, pageKey],
  );
  if (!task.rows[0]) return { rewarded: false };
  const page = (await directoryEntries(client, user, companyId))
    .find((entry) => entry.key === pageKey);
  if (!page?.enabled || !page.actionAccess.view) return { rewarded: false };
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
       NOT EXISTS(SELECT 1 FROM reward_task_roles r WHERE r.company_id=$1 AND r.code='PAGE_VISIT')
       OR EXISTS(
         SELECT 1 FROM reward_task_roles r
         JOIN company_roles cr ON cr.company_id=r.company_id AND cr.id=r.role_id AND cr.active
         JOIN employee_role_assignments a ON a.company_id=r.company_id
           AND a.role_id=r.role_id AND a.employee_id=$2 AND a.active
         WHERE r.company_id=$1 AND r.code='PAGE_VISIT'
       )
     ) AS allowed`,
    [companyId, staff.id],
  );
  if (!eligible.rows[0].allowed) return { rewarded: false };
  // Lock one wallet to serialize requests and prevent concurrent daily/window
  // limits from being bypassed by distinct client navigation event keys.
  await client.query(
    "SELECT 1 FROM employee_wallets WHERE company_id=$1 AND employee_id=$2 FOR UPDATE",
    [companyId, staff.id],
  );
  const { repeat_rule: repeat, daily_limit: configuredLimit } = task.rows[0];
  const stats = await client.query(
    `SELECT
       count(*) FILTER (WHERE
         (created_at AT TIME ZONE 'Asia/Aden')::date =
         (clock_timestamp() AT TIME ZONE 'Asia/Aden')::date)::integer AS today,
       count(*) FILTER (WHERE created_at > clock_timestamp()-interval '7 days')::integer AS week,
       max(created_at) AS last_visit
     FROM employee_wallet_entries
     WHERE company_id=$1 AND employee_id=$2 AND task_code='PAGE_VISIT'
       AND kind='automatic'`,
    [companyId, staff.id],
  );
  const counts = stats.rows[0];
  if (repeat === "daily" && counts.today > 0) return { rewarded: false };
  if (repeat === "rolling-seven-days" && counts.week > 0) return { rewarded: false };
  // "unlimited" means distinct navigation events, not infinite credit from
  // refresh loops. A configurable daily cap (default 100) and a brief cooldown
  // guard against repeated synthetic requests.
  if (repeat === "unlimited") {
    const limit = configuredLimit ?? 100;
    if (counts.today >= limit) return { rewarded: false };
    if (counts.last_visit && Date.now() - new Date(counts.last_visit).getTime() < 15000)
      return { rewarded: false };
  }
  const snapshot = {
    source: "company-page-visit",
    pageKey,
    pageName: page.name,
    taskCode: "PAGE_VISIT",
    taskRevision: task.rows[0].revision,
    repeatRule: repeat,
    pointsPerUnit: task.rows[0].points,
    units: 1,
    totalPoints: task.rows[0].points,
    eventKey,
  };
  const inserted = await client.query(
    `INSERT INTO employee_wallet_entries(
       company_id,employee_id,employee_name,kind,points,reason,
       page_key,task_code,task_revision,logical_line_count,idempotency_key,
       request_payload,created_by,created_by_name)
     VALUES($1,$2,$3,'automatic',$4,$5,$6,'PAGE_VISIT',$7,1,$8,$9,$10,$11)
     RETURNING id`,
    [
      companyId, staff.id, staff.name, task.rows[0].points,
      `مكافأة زيارة صفحة ${page.name}`, pageKey, task.rows[0].revision,
      eventKey, JSON.stringify(snapshot), user.id, user.displayName,
    ],
  );
  await audit(
    client, user, "wallet.auto-award", "wallet-entry", inserted.rows[0].id,
    null, snapshot, companyId,
  );
  return { rewarded: true };
}
