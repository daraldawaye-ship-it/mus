import type { PoolClient } from "pg";
import { emitNotification } from "./notifications.ts";
import { thirdPartyGoodsSql } from "./third-party-goods.ts";

type StoppedPurchaseItem = {
  item_id: number;
  item_name: string;
  item_code: string;
  stopped_until: string;
};

/**
 * Notify once per distinct received item on a newly posted purchase invoice.
 * Read the current item card, but compare the stop date with the invoice's
 * posting date in Aden, not with a delayed worker's processing date.
 * The current special-order threshold is NULL when unset; zero is explicitly set.
 * Positive lines only: purchase returns must never raise this alert.
 */
export async function notifyPurchaseOfStoppedOrderItem(
  client: PoolClient,
  companyId: number,
  invoiceId: number,
  invoiceNumber: string,
): Promise<void> {
  const result = await client.query<StoppedPurchaseItem>(
    `SELECT line.item_id,
            MAX(line.item_name) AS item_name,
            MAX(item.code) AS item_code,
            MAX(item.order_stopped_until)::text AS stopped_until
       FROM invoice_lines line
       JOIN invoices purchase ON purchase.company_id=line.company_id
         AND purchase.id=line.invoice_id
       JOIN items item ON item.company_id=line.company_id
         AND item.id=line.item_id
      WHERE line.company_id=$1 AND line.invoice_id=$2
        AND purchase.kind='purchase' AND purchase.posted
        AND line.smallest_quantity::numeric>0
        AND item.order_stopped_until>(purchase.created_at AT TIME ZONE 'Asia/Aden')::date
        -- The visible special-order threshold is the authoritative field.
        -- Only an unset (NULL) threshold permits this alert; zero is set.
        AND item.order_alert_quantity IS NULL
        AND NOT ${thirdPartyGoodsSql("item","item.company_id","item.id")}
      GROUP BY line.item_id`,
    [companyId, invoiceId],
  );
  for (const item of result.rows) {
    await emitNotification(client, {
      code: "PURCHASE_STOPPED_ORDER",
      companyId,
      subjectKey: `purchase:${invoiceId}:item:${item.item_id}`,
      eventKey: `purchase:stopped-order:${invoiceId}:${item.item_id}`,
      title: "تم شراء صنف متوقف طلبه",
      message: `تم شراء الصنف «${item.item_name}» (الرمز: ${item.item_code}) في فاتورة المشتريات رقم ${invoiceNumber}، رغم أن طلب الصنف متوقف حتى ${item.stopped_until} وكمية الطلب في كرت الصنف غير محددة (فارغة). راجع الفاتورة والصنف.`,
      href: `/companies/${companyId}/stopped-order-items?itemId=${item.item_id}&invoiceId=${invoiceId}`,
    });
  }
}
