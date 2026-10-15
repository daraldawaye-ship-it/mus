/** All quantities are exact counts in each item's own smallest unit; never sum across items. */
export type ItemActivityReportPeriod="oneMonth"|"fourMonths"|"twelveMonths"|"allTime";
export type ItemActivityReportMetric="sale"|"purchase"|"saleReturn"|"purchaseReturn";
export type ItemActivityReportSort="code"|"name"|
 "saleOneMonth"|"saleFourMonths"|"saleTwelveMonths"|"saleAllTime"|
 "purchaseOneMonth"|"purchaseFourMonths"|"purchaseTwelveMonths"|"purchaseAllTime";
export interface ItemActivityReportRow {
 itemId:number;
 code:string;
 name:string;
 active:boolean;
 unitName:string;
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
