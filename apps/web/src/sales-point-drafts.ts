/** Device-only, non-posted sales point snapshots. Never enters the offline posting outbox.
 * Keep user/company boundaries explicit: another employee on a shared PWA sees only their points.
 */
export type SalesPointDraft<Form> = {
  id: string;
  userId: number;
  companyId: number;
  createdAt: string;
  updatedAt: string;
  form: Form;
};
const DB_NAME = "alraesy-sales-points-v1";
let opening: Promise<IDBDatabase> | undefined;
let writes: Promise<void> = Promise.resolve();
const key = (userId: number, companyId: number, id: string) =>
  `${userId}:${companyId}:${id}`;

function database(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined")
    return Promise.reject(new Error("هذا المتصفح لا يدعم حفظ فواتير المبيعات محليًا."));
  if (!opening) opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore("points", {keyPath: "key"});
      store.createIndex("owner", ["userId", "companyId"]);
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => {
        request.result.close();
        opening = undefined;
      };
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("إغلاق نافذة قديمة مطلوب لفتح قاعدة مسودات المبيعات."));
  }).catch(error => {opening = undefined; throw error;});
  return opening;
}
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const next = writes.then(task);
  writes = next.then(() => {}, () => {});
  return next;
}
async function inStore<T>(
  mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await database();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction("points", mode);
    const request = action(tx.objectStore("points"));
    let result: T;
    request.onsuccess = () => { result = request.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error ?? new Error("تعذر حفظ فاتورة المبيعات على الجهاز."));
    tx.onabort = () => reject(tx.error ?? new Error("تعذر إتمام حفظ فاتورة المبيعات على الجهاز."));
  });
}
type Row<Form> = SalesPointDraft<Form> & {key: string};

export async function listSalesPointDrafts<Form>(userId: number, companyId: number):
  Promise<SalesPointDraft<Form>[]> {
  await writes;
  const rows = await inStore<Row<Form>[]>("readonly", store =>
    store.index("owner").getAll([userId, companyId]));
  return rows.filter(row => row.userId === userId && row.companyId === companyId)
    .sort((a,b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .slice(0, 10);
}
export function saveSalesPointDraft<Form>(
  userId: number, companyId: number, id: string, createdAt: string, form: Form,
): Promise<void> {
  const row = {key: key(userId,companyId,id), id, userId, companyId, createdAt,
    updatedAt: new Date().toISOString(), form};
  return enqueue(async () => {
    await inStore("readwrite", store => store.put(row));
  });
}
export function deleteSalesPointDraft(userId: number, companyId: number, id: string): Promise<void> {
  return enqueue(async () => {
    await inStore("readwrite", store => store.delete(key(userId,companyId,id)));
  });
}
export async function flushSalesPointDrafts(): Promise<void> {
  await writes;
}
