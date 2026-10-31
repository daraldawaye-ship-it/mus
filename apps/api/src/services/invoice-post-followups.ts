import type { Pool } from "pg";
import { transaction } from "../db.ts";
import { userDTO } from "../repositories/models.ts";
import { awardPostedInvoice } from "./invoice-rewards.ts";
import { accrueInvoiceClearance } from "./clearance-earnings.ts";
import { emitNotification } from "./notifications.ts";
import { archivedDoctorSaleNotice } from "./sales-doctor-notification.ts";

interface Followup {
  id: string;
  company_id: number;
  invoice_id: number;
  created_by: number;
  customer_reward_kind: "new" | "existing" | null;
  doctor_reward_eligible: boolean;
  new_doctor_id: number | null;
  new_doctor_name: string | null;
  archived_doctor_id: number | null;
  archived_doctor_name: string | null;
}

function codeOf(error: unknown): string {
  const candidate = error && typeof error === "object" && "code" in error
    ? String(error.code) : "post_followup_failed";
  return /^[A-Za-z0-9_]{1,64}$/.test(candidate) ? candidate : "post_followup_failed";
}

/** A single queued invoice's follow-ups all succeed or roll back together.
 * The queue row is locked, so overlapping ticks/instances cannot duplicate
 * reward ledger entries, and a process crash leaves work eligible for retry.
 */
export async function processInvoicePostFollowup(pool: Pool): Promise<boolean> {
  let attemptedId: string | null = null;
  try {
    return await transaction(pool, async client => {
      const next = await client.query<Followup>(
        `SELECT * FROM invoice_post_followups
         WHERE processed_at IS NULL AND next_attempt_at<=clock_timestamp()
         ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`,
      );
      const job = next.rows[0];
      if (!job) return false;
      attemptedId = job.id;
      const row = await client.query<{kind:"sale"|"purchase";number:string;posted:boolean}>(
        "SELECT kind,number,posted FROM invoices WHERE company_id=$1 AND id=$2",
        [job.company_id, job.invoice_id],
      );
      const invoice = row.rows[0];
      if (!invoice?.posted) throw new Error("invoice_post_followup_not_posted");
      const actor = await client.query("SELECT * FROM users WHERE id=$1", [job.created_by]);
      if (!actor.rows[0]) throw new Error("invoice_post_followup_missing_user");
      const user = userDTO(actor.rows[0]);
      await awardPostedInvoice(client, job.company_id, job.invoice_id, invoice.kind,
        user, invoice.number, job.customer_reward_kind, job.doctor_reward_eligible);
      if (invoice.kind === "sale")
        await accrueInvoiceClearance(client, job.company_id, job.invoice_id, user);
      if (job.new_doctor_id !== null && job.new_doctor_name) {
        await emitNotification(client, {
          code: "SALES_DOCTOR_REVIEW",
          companyId: job.company_id,
          subjectKey: `doctor:${job.new_doctor_id}`,
          eventKey: `doctor:new:${job.new_doctor_id}`,
          title: "اسم طبيب أو جهة جديد يحتاج مراجعة",
          message: `أُضيف «${job.new_doctor_name}» تلقائيًا من فاتورة المبيعات ${invoice.number}. حدّد الفئة وباقي التفاصيل أو أرشف الكرت.`,
          href: `/companies/${job.company_id}/doctors?focus=${job.new_doctor_id}`,
        });
      }
      if (job.archived_doctor_id !== null && job.archived_doctor_name) {
        // Keep the prior defensive registration for deployments with older data.
        await client.query(
          `INSERT INTO notification_templates
             (code,name,category,scope,description,implemented,can_disable,
              default_importance,default_notify_managers)
           VALUES ('SALES_ARCHIVED_DOCTOR_USED',
                   'استخدام طبيب أو جهة مؤرشفة في المبيعات','مبيعات','company',
                   'استخدام اسم طبيب أو جهة مؤرشفة في فاتورة مبيعات مع بقاء الكرت مؤرشفًا.',
                   true,true,'medium',false)
           ON CONFLICT (code) DO NOTHING`,
        );
        await emitNotification(client, archivedDoctorSaleNotice(
          job.company_id, { id: job.archived_doctor_id,
            name: job.archived_doctor_name }, job.invoice_id, invoice.number,
        ));
      }
      await client.query(
        "UPDATE invoice_post_followups SET processed_at=clock_timestamp(),last_error_code=NULL WHERE id=$1",
        [job.id],
      );
      return true;
    });
  } catch (error) {
    // Only a short code is kept; sensitive payloads/SQL details stay out of logs.
    const code = codeOf(error);
    if (attemptedId !== null) {
      try {
        await pool.query(
          `UPDATE invoice_post_followups
           SET attempts=attempts+1,last_error_code=$2,
             next_attempt_at=clock_timestamp()+
               (LEAST(300,power(2,LEAST(attempts+1,8))::integer)*interval '1 second')
           WHERE id=$1 AND processed_at IS NULL`,
          [attemptedId, code],
        );
      } catch {
        console.error("INVOICE_FOLLOWUP_RETRY_STATE_FAILED");
      }
    }
    console.error("INVOICE_FOLLOWUP_RETRY", code);
    return false;
  }
}

/** Schedules derived rewards, clearance and notifications after COMMIT.
 * The durable DB queue—not this timer—owns retries across deployments.
 */
export function startInvoicePostFollowups(pool: Pool): () => Promise<void> {
  let stopped = false;
  let running: Promise<void> | null = null;
  const tick = () => {
    // Rewards/clearance do not belong to the cashier's response time. On
    // Render's small single-instance database/app budget, prefer foreground
    // financial posting whenever a client is already waiting for a PG slot.
    // One short job per tick avoids a four-job batch monopolizing the pool.
    if (stopped || running || pool.waitingCount > 0) return;
    running = processInvoicePostFollowup(pool).then(() => undefined)
      .catch(() => console.error("INVOICE_FOLLOWUP_WORKER_ERROR"))
      .finally(() => { running = null; });
  };
  // The durable queue is replayed after restart; no need to drain immediately
  // during startup or compete with checkout requests every second.
  const timer = setInterval(tick, 3_000);
  timer.unref();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await running;
  };
}
