import { api } from "./api";
import { readSaleRankSnapshot, saveSaleRankSnapshot } from "./offline-storage";

type RankingBatch={
  asOfDate:string;
  items:{itemId:number;saleTimes:string}[];
  hasMore:boolean;
  afterId:number;
};
const syncing=new Set<string>();

/** Once per Aden calendar day, fetch the already-materialized monthly
 * sale occurrences. Six bounded pages per background pass, with a durable
 * cursor. Sales ranks are never added to shared item cards because users
 * with items-only access must not see private sales statistics.
 */
function adenDay():string {
  const parts=new Intl.DateTimeFormat("en-GB",{
    timeZone:"Asia/Aden",year:"numeric",month:"2-digit",day:"2-digit",
  }).formatToParts(new Date());
  const get=(part:"year"|"month"|"day")=>parts.find(p=>p.type===part)?.value??"";
  return get("year")+"-"+get("month")+"-"+get("day");
}
export async function refreshDailySaleRanks(userId:number,companyId:number):Promise<void> {
  if(!userId||!companyId||!navigator.onLine||document.visibilityState==="hidden")return;
  const key=userId+":"+companyId;
  if(syncing.has(key))return;
  syncing.add(key);
  try {
    const day=adenDay();
    const complete=await readSaleRankSnapshot(userId,companyId);
    if(complete?.asOfDate===day)return;
    const previous=await readSaleRankSnapshot(userId,companyId,"progress");
    const current=previous?.asOfDate===day
      ?previous:{asOfDate:day,afterId:0,scores:{} as Record<string,string>};
    for(let i=0;i<6 && navigator.onLine && document.visibilityState!=="hidden";i++){
      const page=await api<RankingBatch>(
        "/companies/"+companyId+"/item-sale-ranks?afterId="+current.afterId,
      );
      if(page.asOfDate!==day)return;
      for(const rank of page.items){
        if(Number.isSafeInteger(rank.itemId)&&rank.itemId>0 &&
          /^-?\d+$/.test(rank.saleTimes))
          current.scores[String(rank.itemId)]=rank.saleTimes;
      }
      if(!page.hasMore){
        await saveSaleRankSnapshot(userId,companyId,"complete",{
          asOfDate:day,afterId:0,scores:current.scores,
        });
        return;
      }
      if(page.afterId<=current.afterId)throw Error("توقف مؤشر ترتيب المبيعات");
      current.afterId=page.afterId;
      await saveSaleRankSnapshot(userId,companyId,"progress",current);
    }
  } catch {
    // Rank metadata is optional. A permission denial or outage must never
    // block normal sales or overwrite the last complete authorized snapshot.
  } finally { syncing.delete(key); }
}
