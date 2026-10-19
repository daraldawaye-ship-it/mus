import type { PoolClient } from "pg";
import type { User } from "../../../../packages/contracts/src/index.ts";
import { directoryEntries } from "./pages.ts";
import { missing } from "../errors.ts";

export interface CompositionStatisticsPeriod {
  saleTimes: string;
  saleUnit1: string;
  purchaseTimes: string;
  purchaseUnit1: string;
}
export interface CompositionStatisticsGroup {
  key: "all"|"higher"|"lower";
  linkedItems: number;
  availableAlternatives: number|null;
  availableUnit1: string|null;
  minimumSalePrice: string|null;
  maximumSalePrice: string|null;
  minimumPurchasePrice: string|null;
  maximumPurchasePrice: string|null;
  topSellingItem: {id:number;name:string;times:string}|null;
  periods: Record<"oneMonth"|"fourMonths"|"twelveMonths",CompositionStatisticsPeriod>|null;
}
export interface CompositionStatistics {
  compositionId:number;
  asOf:string;
  priceSplitThreshold:string|null;
  canViewStock:boolean;
  canViewCommerce:boolean;
  groups:CompositionStatisticsGroup[];
}

/** Composition card reads compact materialized projections only; it never
 * rereads historic invoice lines or stock movements to compute statistics.
 * Time-window totals are based on the Aden-local report date.
 */
export async function readCompositionStatistics(
  client:PoolClient,user:User,companyId:number,compositionId:number,
):Promise<CompositionStatistics> {
  const composition=(await client.query(
    "SELECT price_split_threshold::text AS threshold FROM item_compositions WHERE company_id=$1 AND id=$2",
    [companyId,compositionId],
  )).rows[0];
  if(!composition) missing("التركيب غير موجود");
  const directory=await directoryEntries(client,user,companyId);
  const permitted=(key:string)=>directory.some(p=>p.key===key && p.enabled && p.actionAccess.view);
  const canViewStock=permitted("company.stock-balances") && permitted("company.stock-movements");
  const canViewCommerce=permitted("company.sales") && permitted("company.purchases") &&
    permitted("company.invoice");
  const asOf=(await client.query(
    "SELECT (clock_timestamp() AT TIME ZONE 'Asia/Aden')::date::text AS today",
  )).rows[0].today as string;
  const snapshot=await client.query(
    `SELECT group_key,linked_items,available_alternatives,available_unit1::text AS available_unit1,
      minimum_sale_price::text AS minimum_sale_price,maximum_sale_price::text AS maximum_sale_price,
      minimum_purchase_price::text AS minimum_purchase_price,maximum_purchase_price::text AS maximum_purchase_price,
      top_selling_item_id,top_selling_item_name,top_selling_times::text AS top_selling_times
     FROM item_composition_statistics WHERE company_id=$1 AND composition_id=$2
     ORDER BY CASE group_key WHEN 'all' THEN 0 WHEN 'higher' THEN 1 ELSE 2 END`,
    [companyId,compositionId],
  );
  const activity=canViewCommerce ? (await client.query(
    `WITH periods(period,start_date) AS (
      VALUES ('oneMonth',($3::date-INTERVAL '1 month'+INTERVAL '1 day')::date),
             ('fourMonths',($3::date-INTERVAL '4 months'+INTERVAL '1 day')::date),
             ('twelveMonths',($3::date-INTERVAL '12 months'+INTERVAL '1 day')::date)
     )
     SELECT s.group_key,p.period,
       COALESCE(SUM(d.sale_times),0)::text AS sale_times,
       COALESCE(SUM(d.sale_unit1),0)::text AS sale_unit1,
       COALESCE(SUM(d.purchase_times),0)::text AS purchase_times,
       COALESCE(SUM(d.purchase_unit1),0)::text AS purchase_unit1
     FROM item_composition_statistics s CROSS JOIN periods p
     LEFT JOIN item_composition_daily_statistics d
       ON d.company_id=s.company_id AND d.composition_id=s.composition_id
       AND d.group_key=s.group_key AND d.document_date BETWEEN p.start_date AND $3::date
     WHERE s.company_id=$1 AND s.composition_id=$2
     GROUP BY s.group_key,p.period`,
    [companyId,compositionId,asOf],
  )).rows:[] as Array<Record<string,unknown>>;
  const activityLookup=new Map(activity.map(row=>[
    String(row.group_key)+":"+String(row.period),row,
  ]));
  const windows=["oneMonth","fourMonths","twelveMonths"] as const;
  const groups:CompositionStatisticsGroup[]=snapshot.rows.map(row=>{
    const key=row.group_key as CompositionStatisticsGroup["key"];
    const periods=canViewCommerce ? Object.fromEntries(windows.map(period=>{
      const data=activityLookup.get(key+":"+period);
      return [period,{
        saleTimes:String(data?.sale_times??"0"),
        saleUnit1:String(data?.sale_unit1??"0"),
        purchaseTimes:String(data?.purchase_times??"0"),
        purchaseUnit1:String(data?.purchase_unit1??"0"),
      }];
    })) as NonNullable<CompositionStatisticsGroup["periods"]> : null;
    return {
      key,linkedItems:row.linked_items,
      availableAlternatives:canViewStock?row.available_alternatives:null,
      availableUnit1:canViewStock?row.available_unit1:null,
      minimumSalePrice:row.minimum_sale_price,maximumSalePrice:row.maximum_sale_price,
      minimumPurchasePrice:canViewCommerce?row.minimum_purchase_price:null,
      maximumPurchasePrice:canViewCommerce?row.maximum_purchase_price:null,
      topSellingItem:canViewCommerce && row.top_selling_item_id!==null
        ? {id:row.top_selling_item_id,name:row.top_selling_item_name,
          times:row.top_selling_times} : null,
      periods,
    };
  });
  return {compositionId,asOf,priceSplitThreshold:composition.threshold,
    canViewStock,canViewCommerce,groups};
}
