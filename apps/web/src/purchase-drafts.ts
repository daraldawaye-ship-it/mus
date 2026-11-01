/**
 * Multiple, device-local purchase work drafts, separated by user and company.
 * They are NOT staged/postable invoices; never enqueue them for sync and
 * never touch stock, ledgers or invoice numbers.
 */
export type PurchaseWorkDraft<T> = {
  id: string;
  userId: number;
  companyId: number;
  savedAt: string;
  itemCount: number;
  title: string;
  form: T;
};
const DB = "alraesy-purchase-work-drafts-v1";
let connection: Promise<IDBDatabase> | undefined;
function openDrafts(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("التخزين المحلي غير متاح في هذا الجهاز."));
  if (!connection) connection = new Promise<IDBDatabase>((resolve,reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => {
      const store=request.result.createObjectStore("drafts", { keyPath: "id" });
      store.createIndex("owner", ["userId","companyId"]);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }).catch(error => { connection=undefined; throw error; });
  return connection;
}
function query<T>(mode: IDBTransactionMode, action:(store:IDBObjectStore)=>IDBRequest<T>):Promise<T> {
  return openDrafts().then(db => new Promise<T>((resolve,reject)=>{
    const tx=db.transaction("drafts",mode);
    const request=action(tx.objectStore("drafts"));
    let result:T;
    request.onsuccess=()=>{result=request.result;};
    tx.oncomplete=()=>resolve(result);
    tx.onerror=()=>reject(tx.error ?? new Error("تعذر حفظ المسودة."));
    tx.onabort=()=>reject(tx.error ?? new Error("تعذر إتمام العملية على المسودة."));
  }));
}
export async function listPurchaseWorkDrafts<T>(userId:number,companyId:number):Promise<PurchaseWorkDraft<T>[]> {
  const list=await query<PurchaseWorkDraft<T>[]>("readonly",store=>
    store.index("owner").getAll([userId,companyId]));
  return list.sort((a,b)=>b.savedAt.localeCompare(a.savedAt));
}
export async function savePurchaseWorkDraft<T>(
  userId:number,companyId:number,form:T,itemCount:number,title:string,id?:string,
):Promise<PurchaseWorkDraft<T>>{
  const draft={id:id??crypto.randomUUID(),userId,companyId,
    savedAt:new Date().toISOString(),itemCount,title,form};
  await query("readwrite",store=>store.put(draft));
  return draft;
}
export async function deletePurchaseWorkDraft(userId:number,companyId:number,id:string):Promise<void>{
  // Never delete another user's/company's draft even if an ID leaks.
  const rows=await listPurchaseWorkDrafts<unknown>(userId,companyId);
  if (!rows.some(row=>row.id===id)) throw new Error("المسودة غير موجودة لهذا المستخدم أو الشركة.");
  await query("readwrite",store=>store.delete(id));
}
