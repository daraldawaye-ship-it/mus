// Device-local shared reference cache. Read access is granted only after
// this signed-in user has successfully read the corresponding live endpoint.
const dbName = "alraesy-shared-references-v1";
let identity: number | null = null;
const grants = new Set<string>();
export function sharedIdentity(userId: number | null) {
  identity = userId;
  grants.clear();
}
const offlineGrantMaxAge = 7 * 24 * 60 * 60 * 1000;
type OfflineGrant = { userId:number;group:string;savedAt:number };
/** The grant is the last successful server-authorized GET for this exact
 * user and module. It is not used to authorize online mutations. */
export async function restoreOfflineSharedGrants(userId:number):Promise<void> {
  if (identity!==userId) return;
  const database=await db();
  try {
    const all=await new Promise<Entry[]>((resolve,reject)=>{
      const req=database.transaction("entries","readonly").objectStore("entries").getAll();
      req.onsuccess=()=>resolve(req.result as Entry[]);
      req.onerror=()=>reject(req.error);
    });
    if (identity!==userId) return;
    for(const entry of all) {
      if (!entry.key.startsWith("grant:"+userId+":")) continue;
      const grant=entry.data as OfflineGrant;
      if(grant?.userId!==userId || typeof grant.group!=="string" ||
         !Number.isFinite(grant.savedAt) || Date.now()<grant.savedAt ||
         Date.now()-grant.savedAt>offlineGrantMaxAge) continue;
      grants.add(userId+":"+grant.group);
    }
  } finally { database.close(); }
}
export async function clearOfflineSharedGrants(userId:number):Promise<void> {
  const database=await db();
  try {
    await new Promise<void>((resolve,reject)=>{
      const tx=database.transaction("entries","readwrite");
      const request=tx.objectStore("entries").getAllKeys();
      request.onsuccess=()=>{
        for(const key of request.result) {
          if(typeof key==="string" && key.startsWith("grant:"+userId+":"))
            tx.objectStore("entries").delete(key);
        }
      };
      tx.oncomplete=()=>resolve();
      tx.onerror=()=>reject(tx.error);
    });
  } finally { database.close(); }
}
export function sharedItemsAllowed(companyId:number,userId:number):boolean {
  return identity===userId && grants.has(userId+":"+companyId+":options:items");
}
function scope(path: string): string | null {
  const match = path.match(/^\/companies\/(\d+)\/(item-compositions|item-shelves|doctors|sale-customers|branches|locations|accounts)(?:[/?]|$)/);
  if (match) return match[1] + ":" + match[2];
  const opt = path.match(/^\/companies\/(\d+)\/commerce-options\?/);
  const delta = path.match(/^\/companies\/(\d+)\/item-changes(?:\?|$)/);
  if (delta) return delta[1] + ":options:items";
  if (opt) {
    const type = new URLSearchParams(path.split("?")[1]).get("type");
    if (type && ["items","accounts","branches","locations","currencies"].includes(type))
      return opt[1] + ":options:" + type;
  }
  const q = path.match(/^\/(?:companies\/(\d+)\/)?questions(?:[/?]|$)/);
  if (q) return (q[1] || "public") + ":questions";
  return null;
}
export function sanitizeSharedReference(path: string, value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const list = value as { items?: Record<string, unknown>[] };
  if (!Array.isArray(list.items)) return value;
  if (/\/questions(?:\?|$)/.test(path))
    return { ...list, items: list.items.map(item => ({
      id:item.id, companyId:item.companyId, category:item.category,
      question:item.question, options:item.options, optionCount:item.optionCount,
      priority:item.priority, points:item.points, active:item.active,
    })) };
  if (/\/accounts(?:\?|$)/.test(path) || /type=accounts(?:&|$)/.test(path))
    return { ...list, items: list.items.map(item => ({
      id:item.id, companyId:item.companyId, code:item.code, name:item.name,
      parentId:item.parentId, kind:item.kind, category:item.category,
      active:item.active, accountChoice:item.accountChoice,
    })) };
  if (/type=items(?:&|$)/.test(path))
    return { ...list, items: list.items.map(item => {
      const { availableSmallest, approximateCoverageDays, coverageAfterReserveDays, ...card } = item;
      return card;
    }) };
  return value;
}
type Entry = { key:string; data:unknown };
async function db(): Promise<IDBDatabase> {
  return new Promise((resolve,reject) => {
    const r = indexedDB.open(dbName, 2);
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains("entries"))
        r.result.createObjectStore("entries", { keyPath: "key" });
      if (!r.result.objectStoreNames.contains("itemCards")) {
        const cards=r.result.createObjectStore("itemCards", { keyPath: "key" });
        cards.createIndex("company","companyId");
      }
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function write(key:string,data:unknown) {
  const database=await db();
  try {
    await new Promise<void>((resolve,reject)=>{
      const tx=database.transaction("entries","readwrite");
      tx.objectStore("entries").put({key,data} satisfies Entry);
      tx.oncomplete=()=>resolve();
      tx.onerror=()=>reject(tx.error);
      tx.onabort=()=>reject(tx.error);
    });
  } finally { database.close(); }
}
async function read(key:string): Promise<unknown> {
  const database=await db();
  try {
    return await new Promise((resolve,reject)=>{
      const req=database.transaction("entries","readonly").objectStore("entries").get(key);
      req.onsuccess=()=>resolve((req.result as Entry|undefined)?.data);
      req.onerror=()=>reject(req.error);
    });
  } finally { database.close(); }
}
export async function shareAuthorizedRead(path:string,data:unknown):Promise<void> {
  // Answer keys downloaded for offline grading are private to one user.
  if (/^\/(?:companies\/\d+\/)?questions\/offline-pack(?:\?|$)/.test(path)) return;
  const group=scope(path);
  if (identity===null || !group) return;
  const current=identity;
  const sanitized=sanitizeSharedReference(path,data);
  const serialized=JSON.stringify(sanitized);
  if (!serialized || serialized.length>800_000) return;
  if (current!==identity) return;
  // A successful live GET is the authorization proof for this session.
  if (!grants.has(current+":"+group)) {
    grants.add(current+":"+group);
    await write("grant:"+current+":"+group,{
      userId:current,group,savedAt:Date.now(),
    } satisfies OfflineGrant);
  }
  await write("snapshot:"+path,sanitized);
}
export async function reuseAuthorizedRead<T>(path:string):Promise<T|undefined> {
  const group=scope(path);
  if (identity===null || !group || !grants.has(identity+":"+group)) return undefined;
  return await read("snapshot:"+path) as T|undefined;
}

// Search downloaded doctor/entity cards by the actual catalog, not by a URL
// containing an exact online query that was never requested on this device.
// Keep the current user's explicit server-granted module access mandatory.
export async function lookupDownloadedDoctors<T>(path:string,userId:number):Promise<T|undefined> {
  const match=path.match(/^\/companies\/(\d+)\/doctors\?(.*)$/);
  if(!match || identity!==userId) return undefined;
  const companyId=Number(match[1]);
  if(!grants.has(userId+":"+companyId+":doctors")) return undefined;
  const params=new URLSearchParams(match[2]);
  const search=(params.get("q")??"").trim().toLocaleLowerCase();
  const page=Math.max(1,Number(params.get("page"))||1);
  const pageSize=Math.min(100,Math.max(1,Number(params.get("pageSize"))||20));
  const prefix="snapshot:/companies/"+companyId+"/doctors?";
  const database=await db();
  let snapshots:Entry[];
  try {
    snapshots=await new Promise((resolve,reject)=>{
      const range=IDBKeyRange.bound(prefix,prefix+"\uffff");
      const request=database.transaction("entries","readonly").objectStore("entries").getAll(range);
      request.onsuccess=()=>resolve(request.result as Entry[]);
      request.onerror=()=>reject(request.error);
    });
  } finally { database.close(); }
  if(identity!==userId || !grants.has(userId+":"+companyId+":doctors")) return undefined;
  const byId=new Map<number,Record<string,unknown>>();
  for(const entry of snapshots) {
    const query=new URLSearchParams(entry.key.slice(prefix.length));
    // Only unfiltered downloaded pages comprise the reliable local directory.
    if(query.get("q") || query.get("pageSize")!=="100") continue;
    const rows=(entry.data as {items?:Record<string,unknown>[]}|null)?.items;
    if(!Array.isArray(rows)) continue;
    for(const row of rows) {
      if(typeof row.id==="number" && row.id>0) byId.set(row.id,row);
    }
  }
  if(!snapshots.length || !byId.size) return undefined;
  const activeOnly=params.get("active")==="true";
  const matches=Array.from(byId.values()).filter(doctor=>
    (!activeOnly || doctor.active!==false) &&
    (!search || ["name","department","searchKeys","phone"].some(k=>
      String(doctor[k]??"").toLocaleLowerCase().includes(search))));
  matches.sort((a,b)=>String(a.name??"").localeCompare(String(b.name??""),"ar"));
  return {items:matches.slice((page-1)*pageSize,page*pageSize),
    total:matches.length,page,pageSize} as T;
}

export type SharedReferenceProgress = {page:number;complete:boolean;refreshedAt?:number};
/** A completed reference catalog needs a bounded full refresh at least once per day. */
export function sharedReferenceRefreshDue(
  progress:SharedReferenceProgress|null,now=Date.now(),
):boolean {
  const last=progress?.refreshedAt;
  return !progress?.complete || typeof last!=="number" ||
    !Number.isFinite(last) || last>now || now-last>=24*60*60*1000;
}
export async function sharedProgress(
  companyId:number,group:string,userId:number,
):Promise<SharedReferenceProgress|null> {
  if (identity!==userId || !grants.has(userId+":"+(companyId===0?"public":companyId)+":"+group)) return null;
  return (await read("progress:"+companyId+":"+group) as SharedReferenceProgress|undefined)??null;
}
export async function saveSharedProgress(
  companyId:number,group:string,userId:number,page:number,complete:boolean,
) {
  if (identity!==userId || !grants.has(userId+":"+(companyId===0?"public":companyId)+":"+group)) return;
  await write("progress:"+companyId+":"+group,{page,complete,refreshedAt:complete?Date.now():undefined});
}
