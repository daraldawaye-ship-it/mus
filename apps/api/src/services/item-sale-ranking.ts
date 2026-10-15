import type { PoolClient } from "pg";
import type { User } from "../../../../packages/contracts/src/index.ts";
import { directoryEntries } from "./pages.ts";

/**
 * Rolling one-month net occurrences per item: distinct positive sale invoices
 * minus distinct return invoices. The source facts are updated on posting;
 * do not scan immutable invoice lines in search requests.
 *
 * The inner subquery is scoped by the item company's composite key, and the
 * (company_id,item_id,document_date) PK supports the requested date range.
 */
export const itemSaleTimesOrderSql = `COALESCE((
 SELECT SUM(d.sale_invoices - d.sale_return_invoices)
 FROM item_daily_activity d
 WHERE d.company_id=i.company_id AND d.item_id=i.id
   AND d.document_date BETWEEN
     ((clock_timestamp() AT TIME ZONE 'Asia/Aden')::date - INTERVAL '1 month' + INTERVAL '1 day')::date
     AND (clock_timestamp() AT TIME ZONE 'Asia/Aden')::date
),0)`;

/** Hide sales-based ranking when the invoice/sales pages are not visible. */
export async function canOrderItemsBySales(
 client:PoolClient,user:User,companyId:number
):Promise<boolean>{
 const pages=await directoryEntries(client,user,companyId);
 return ["company.sales","company.purchases","company.invoice"].every(key=>{
   const page=pages.find(p=>p.key===key);
   return !!page?.enabled && !!page.actionAccess.view;
 });
}
