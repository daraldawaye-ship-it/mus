import type { PoolClient } from "pg";
import { emitNotification } from "./notifications.ts";

type ReceiptKind = "electronic" | "pouch" | "close";
const codes: Record<ReceiptKind, string> = {
  electronic: "CASHBOX_ELECTRONIC_TRANSFER",
  pouch: "CASHBOX_POUCH_TRANSFER",
  close: "CASHBOX_CLOSED",
};

async function pendingCount(client: PoolClient, companyId: number, kind: ReceiptKind) {
  const receiptTable = kind === "electronic" ? "employee_electronic_receipts" : "employee_pouch_receipts";
  const custodyCount = kind === "pouch" ? ` + (SELECT count(*) FROM administrative_custody_transfers t
    WHERE t.company_id=$1 AND NOT EXISTS (SELECT 1 FROM administrative_custody_receipts r
      WHERE r.company_id=t.company_id AND r.source_transfer_id=t.id))` : "";
  const result = await client.query(
    `SELECT (SELECT count(*) FROM employee_cashbox_operations o
     WHERE o.company_id=$1 AND o.kind=$2 AND o.amount<>0 AND NOT EXISTS (
       SELECT 1 FROM ${receiptTable} r WHERE r.company_id=o.company_id AND r.source_operation_id=o.id))
     ${custodyCount} AS count`, [companyId, kind]);
  return Number(result.rows[0].count);
}

/** Posts, receipts and the hourly worker share the company transaction lock. */
export async function checkPendingReceipts(
  client: PoolClient, companyId: number, kind: ReceiptKind, event: string, refreshOnly = false,
) {
  const count = await pendingCount(client, companyId, kind);
  const code = codes[kind];
  if (!count) {
    await client.query(
      `UPDATE notifications SET completed_at=clock_timestamp(),read_at=COALESCE(read_at,clock_timestamp()),
       snoozed_until=NULL,next_reminder_at=NULL,revision=revision+1,updated_at=clock_timestamp()
       WHERE company_id=$1 AND code=$2 AND completed_at IS NULL`, [companyId, code]);
    return;
  }
  // Recording a receipt can resolve the last alert; it does not announce a new transfer.
  const description = kind === "electronic" ? "ترحيلات المحفظة الإلكترونية" :
    kind === "close" ? "إغلاقات الصندوق" : "ترحيلات الحافظة";
  const key = code + ":" + event;
  await emitNotification(client, {
    companyId, code, refreshOnly, subjectKey: key, eventKey: key,
    message: description + " بانتظار الاستلام: " + count + ".",
    href: "/companies/" + companyId + (kind === "electronic" ? "/electronic-receipts" : "/pouch-receipts"),
  });
}

export async function scanCashboxReceipts(client: PoolClient, companyId: number) {
  const due = await client.query(
    `INSERT INTO cashbox_notification_scans(company_id,checked_at) VALUES($1,clock_timestamp())
     ON CONFLICT(company_id) DO UPDATE SET checked_at=EXCLUDED.checked_at
     WHERE cashbox_notification_scans.checked_at <= EXCLUDED.checked_at - interval '1 hour'
     RETURNING checked_at`, [companyId]);
  if (!due.rowCount) return;
  const event = "scan:" + due.rows[0].checked_at.toISOString();
  for (const kind of ["electronic", "pouch", "close"] as const)
    await checkPendingReceipts(client, companyId, kind, event);
}
