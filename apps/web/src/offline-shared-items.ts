import { sharedItemsAllowed } from "./offline-shared";
import { compareItemsBySavedSales, compareItemsBySaleQuantityAndStock, readSaleRankSnapshot } from "./offline-storage";
type Cursor = { since:string;afterId:number };
type Progress = { cursor:Cursor;count:number;complete:boolean };
type Row = { key:string;companyId:number;value:Record<string,unknown> };
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
    tx.oncomplete=()=>resolve();
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
