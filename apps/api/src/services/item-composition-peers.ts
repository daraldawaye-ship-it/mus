import type { PoolClient } from "pg";
import type { ItemCompositionPeers, User } from "../../../../packages/contracts/src/index.ts";
import { directoryEntries } from "./pages.ts";
import { HttpError, missing } from "../errors.ts";
import { assertItemSaleRankingsReady } from "./item-sale-ranking.ts";

/** Existing composition relationship only: no reservation or implied interchangeable stock. */
export async function readItemCompositionPeers(
 client: PoolClient,user: User,companyId: number,itemId: number,page: number,pageSize: 10 | 20 = 20, workPanel=false,
): Promise<ItemCompositionPeers> {
 const primary=(await client.query(
   `SELECT i.composition_id,c.arabic_name,c.english_name,c.active,
     c.identical_alternative,c.non_interchangeable
    FROM items i LEFT JOIN item_compositions c
      ON c.company_id=i.company_id AND c.id=i.composition_id
    WHERE i.company_id=$1 AND i.id=$2`,[companyId,itemId],
 )).rows[0];
 if(!primary) missing();
 const permissions=await directoryEntries(client,user,companyId);
 const allowed=(key:string)=>!!permissions.find(p=>p.key===key)?.actionAccess.view;
 const canViewStock=allowed("company.stock-balances")&&allowed("company.stock-movements");
 const hasEnabledView=(key:string)=>permissions.some(p=>p.key===key&&p.enabled&&p.actionAccess.view);
 const canViewMonthlySales=workPanel&&hasEnabledView("company.sales")&&hasEnabledView("company.invoice");
 const composition=primary.composition_id===null?null:{
   id:primary.composition_id as number,arabicName:primary.arabic_name as string,
   englishName:primary.english_name as string,active:primary.active as boolean,
   identicalAlternative:primary.identical_alternative as boolean,
   nonInterchangeable:primary.non_interchangeable as boolean,
 };
 const relation:ItemCompositionPeers["relation"]=!composition?"none":
   composition.nonInterchangeable?"nonInterchangeable":
   composition.active&&composition.identicalAlternative?"identicalAlternative":"sameComposition";
 const result:ItemCompositionPeers={
   companyId,itemId,canViewStock,composition,relation,
   total:0,page,pageSize,peers:[],
   ...(workPanel?{canViewMonthlySales}:{}),
 };
 if(!composition)return result;
 const count=await client.query(
   "SELECT count(*)::int AS total FROM items WHERE company_id=$1 AND composition_id=$2 AND id<>$3 AND active=true",
   [companyId,composition.id,itemId],
 );
 result.total=count.rows[0]?.total??0;
 const stockCol=canViewStock
   ?"s.stock_total::text AS stock_smallest, (COALESCE(s.stock_showroom,0)+COALESCE(s.stock_warehouse,0))::text AS stock_available_smallest"
   :"NULL::text AS stock_smallest, NULL::text AS stock_available_smallest";
 const stockJoin=canViewStock
   ?"LEFT JOIN item_statistics s ON s.company_id=i.company_id AND s.item_id=i.id":"";
 // Dock ordering uses non-return stock, then the same net calendar-month
 // quantity as item-options-list, before display rounding and before paging.
 const firstUnit="greatest(i.factor2::numeric*i.factor3::numeric,1)";
 const availableStock="(COALESCE(s.stock_showroom,0)+COALESCE(s.stock_warehouse,0))";
 const monthlySales=`(COALESCE(sale_rank.net_sale_quantity,0)
      +COALESCE(staged_rank.net_sale_quantity,0)+COALESCE(planning_fix.month_delta,0))::numeric/${firstUnit}`;
 let monthlyReady=canViewMonthlySales;
 if(monthlyReady) {
   try { await assertItemSaleRankingsReady(client); }
   catch(error) {
     // Brief cache rebuild may hide sales, but must not hide peers and stock.
     if(!(error instanceof HttpError) || error.code!=="search_updating")throw error;
     monthlyReady=false;
   }
 }
 const monthlyJoins=monthlyReady?`
    CROSS JOIN (SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Aden')::date AS as_of) calendar
    LEFT JOIN item_sale_rankings sale_rank ON sale_rank.company_id=i.company_id
      AND sale_rank.item_id=i.id AND sale_rank.as_of_date=calendar.as_of
    LEFT JOIN staged_item_sale_rankings staged_rank ON staged_rank.company_id=i.company_id
      AND staged_rank.item_id=i.id AND staged_rank.as_of_date=calendar.as_of
    LEFT JOIN LATERAL (
      SELECT SUM(quantity_delta) AS month_delta
      FROM legacy_sales_planning_daily_deltas planning
      WHERE planning.company_id=i.company_id AND planning.item_id=i.id
        AND planning.document_date BETWEEN
          (calendar.as_of - interval '1 month'+interval '1 day')::date AND calendar.as_of
    ) planning_fix ON TRUE`:"";
 const order=[
   ...(canViewStock?[workPanel?`${availableStock}/${firstUnit} DESC`
     :`COALESCE(s.stock_total,0)::numeric/(i.factor2::numeric*i.factor3::numeric) DESC`]:[]),
   ...(monthlyReady?[`${monthlySales} DESC`]:[]),
   "i.code","i.id",
 ].join(",");
 const rows=await client.query(
   `SELECT i.id,i.code,i.name,i.active,i.unit1_name,i.unit2_name,i.unit3_name,
     i.factor2,i.factor3,${stockCol},
     ${monthlyReady?`round(${monthlySales},4)::text`:"NULL::text"} AS sale_quantity_month
    FROM items i ${stockJoin} ${monthlyJoins}
    WHERE i.company_id=$1 AND i.composition_id=$2 AND i.id<>$3 AND i.active=true
    ORDER BY ${order} LIMIT $5 OFFSET $4`,
   [companyId,composition.id,itemId,(page-1)*pageSize,pageSize],
 );
 result.peers=rows.rows.map(r=>({
   id:r.id,code:r.code,name:r.name,active:r.active,
   smallestUnitName:r.factor3>1?r.unit3_name:r.factor2>1?r.unit2_name:r.unit1_name,
   unit1Name:r.unit1_name,factor2:r.factor2,factor3:r.factor3,
   stockSmallest:r.stock_smallest??(canViewStock?"0":null),
   stockAvailableSmallest:r.stock_available_smallest??null,
   ...(workPanel?{saleQuantityMonth:r.sale_quantity_month??null}:{}),
 }));
 return result;
}
