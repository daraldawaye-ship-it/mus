import { sharedItemsAllowed, sharedItemsLiveAllowed } from "./offline-shared";
import { isOfflineNow } from "./connection-mode";
import { compareItemsBySavedSales, compareItemsBySaleQuantityAndStock, readSaleRankSnapshot } from "./offline-storage";
type Cursor = { since:string;afterId:number };
type Progress = { cursor:Cursor;count:number;complete:boolean };
type Row = { key:string;companyId:number;value:Record<string,unknown> };
type Prepared = { asOfDate:string; ordered: { card:Record<string,unknown>; text:string; code:string; barcode:string }[] };
const invoiceIndexes=new Map<string,Promise<Prepared|null>>();
const invoiceIndexKey=(userId:number,companyId:number)=>userId+":"+companyId;
function invalidateInvoiceIndex(userId:number,companyId:number) {
  invoiceIndexes.delete(invoiceIndexKey(userId,companyId));
}
const normalized=(value:unknown)=>String(value??"").normalize("NFKC").toLocaleLowerCase().trim();
const invoiceSearchFields=["name","englishName","compositionArabicName",
  "compositionEnglishName","searchKeys","code","barcode","shortcut"] as const;
function adenDate():string {
  const parts=new Intl.DateTimeFormat("en-GB",{
    timeZone:"Asia/Aden",year:"numeric",month:"2-digit",day:"2-digit",
  }).formatToParts(new Date());
  const get=(key:"year"|"month"|"day")=>parts.find(p=>p.type===key)?.value??"";
  return get("year")+"-"+get("month")+"-"+get("day");
}
/** Cold load runs once per user/company and only after a complete authorized
 * card download and user-specific stored ranking. Sorting occurs ONLY here.
 * Each subsequent keystroke scans already ordered normalized strings, stopping
 * after pageSize+1 matches, with no IDB fetch or sales/stock calculations. */
async function prepareInvoiceIndex(userId:number,companyId:number):Promise<Prepared|null> {
  if(!sharedItemsAllowed(companyId,userId))return null;
  const progress=await readSharedItemProgress(userId,companyId);
  if(!progress?.complete || !progress.count)return null;
  const ranking=await readSaleRankSnapshot(userId,companyId);
  if(!ranking?.priorities || !Object.keys(ranking.priorities).length)return null;
  const data=await withDb(db=>new Promise<Row[]>((resolve,reject)=>{
    const req=db.transaction("itemCards","readonly").objectStore("itemCards")
      .index("company").getAll(companyId);
    req.onsuccess=()=>resolve(req.result as Row[]);
    req.onerror=()=>reject(req.error);
  }));
  if(!sharedItemsAllowed(companyId,userId))return null;
  const ordered=data.map(({value})=>{
    const itemId=String(value.id);
    const stock=ranking.stocks?.[itemId];
    const card={...value,
      availableSmallest:typeof stock==="string" ? stock : null,
    };
    return {
      card,
      text:invoiceSearchFields.map(key=>normalized(value[key])).join("\u0001"),
      code:normalized(value.code),
      barcode:normalized(value.barcode),
    };
  });
  // The rank is already materialized on the server; the only local work is
  // sorting this downloaded snapshot once, not on each input change.
  ordered.sort((a,b)=>compareItemsBySaleQuantityAndStock(
    a.card,b.card,ranking.priorities!,
  ));
  return {asOfDate:ranking.asOfDate,ordered};
}
function loadInvoiceIndex(userId:number,companyId:number):Promise<Prepared|null> {
  const key=invoiceIndexKey(userId,companyId);
  let stored=invoiceIndexes.get(key);
  if(!stored){
    stored=prepareInvoiceIndex(userId,companyId).catch(()=>null);
    invoiceIndexes.set(key,stored);
    void stored.then(result=>{if(!result && invoiceIndexes.get(key)===stored)invoiceIndexes.delete(key);});
  }
  return stored;
}
/** Safe online local reads require a fresh successful permission-checked GET
 * in this login and a ranking snapshot from the current Aden day. During an
 * outage the last complete authorized snapshot is allowed (as before). */
