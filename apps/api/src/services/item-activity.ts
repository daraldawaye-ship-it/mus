import type { PoolClient } from "pg";
import type { ItemActivity, ItemActivityPeriod, User } from "../../../../packages/contracts/src/index.ts";
import { directoryEntries } from "./pages.ts";
import { missing } from "../errors.ts";
import { stagedDailyActivitySql,activityColumns } from "./staged-activity-sql.ts";

/** Date-scoped report; no invoice-table scan on each item-card read. */
export async function readItemActivity(
 client: PoolClient,user: User,companyId: number,itemId: number,
): Promise<ItemActivity> {
 const item=(await client.query(
   "SELECT unit1_name,unit2_name,unit3_name,factor2,factor3 FROM items WHERE company_id=$1 AND id=$2",
   [companyId,itemId],
 )).rows[0];
 if(!item) missing();
 const permitted=await directoryEntries(client,user,companyId);
 const allow=(key:string)=>!!permitted.find(p=>p.key===key)?.actionAccess.view;
 const canViewCommerce=allow("company.sales")&&allow("company.purchases")&&allow("company.invoice");
 const asOf=(await client.query(
   "SELECT (clock_timestamp() AT TIME ZONE 'Asia/Aden')::date::text AS today",
 )).rows[0].today as string;
 const unitName: string=item.factor3>1?item.unit3_name:item.factor2>1?item.unit2_name:item.unit1_name;
 if(!canViewCommerce) return {companyId,itemId,asOf,unitName,canViewCommerce,periods:null};
 const rows=(await client.query(
 `WITH periods(label,start_date) AS (
   VALUES ('oneMonth',($3::date-interval '1 month'+interval '1 day')::date),
          ('fourMonths',($3::date-interval '4 months'+interval '1 day')::date),
          ('twelveMonths',($3::date-interval '12 months'+interval '1 day')::date),
          ('allTime',NULL::date)
 ), staged AS (
   ${stagedDailyActivitySql("$3::date")}
 ), activity AS (
   SELECT ${activityColumns.join(",")} FROM item_daily_activity
     WHERE company_id=$1 AND item_id=$2 AND document_date<=$3::date
   UNION ALL
   SELECT ${activityColumns.join(",")} FROM staged WHERE item_id=$2
 )
 SELECT p.label,
   coalesce(sum(d.sale_invoices),0)::text AS "saleInvoices",
   coalesce(sum(d.sale_return_invoices),0)::text AS "saleReturnInvoices",
   coalesce(sum(d.sale_lines),0)::text AS "saleLines",
   coalesce(sum(d.sale_return_lines),0)::text AS "saleReturnLines",
   coalesce(sum(d.sale_quantity),0)::text AS "saleQuantity",
   coalesce(sum(d.sale_return_quantity),0)::text AS "saleReturnQuantity",
   coalesce(sum(d.purchase_invoices),0)::text AS "purchaseInvoices",
   coalesce(sum(d.purchase_return_invoices),0)::text AS "purchaseReturnInvoices",
   coalesce(sum(d.purchase_lines),0)::text AS "purchaseLines",
   coalesce(sum(d.purchase_return_lines),0)::text AS "purchaseReturnLines",
   coalesce(sum(d.purchase_quantity),0)::text AS "purchaseQuantity",
   coalesce(sum(d.purchase_return_quantity),0)::text AS "purchaseReturnQuantity"
 FROM periods p LEFT JOIN activity d
   ON d.company_id=$1 AND d.item_id=$2 AND d.document_date<=$3::date
   AND (p.start_date IS NULL OR d.document_date>=p.start_date)
 GROUP BY p.label`,
 [companyId,itemId,asOf]
 )).rows as Array<{label: keyof NonNullable<ItemActivity["periods"]>} & ItemActivityPeriod>;
 const zero: ItemActivityPeriod={
   saleInvoices:"0",saleReturnInvoices:"0",saleLines:"0",saleReturnLines:"0",saleQuantity:"0",saleReturnQuantity:"0",purchaseInvoices:"0",purchaseReturnInvoices:"0",purchaseLines:"0",purchaseReturnLines:"0",purchaseQuantity:"0",purchaseReturnQuantity:"0"
 };
 const found=new Map(rows.map(row=>[row.label,row]));
 return {
   companyId,itemId,asOf,unitName,canViewCommerce,
   periods:{
     oneMonth:found.get("oneMonth")??zero,
     fourMonths:found.get("fourMonths")??zero,
     twelveMonths:found.get("twelveMonths")??zero,
     allTime:found.get("allTime")??zero,
   },
 };
}
