import type { PoolClient } from "pg";
import type { ItemActivityReport, ItemActivityReportSort, User } from "../../../../packages/contracts/src/index.ts";
import { directoryEntries } from "./pages.ts";
import { HttpError } from "../errors.ts";

export interface ItemActivityReportFilters {
 q:string;
 active:"active"|"archived"|"all";
 page:number;
 pageSize:number;
 sortBy:ItemActivityReportSort;
 sortDir:"asc"|"desc";
}

/** All sort expressions are from a static whitelist; user input is never interpolated into SQL. */
const sorts:Record<ItemActivityReportSort,string>={
 code:"i.code",name:"i.name",
 saleOneMonth:'a."saleOneMonth"',saleFourMonths:'a."saleFourMonths"',
 saleTwelveMonths:'a."saleTwelveMonths"',saleAllTime:'a."saleAllTime"',
 purchaseOneMonth:'a."purchaseOneMonth"',purchaseFourMonths:'a."purchaseFourMonths"',
 purchaseTwelveMonths:'a."purchaseTwelveMonths"',purchaseAllTime:'a."purchaseAllTime"',
};
const periods=[
 ["OneMonth","d.document_date>=($2::date-interval '1 month'+interval '1 day')::date"],
 ["FourMonths","d.document_date>=($2::date-interval '4 months'+interval '1 day')::date"],
 ["TwelveMonths","d.document_date>=($2::date-interval '12 months'+interval '1 day')::date"],
 ["AllTime","TRUE"],
] as const;
const quantities=[
 ["sale","sale_quantity"],
 ["purchase","purchase_quantity"],
 ["saleReturn","sale_return_quantity"],
 ["purchaseReturn","purchase_return_quantity"],
] as const;
const aggregates=quantities.flatMap(([name,column])=>periods.map(([period,predicate])=>
 `COALESCE(SUM(d.${column}) FILTER(WHERE ${predicate}),0) AS "${name}${period}"`
)).join(",\n");
const columns=quantities.flatMap(([name])=>periods.map(([period])=>
 `COALESCE(a."${name}${period}",0)::text AS "${name}${period}"`
)).join(",\n");

export async function readItemActivityReport(
 client:PoolClient,user:User,companyId:number,filters:ItemActivityReportFilters,
):Promise<ItemActivityReport>{
 const entries=await directoryEntries(client,user,companyId);
 const visible=(key:string)=>{const e=entries.find(x=>x.key===key);return !!e&&e.enabled&&e.actionAccess.view;};
 if(!["company.item-statistics-report","company.items","company.sales",
       "company.purchases","company.invoice"].every(visible))
   throw new HttpError(403,"item_report_denied",
     "عرض تقرير إحصائيات الأصناف يتطلب صلاحيات الأصناف وفواتير المبيعات والمشتريات");
 const asOf=(await client.query(
   "SELECT (clock_timestamp() AT TIME ZONE 'Asia/Aden')::date::text AS today",
 )).rows[0].today as string;
 const terms=[companyId,asOf,filters.q,filters.active];
 const predicate=`i.company_id=$1
   AND ($3::text='' OR i.name ILIKE '%'||$3||'%' OR i.english_name ILIKE '%'||$3||'%'
        OR i.code ILIKE '%'||$3||'%' OR i.barcode ILIKE '%'||$3||'%')
   AND ($4::text='all' OR ($4='active' AND i.active) OR ($4='archived' AND NOT i.active))`;
 const count=(await client.query(
   `SELECT count(*)::text AS total FROM items i WHERE ${predicate}`,terms,
 )).rows[0].total as string;
 const sort=sorts[filters.sortBy],direction=filters.sortDir==="asc"?"ASC":"DESC";
 const order=filters.sortBy==="code"||filters.sortBy==="name"
   ? `${sort} ${direction},i.id ASC`
   : `COALESCE(${sort},0) ${direction},i.code ASC,i.id ASC`;
 const data=await client.query(
  `WITH candidate AS (
     SELECT i.id,i.code,i.name,i.active,i.unit1_name,i.unit2_name,i.unit3_name,
            i.factor2,i.factor3 FROM items i WHERE ${predicate}
   ), a AS (
     SELECT d.item_id, ${aggregates}
       FROM item_daily_activity d JOIN candidate i ON i.id=d.item_id
       WHERE d.company_id=$1 AND d.document_date<=$2::date GROUP BY d.item_id
   )
   SELECT i.id,i.code,i.name,i.active,i.unit1_name,i.unit2_name,i.unit3_name,
          i.factor2,i.factor3,${columns}
   FROM candidate i LEFT JOIN a ON a.item_id=i.id
   ORDER BY ${order} LIMIT $5 OFFSET $6`,
   [...terms,filters.pageSize,(filters.page-1)*filters.pageSize],
 );
 const periodMap=(r:Record<string,unknown>,metric:string)=>({
   oneMonth:String(r[metric+"OneMonth"]),
   fourMonths:String(r[metric+"FourMonths"]),
   twelveMonths:String(r[metric+"TwelveMonths"]),
   allTime:String(r[metric+"AllTime"]),
 });
 return {
  companyId,asOf,page:filters.page,pageSize:filters.pageSize,total:Number(count),
  rows:data.rows.map(r=>({
    itemId:r.id,code:r.code,name:r.name,active:r.active,
    unitName:r.factor3>1?r.unit3_name:r.factor2>1?r.unit2_name:r.unit1_name,
    sale:periodMap(r,"sale"),purchase:periodMap(r,"purchase"),
    saleReturn:periodMap(r,"saleReturn"),purchaseReturn:periodMap(r,"purchaseReturn"),
  })),
 };
}
