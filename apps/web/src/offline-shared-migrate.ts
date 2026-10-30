import { readSharedItemProgress, saveSharedItemBatch } from "./offline-shared-items";
// Upgrade a completed, authorized user's old device catalog locally instead of
// downloading every item again after enabling per-company sharing.
type OldProgress={complete:boolean;count:number;cursor:{since:string;afterId:number}};
type OldCard={value:Record<string,unknown>};
export async function migrateExistingCatalog(userId:number,companyId:number) {
  if(await readSharedItemProgress(userId,companyId)) return;
  const database=await new Promise<IDBDatabase>((resolve,reject)=>{
    const req=indexedDB.open("alraesy-device-v1",3);
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });
  try {
    if(!database.objectStoreNames.contains("catalog-download")||
       !database.objectStoreNames.contains("catalog")) return;
    const progress=await new Promise<OldProgress|undefined>((resolve,reject)=>{
      const request=database.transaction("catalog-download","readonly")
        .objectStore("catalog-download").get(userId+":"+companyId);
      request.onsuccess=()=>resolve(request.result as OldProgress|undefined);
      request.onerror=()=>reject(request.error);
    });
    if(!progress?.complete||!Number.isSafeInteger(progress.count)) return;
    const cards=await new Promise<OldCard[]>((resolve,reject)=>{
      const request=database.transaction("catalog","readonly")
        .objectStore("catalog").index("scope").getAll([userId,companyId,"items"]);
      request.onsuccess=()=>resolve(request.result as OldCard[]);
      request.onerror=()=>reject(request.error);
    });
    if(!cards.length||cards.length<progress.count) return;
    for(let i=0;i<cards.length;i+=500) {
      const last=i+500>=cards.length;
      await saveSharedItemBatch(userId,companyId,
        cards.slice(i,i+500).map(card=>{
          const {availableSmallest,approximateCoverageDays,coverageAfterReserveDays,...base}=card.value;
          return base;
        }),
        {cursor:progress.cursor,count:last?progress.count:i+500,complete:last});
    }
  } finally { database.close(); }
}
