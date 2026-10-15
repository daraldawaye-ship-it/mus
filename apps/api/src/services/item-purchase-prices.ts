import type { PoolClient } from "pg";
import type { ItemPurchasePricePoint, ItemPurchasePriceStatistics, User } from "../../../../packages/contracts/src/index.ts";
import { directoryEntries } from "./pages.ts";
import { missing } from "../errors.ts";

function decimalText(value: string): string {
 return value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value;
}

/** Read at most six months of daily extrema; never scan invoice history on card render. */
export async function readItemPurchasePrices(
 client: PoolClient,user: User,companyId: number,itemId: number,
): Promise<ItemPurchasePriceStatistics> {
 const item=(await client.query(
   "SELECT unit1_name,unit2_name,unit3_name,factor2,factor3 FROM items WHERE company_id=$1 AND id=$2",
   [companyId,itemId],
 )).rows[0];
 if(!item) missing();
 const pages=await directoryEntries(client,user,companyId);
 const permitted=(key:string)=>!!pages.find(p=>p.key===key)?.actionAccess.view;
 const canViewPrices=permitted("company.purchases")&&permitted("company.invoice");
 const dates=(await client.query(`WITH today AS (
    SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Aden')::date AS d
   ) SELECT d::text AS as_of,(d-interval '6 months'+interval '1 day')::date::text AS from_day FROM today`)).rows[0];
 const base=(await client.query(
   `SELECT f.base_currency_id,c.code FROM finance_settings f
    JOIN company_currencies c ON c.company_id=f.company_id AND c.id=f.base_currency_id
    WHERE f.company_id=$1`,[companyId],
 )).rows[0] as {base_currency_id:number;code:string}|undefined;
 const smallestUnitName:string=item.factor3>1?item.unit3_name:item.factor2>1?item.unit2_name:item.unit1_name;
 const result:ItemPurchasePriceStatistics={
  companyId,itemId,asOf:dates.as_of,from:dates.from_day,
  baseCurrencyCode:base?.code??null,smallestUnitName,canViewPrices,
  hasOtherBaseCurrencyHistory:false,minimum:null,maximum:null,latest:null,
  latestAboveMinimumPercent:null,
 };
 if(!canViewPrices||!base)return result;
 const getPoint=async (metric:"minimum"|"maximum"|"latest"):Promise<ItemPurchasePricePoint|null>=>{
  const line=metric==="minimum"?"min_line_id":metric==="maximum"?"max_line_id":"latest_line_id";
  const order=metric==="minimum"?"d.min_price ASC,d.document_date DESC,d.min_line_id DESC":
   metric==="maximum"?"d.max_price DESC,d.document_date DESC,d.max_line_id DESC":
   "d.document_date DESC,d.latest_line_id DESC";
  const rows=await client.query(
   `SELECT f.invoice_id,f.invoice_line_id,f.invoice_number,
      f.document_date::text AS document_date,
      f.original_unit_price::text AS original_unit_price,
      f.original_unit_name,f.original_currency_code,
      f.base_price_smallest::text AS base_price_smallest,
      f.supplier_account_id,f.supplier_account_name
    FROM item_purchase_price_daily d
    JOIN item_purchase_price_facts f ON f.company_id=d.company_id AND f.invoice_line_id=d.${line}
    WHERE d.company_id=$1 AND d.item_id=$2 AND d.base_currency_id=$3
      AND d.document_date BETWEEN $4::date AND $5::date
    ORDER BY ${order} LIMIT 1`,
   [companyId,itemId,base.base_currency_id,dates.from_day,dates.as_of]
  );
  const r=rows.rows[0];
  return r?{
   invoiceId:r.invoice_id,invoiceLineId:r.invoice_line_id,invoiceNumber:r.invoice_number,
   documentDate:r.document_date,originalUnitPrice:decimalText(r.original_unit_price),
   originalUnitName:r.original_unit_name,originalCurrencyCode:r.original_currency_code,
   priceBaseSmallest:decimalText(r.base_price_smallest),
   supplierAccountId:r.supplier_account_id,supplierAccountName:r.supplier_account_name,
  }:null;
 };
 result.minimum=await getPoint("minimum");
 result.maximum=await getPoint("maximum");
 result.latest=await getPoint("latest");
 const excluded=await client.query(
  `SELECT EXISTS(SELECT 1 FROM item_purchase_price_daily
    WHERE company_id=$1 AND item_id=$2 AND base_currency_id<>$3
      AND document_date BETWEEN $4::date AND $5::date) AS found`,
  [companyId,itemId,base.base_currency_id,dates.from_day,dates.as_of]
 );
 result.hasOtherBaseCurrencyHistory=excluded.rows[0]?.found===true;
 if(result.minimum&&result.latest&&result.minimum.priceBaseSmallest!=="0"){
  const change=await client.query(
   "SELECT trim_scale(round(($1::numeric-$2::numeric)*100/$2::numeric,2))::text AS percent",
   [result.latest.priceBaseSmallest,result.minimum.priceBaseSmallest]
  );
  result.latestAboveMinimumPercent=change.rows[0]?.percent??null;
 }
 return result;
}
