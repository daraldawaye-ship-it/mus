import type { Pool } from "pg";
import { transaction } from "../db.ts";
import { emitNotification } from "./notifications.ts";
import type { ClearanceNoticeCode } from "./item-clearance-notices.ts";

interface PendingClearanceNotice {
  id: string;
  company_id: number;
  item_id: number;
  item_revision: number;
  notification_code: ClearanceNoticeCode;
  title: string;
  message: string;
}

function retryCode(error: unknown): string {
  const value = error && typeof error === "object" && "code" in error
    ? String(error.code) : "clearance_notification_failed";
  return /^[A-Za-z0-9_]{1,64}$/.test(value) ? value : "clearance_notification_failed";
}

/** One committed card edit -> one notification event per configured recipient.
 * The row lock and event key make retries and overlapping worker ticks safe.
 */
export async function processItemClearanceNotification(pool: Pool): Promise<boolean> {
  let attemptedId: string | null = null;
  try {
    return await transaction(pool, async client => {
      const found = await client.query<PendingClearanceNotice>(
        `SELECT id,company_id,item_id,item_revision,notification_code,title,message
         FROM item_clearance_notification_jobs
         WHERE processed_at IS NULL AND next_attempt_at<=clock_timestamp()
         ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`,
      );
      const pending = found.rows[0];
      if (!pending) return false;
      attemptedId = pending.id;
      await emitNotification(client, {
        code: pending.notification_code,
        companyId: pending.company_id,
        subjectKey: `item:${pending.item_id}`,
        eventKey: `item:clearance:${pending.item_id}:revision:${pending.item_revision}`,
        title: pending.title,
        message: pending.message,
        href: `/companies/${pending.company_id}/items/${pending.item_id}`,
      });
      await client.query(
        "UPDATE item_clearance_notification_jobs SET processed_at=clock_timestamp(),last_error_code=NULL WHERE id=$1",
        [pending.id],
      );
      return true;
    });
  } catch (error) {
    if (attemptedId !== null) {
      try {
        await pool.query(
          `UPDATE item_clearance_notification_jobs
           SET attempts=attempts+1,last_error_code=$2,
             next_attempt_at=clock_timestamp()+
               (LEAST(300,power(2,LEAST(attempts+1,8))::integer)*interval '1 second')
           WHERE id=$1 AND processed_at IS NULL`,
          [attemptedId,retryCode(error)],
        );
      } catch {
        console.error("ITEM_CLEARANCE_NOTIFICATION_RETRY_STATE_FAILED");
      }
    }
    console.error("ITEM_CLEARANCE_NOTIFICATION_RETRY",retryCode(error));
    return false;
  }
}

/** Background delivery, without extending item PATCH response time. */
export function startItemClearanceNotifications(pool: Pool): () => Promise<void> {
  let stopped = false;
  let running: Promise<void> | null = null;
  const tick = () => {
    if (stopped || running || pool.waitingCount > 0) return;
    running = processItemClearanceNotification(pool).then(() => undefined)
      .catch(() => console.error("ITEM_CLEARANCE_NOTIFICATION_WORKER_FAILED"))
      .finally(() => { running = null; });
  };
  const timer = setInterval(tick, 4_000);
  timer.unref();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await running;
  };
}