export async function fastLocalInvoiceItems<T>(
  path:string,userId:number,
):Promise<T|undefined> {
  const match=path.match(/^\/companies\/(\d+)\/commerce-options\?/);
  if(!match)return undefined;
  const companyId=Number(match[1]);
  const q=new URLSearchParams(path.split("?")[1]);
  if(q.get("type")!=="items" || q.get("fast")!=="1" ||
      !q.get("sort")?.startsWith("saleQuantityPlusStock:desc") ||
      !normalized(q.get("q")) || normalized(q.get("q")).length<3 ||
      !sharedItemsAllowed(companyId,userId))return undefined;
  if(!isOfflineNow() && !sharedItemsLiveAllowed(companyId,userId))return undefined;
  const index=await loadInvoiceIndex(userId,companyId);
  if(!index || (!isOfflineNow() && index.asOfDate!==adenDate()) ||
      !sharedItemsAllowed(companyId,userId))return undefined;
  const term=normalized(q.get("q"));
  const page=Math.max(1,Number(q.get("page"))||1);
  const pageSize=Math.min(100,Math.max(1,Number(q.get("pageSize"))||20));
  const needed=page*pageSize+1;
  const matches:Record<string,unknown>[]=[];
  // Exact code/barcode must precede the materialized popularity order.
  for(const item of index.ordered){
    if(item.code===term || item.barcode===term)matches.push(item.card);
  }
  const exactCount=matches.length;
  if(exactCount<needed)for(const item of index.ordered){
    if(item.code===term || item.barcode===term)continue;
    if(item.text.includes(term)){
      matches.push(item.card);
      if(matches.length>=needed)break;
    }
  }
  const offset=(page-1)*pageSize;
  const hasMore=matches.length>page*pageSize;
  return {items:matches.slice(offset,offset+pageSize),
    total:hasMore ? page*pageSize+1 : matches.length,
    page,pageSize,hasMore} as T;
}
/** Start one background index load; no UI blocks waiting for it. */
export function warmLocalInvoiceItems(userId:number,companyId:number):void {
  if(sharedItemsAllowed(companyId,userId))void loadInvoiceIndex(userId,companyId);
}
const filename="alraesy-shared-references-v1";
async function withDb<T>(fn:(db:IDBDatabase)=>Promise<T>) {
  const db=await new Promise<IDBDatabase>((resolve,reject)=>{
    const request=indexedDB.open(filename,2);
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
  });
  try { return await fn(db); } finally { db.close(); }
}
export async function readSharedItemProgress(userId:number,companyId:number):Promise<Progress|null> {
  if (!sharedItemsAllowed(companyId,userId)) return null;
  return withDb(db=>new Promise((resolve,reject)=>{
    const req=db.transaction("entries","readonly").objectStore("entries").get("items:"+companyId);
    req.onsuccess=()=>resolve((req.result?.data as Progress|undefined)??null);
    req.onerror=()=>reject(req.error);
  }));
}
export async function saveSharedItemBatch(
  userId:number,companyId:number,values:Record<string,unknown>[],progress:Progress,
) {
  if (!sharedItemsAllowed(companyId,userId)) throw new Error("صلاحية الأصناف غير مؤكدة");
  await withDb(db=>new Promise<void>((resolve,reject)=>{
    const tx=db.transaction(["entries","itemCards"],"readwrite");
    for (const item of values) {
      if (typeof item.id!=="number") continue;
      tx.objectStore("itemCards").put({
        key:companyId+":"+item.id,companyId,value:item,
      } satisfies Row);
    }
    tx.objectStore("entries").put({key:"items:"+companyId,data:progress});
    tx.oncomplete=()=>{
      invalidateInvoiceIndex(userId,companyId);
      resolve();
    };
    tx.onerror=()=>reject(tx.error);
    tx.onabort=()=>reject(tx.error);
  }));
}
export async function lookupSharedItem<T>(path:string,userId:number):Promise<T|undefined> {
  const card=path.match(/^\/companies\/(\d+)\/items\/(\d+)$/);
  const opts=path.match(/^\/companies\/(\d+)\/commerce-options\?/);
  const companyId=Number((card??opts)?.[1]??0);
  if (!companyId || !sharedItemsAllowed(companyId,userId)) return undefined;
  if (opts && new URLSearchParams(path.split("?")[1]).get("type")!=="items") return undefined;
  const data=await withDb(db=>new Promise<Row[]>((resolve,reject)=>{
    const req=card
      ?db.transaction("itemCards","readonly").objectStore("itemCards").get(companyId+":"+card[2])
      :db.transaction("itemCards","readonly").objectStore("itemCards").index("company").getAll(companyId);
    req.onsuccess=()=>resolve(card?(req.result?[req.result as Row]:[]):req.result as Row[]);
    req.onerror=()=>reject(req.error);
  }));
  if (card) return data.length?{item:data[0].value} as T:undefined;
  if (!opts) return undefined;
  const q=new URLSearchParams(path.split("?")[1]);
  const search=(q.get("q")??"").trim().toLowerCase();
  const filtered=data.map(x=>x.value).filter(x=>
    (!q.get("id")||String(x.id)===q.get("id")) &&
    (!q.get("shortcut")||String(x.shortcut??"").toUpperCase()===q.get("shortcut")!.toUpperCase()) &&
    (q.get("active")!=="true"||x.active!==false) &&
    (!search||["name","englishName","code","barcode","searchKeys"].some(k=>
      String(x[k]??"").toLowerCase().includes(search))));
  if(q.get("sort")?.startsWith("saleQuantityPlusStock:desc")){
    const snapshot=await readSaleRankSnapshot(userId,companyId);
    if(snapshot?.priorities)
      filtered.sort((a,b)=>compareItemsBySaleQuantityAndStock(a,b,snapshot.priorities!,q.get("q")??""));
  } else if(q.get("sort")?.startsWith("saleTimes:desc")){
    const snapshot=await readSaleRankSnapshot(userId,companyId);
    if(snapshot)
      filtered.sort((a,b)=>compareItemsBySavedSales(a,b,snapshot.scores,q.get("q")??""));
  }
  const page=Math.max(1,Number(q.get("page"))||1);
  const pageSize=Math.min(100,Math.max(1,Number(q.get("pageSize"))||20));
  return {items:filtered.slice((page-1)*pageSize,page*pageSize),
    total:filtered.length,page,pageSize} as T;
}

export async function refreshSharedItemCards(
  userId:number,companyId:number,items:Record<string,unknown>[],
) {
  if (!items.length) return;
  const state=await readSharedItemProgress(userId,companyId);
  if (state) await saveSharedItemBatch(userId,companyId,items,state);
}
