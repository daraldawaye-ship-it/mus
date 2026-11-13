import type { PoolClient } from "pg";
import { emitNotification } from "./notifications.ts";

type ReturnedItem = {
  item_id: number;
  item_name: string;
  days_since_last_sale: number | null;
  last_sale_date: string | null;
};

/**
 * Run once per newly posted invoice via the durable follow-up queue.
 * Only positive sales count as sales; negative lines (returns) do not.
 * The clock is the posted return's business date, not the worker's run time.
 */
export async function notifyReturnWithoutRecentSales(
  client: PoolClient,
  companyId: number,
  invoiceId: number,
  invoiceNumber: string,
): Promise<void> {
  const result = await client.query<ReturnedItem>(
    `WITH returned AS (
       SELECT lines.item_id, MAX(lines.item_name) AS item_name,
              invoice.document_date::date AS return_date
         FROM invoice_lines lines
         JOIN invoices invoice ON invoice.company_id=lines.company_id
          AND invoice.id=lines.invoice_id
        WHERE lines.company_id=$1 AND lines.invoice_id=$2
          AND invoice.kind='sale' AND invoice.posted
          AND lines.smallest_quantity::numeric<0
        GROUP BY lines.item_id,invoice.document_date
     )
     SELECT returned.item_id,returned.item_name,
            (returned.return_date-last_sale.last_sale_date)::integer AS days_since_last_sale,
            last_sale.last_sale_date::text AS last_sale_date
       FROM returned
       LEFT JOIN LATERAL (
         SELECT MAX(sale.document_date::date) AS last_sale_date
           FROM invoice_lines sold
           JOIN invoices sale ON sale.company_id=sold.company_id
            AND sale.id=sold.invoice_id
          WHERE sold.company_id=$1 AND sold.item_id=returned.item_id
            AND sold.smallest_quantity::numeric>0
            AND sale.kind='sale' AND sale.posted AND sale.id<>$2
            AND sale.document_date::date<=returned.return_date
       ) last_sale ON true`,
    [companyId, invoiceId],
  );
  for (const row of result.rows) {
    const days = row.days_since_last_sale;
    if (days !== null && days <= 3) continue;
    const isMonth = days === null || days > 30;
    const period = isMonth ? "30 يومًا" : "3 أيام";
    const code = isMonth ? "SALES_RETURN_NO_SALES_30D" : "SALES_RETURN_NO_SALES_3D";
    await emitNotification(client, {
      code,
      companyId,
      subjectKey: `sales-return:${invoiceId}:item:${row.item_id}`,
      eventKey: `sales-return:no-recent-sales:${invoiceId}:${row.item_id}`,
      title: isMonth ? "إرجاع صنف بلا مبيعات خلال شهر" : "إرجاع صنف بلا مبيعات خلال 3 أيام",
      message: `أُرجع الصنف «${row.item_name}» في فاتورة المبيعات رقم ${invoiceNumber}، ولم تُسجل له مبيعات خلال آخر ${period}.${row.last_sale_date ? ` آخر بيع مسجل: ${row.last_sale_date}.` : " لا توجد مبيعات سابقة مسجلة."}`,
      href: `/companies/${companyId}/invoices`,
    });
  }
}
