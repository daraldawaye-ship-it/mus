import type { PoolClient } from "pg";
import type { User } from "../../../../packages/contracts/src/index.ts";
import { HttpError } from "../errors.ts";
import { directoryEntries } from "./pages.ts";

/**
 * Monthly counts are prepared outside search and maintained by daily-activity
 * deltas in the posting transaction. A missing sparse row means a zero count.
 * Use the transaction's Aden date for both readiness and the lookup.
 */
export const itemSaleTimesJoinSql = ` LEFT JOIN item_sale_rankings sale_rank
 ON sale_rank.company_id=i.company_id AND sale_rank.item_id=i.id
 AND sale_rank.as_of_date=(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Aden')::date`;
export const itemSaleTimesOrderSql = "COALESCE(sale_rank.net_sale_invoices,0)";

export async function assertItemSaleRankingsReady(client: PoolClient): Promise<void> {
  const ready = await client.query(
    "SELECT 1 FROM item_sale_ranking_days WHERE as_of_date=(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Aden')::date",
  );
  if (!ready.rowCount)
    throw new HttpError(503, "search_updating", "البحث قيد التحديث، حاول مجددًا بعد لحظات");
}

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
