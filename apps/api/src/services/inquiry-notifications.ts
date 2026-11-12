import type { PoolClient } from "pg";
import { effectiveTemplate, emitNotification } from "./notifications.ts";

const templateCode = (companyId: number | null) =>
  companyId === null ? "INQUIRY_UNANSWERED_PUBLIC" : "INQUIRY_UNANSWERED_COMPANY";
const scopeKey = (companyId: number | null) => companyId ?? 0;

/**
 * Reconcile the recipient's actual unanswered queue. The signature changes
 * only when the outstanding inquiry IDs change, not on each worker tick.
 * A generation keeps a repeated prior set distinct from an older alert.
 */
export async function syncUnansweredInquiryNotifications(
  client: PoolClient,
  companyId: number | null,
  userIds: number[],
): Promise<void> {
  const template = await effectiveTemplate(client, companyId, templateCode(companyId));
  for (const userId of [...new Set(userIds)].sort((a, b) => a - b)) {
    const pending = await client.query<{ id: number }>(
      `SELECT q.id FROM inquiry_requests q
       JOIN inquiry_targets t ON t.inquiry_id=q.id
       WHERE q.company_id IS NOT DISTINCT FROM $1 AND q.status='open'
         AND t.user_id=$2 AND t.status='pending'
       ORDER BY q.id`,
      [companyId, userId],
    );
    const ids = pending.rows.map((row) => row.id);
    const signature = ids.join(",");
    const stateKey = scopeKey(companyId);
    await client.query(
      `INSERT INTO inquiry_notification_state(scope_key,user_id)
       VALUES($1,$2) ON CONFLICT DO NOTHING`,
      [stateKey, userId],
    );
    const state = (await client.query<{ signature: string; generation: string }>(
      `SELECT signature,generation FROM inquiry_notification_state
       WHERE scope_key=$1 AND user_id=$2 FOR UPDATE`,
      [stateKey, userId],
    )).rows[0]!;
    const code = templateCode(companyId);
    if (!ids.length) {
      await client.query(
        `UPDATE notifications SET completed_at=clock_timestamp(),
         read_at=COALESCE(read_at,clock_timestamp()),snoozed_until=NULL,
         next_reminder_at=NULL,revision=revision+1,updated_at=clock_timestamp()
         WHERE COALESCE(company_id,0)=$1 AND recipient_user_id=$2
           AND code=$3 AND completed_at IS NULL`,
        [stateKey, userId, code],
      );
    }
    // Do not consume a change while the template is disabled. Re-enabling it
    // can then report the outstanding queue without waiting for another change.
    const nextSignature = template?.enabled ? signature : "";
    if (state.signature === nextSignature) continue;
    const generation = BigInt(state.generation) + 1n;
    await client.query(
      `UPDATE inquiry_notification_state SET signature=$3,generation=$4
       WHERE scope_key=$1 AND user_id=$2`,
      [stateKey, userId, nextSignature, generation.toString()],
    );
    if (!ids.length || !template?.enabled) continue;
    // A company target may be an employee or the platform owner. Both must
    // remain eligible for this company; a public target is a direct user.
    const eligible = (await client.query<{ id: number; employee_id: number | null }>(
      `SELECT u.id,
         (SELECT MIN(e.id) FROM employees e WHERE e.user_id=u.id
           AND e.company_id=$2 AND e.active) AS employee_id
       FROM users u WHERE u.id=$1 AND NOT u.archived AND NOT u.suspended
         AND ($2::integer IS NULL OR u.owner OR EXISTS(
           SELECT 1 FROM employees e WHERE e.company_id=$2
           AND e.user_id=u.id AND e.active))`,
      [userId, companyId],
    )).rows[0];
    if (!eligible) continue;
    await emitNotification(client, {
      code,
      companyId,
      recipientUserId: userId,
      subjectUserId: companyId === null ? userId : undefined,
      subjectEmployeeId: companyId === null ? null : eligible.employee_id,
      explicitSubjectOnly: true,
      subjectKey: `inquiries:unanswered:user:${userId}`,
      eventKey: `inquiries:unanswered:${userId}:${generation}`,
      message: ids.length === 1
        ? "يوجد استفسار واحد موجّه إليك بدون إجابة."
        : `يوجد ${ids.length} استفسارات موجّهة إليك بدون إجابة.`,
      href: companyId === null ? "/inquiries?status=mine" :
        `/companies/${companyId}/inquiries?status=mine`,
    });
  }
}

/** An hourly safety scan catches pre-existing inquiries or missed events. */
export async function scanUnansweredInquiryNotifications(
  client: PoolClient,
  companyId: number | null,
): Promise<void> {
  const key = scopeKey(companyId);
  const due = await client.query(
    `INSERT INTO inquiry_notification_scans(scope_key,checked_at)
     VALUES($1,clock_timestamp())
     ON CONFLICT(scope_key) DO UPDATE SET checked_at=EXCLUDED.checked_at
     WHERE inquiry_notification_scans.checked_at<=EXCLUDED.checked_at-interval '1 hour'
     RETURNING checked_at`,
    [key],
  );
  if (!due.rowCount) return;
  const users = await client.query<{ user_id: number }>(
    `SELECT user_id FROM inquiry_notification_state WHERE scope_key=$2
     UNION
     SELECT t.user_id FROM inquiry_requests q
       JOIN inquiry_targets t ON t.inquiry_id=q.id
     WHERE q.company_id IS NOT DISTINCT FROM $1
       AND q.status='open' AND t.status='pending'
     ORDER BY user_id`,
    [companyId, key],
  );
  await syncUnansweredInquiryNotifications(client, companyId, users.rows.map(row => row.user_id));
}
