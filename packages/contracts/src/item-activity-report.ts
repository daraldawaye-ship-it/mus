/** All quantities are exact counts in each item's own smallest unit; never sum across items. */
export type ItemActivityReportPeriod="oneMonth"|"fourMonths"|"twelveMonths"|"allTime";
export type ItemActivityReportMetric="saleTimes"|"sale"|"purchase"|"saleReturn"|"purchaseReturn";
export type ItemActivityReportSort="code"|"name"|
 "saleOneMonth"|"saleFourMonths"|"saleTwelveMonths"|"saleAllTime"|
 "purchaseOneMonth"|"purchaseFourMonths"|"purchaseTwelveMonths"|"purchaseAllTime"|
 "saleReturnOneMonth"|"saleReturnFourMonths"|"saleReturnTwelveMonths"|"saleReturnAllTime"|
 "purchaseReturnOneMonth"|"purchaseReturnFourMonths"|"purchaseReturnTwelveMonths"|"purchaseReturnAllTime"|
 "saleTimesOneMonth"|"saleTimesFourMonths"|"saleTimesTwelveMonths"|"saleTimesAllTime";
export interface ItemActivityReportRow {
 itemId:number;
 code:string;
 name:string;
 active:boolean;
 unitName:string;
 unit1Name:string;
 /** Current company-wide stock, expressed exactly in the first unit; null without inventory viewing permission. */
 stockUnit1:{numerator:string;denominator:string;decimal:string|null}|null;
 saleTimes:Record<ItemActivityReportPeriod,string>;
 sale:Record<ItemActivityReportPeriod,string>;
 purchase:Record<ItemActivityReportPeriod,string>;
 saleReturn:Record<ItemActivityReportPeriod,string>;
 purchaseReturn:Record<ItemActivityReportPeriod,string>;
}
export interface ItemActivityReport {
 companyId:number;
 asOf:string;
 page:number;
 pageSize:number;
 total:number;
 rows:ItemActivityReportRow[];
}
