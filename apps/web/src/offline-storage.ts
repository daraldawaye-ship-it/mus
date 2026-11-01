/**
 * Device-local read snapshots and a durable, user-scoped outbox.
 * This is not a second authoritative accounting database. Only the server
 * posts documents and awards question points.
 */
export type OfflineKind = "invoice" | "voucher" | "answer" | "cashbox";
export type OfflinePending = {
  id: string;
  userId: number;
  companyId: number | null;
  kind: OfflineKind;
  path: string;
  body: unknown;
  createdAt: string;
  failure: string | null;
};
type Snapshot = { key: string; userId: number; path: string; value: unknown; savedAt: string };
type CatalogEntry = { key: string; userId: number; companyId: number; type: string; value: Record<string, unknown> };
let activeUser: number | null = null;
let connection: Promise<IDBDatabase> | null = null;
const DB_NAME = "alraesy-device-v1";
const CHANGED = "alraesy-offline-changed";

function database(): Promise<IDBDatabase> {
  if (!("indexedDB" in window)) return Promise.reject(new Error("هذا المتصفح لا يدعم التخزين المحلي"));
  if (connection) return connection;
  connection = new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 4);
    open.onupgradeneeded = (event) => {
      const db = open.result;
      if (event.oldVersion < 1) {
        const snapshots = db.createObjectStore("snapshots", { keyPath: "key" });
        snapshots.createIndex("user", "userId");
        const pending = db.createObjectStore("pending", { keyPath: "id" });
        pending.createIndex("user", "userId");
        const catalog = db.createObjectStore("catalog", { keyPath: "key" });
        catalog.createIndex("scope", ["userId", "companyId", "type"]);
      }
      if (event.oldVersion < 2) db.createObjectStore("item-sync", { keyPath: "key" });
      if (event.oldVersion < 3) db.createObjectStore("catalog-download", { keyPath: "key" });
      if (event.oldVersion < 4) db.createObjectStore("offline-session", { keyPath: "key" });
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  }).catch(error => { connection = null; throw error; });
  return connection;
}
async function readOne<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const request = db.transaction(store, "readonly").objectStore(store).get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error);
  });
}
async function readIndex<T>(store: string, index: string, key: IDBValidKey): Promise<T[]> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const request = db.transaction(store, "readonly").objectStore(store).index(index).getAll(key);
    request.onsuccess = () => resolve(request.result as T[]);
    request.onerror = () => reject(request.error);
  });
}
async function writeOne(store: string, item: unknown): Promise<void> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
async function deleteOne(store: string, key: IDBValidKey): Promise<void> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
async function writeCatalog(entries: CatalogEntry[]): Promise<void> {
  if (!entries.length) return;
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("catalog", "readwrite");
    for (const entry of entries) tx.objectStore("catalog").put(entry);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
export function setOfflineUser(userId: number | null) {
  activeUser = Number.isSafeInteger(userId) && Number(userId) > 0 ? userId : null;
  window.dispatchEvent(new Event(CHANGED));
}
export function offlineUser() { return activeUser; }
export function offlineChanged(listener: () => void) {
  window.addEventListener(CHANGED, listener);
  return () => window.removeEventListener(CHANGED, listener);
}
function changed() { window.dispatchEvent(new Event(CHANGED)); }
type OfflineSessionRow = {
  key: "last"; user: import("../../../packages/contracts/src/index").User;
  savedAt: number;
};
const OFFLINE_SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// Keep the authenticated user's offline continuation independent of the
// large catalog database. Other open tabs may hold an older catalog schema
// and block its upgrade; that must not block saving a successful login.
const RESUME_DB_NAME = "alraesy-offline-identity-v1";
async function resumeDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request=indexedDB.open(RESUME_DB_NAME,1);
    request.onupgradeneeded=()=>{
      request.result.createObjectStore("verified",{keyPath:"key"});
    };
    request.onsuccess=()=>{
      const db=request.result;
      db.onversionchange=()=>db.close();
      resolve(db);
    };
    request.onerror=()=>reject(request.error);
    request.onblocked=()=>reject(new Error("تعذر الوصول إلى هوية الجهاز المحفوظة"));
  });
}
async function resumeWrite(value:OfflineSessionRow):Promise<void> {
  const db=await resumeDatabase();
  try {
    await new Promise<void>((resolve,reject)=>{
      const tx=db.transaction("verified","readwrite");
      tx.objectStore("verified").put(value);
      tx.oncomplete=()=>resolve();
      tx.onabort=()=>reject(tx.error);
      tx.onerror=()=>reject(tx.error);
    });
  } finally { db.close(); }
}
async function resumeRead():Promise<OfflineSessionRow|undefined> {
  const db=await resumeDatabase();
  try {
    return await new Promise((resolve,reject)=>{
      const request=db.transaction("verified","readonly").objectStore("verified").get("last");
      request.onsuccess=()=>resolve(request.result as OfflineSessionRow|undefined);
      request.onerror=()=>reject(request.error);
    });
  } finally { db.close(); }
}
async function resumeClear():Promise<void> {
  const db=await resumeDatabase();
  try {
    await new Promise<void>((resolve,reject)=>{
      const tx=db.transaction("verified","readwrite");
      tx.objectStore("verified").delete("last");
      tx.oncomplete=()=>resolve();
      tx.onabort=()=>reject(tx.error);
      tx.onerror=()=>reject(tx.error);
    });
  } finally { db.close(); }
}

export function validOfflineSession(
  row: { user: { id:number; suspended:boolean; archived:boolean }; savedAt:number } | null | undefined,
  now = Date.now(),
): boolean {
  return !!row && !!row.user && Number.isSafeInteger(row.user.id) &&
    row.user.id > 0 && !row.user.suspended && !row.user.archived &&
    Number.isFinite(row.savedAt) && row.savedAt <= now &&
    now - row.savedAt <= OFFLINE_SESSION_MAX_AGE_MS;
}
export async function saveOfflineSession(
  user: import("../../../packages/contracts/src/index").User,
): Promise<void> {
  if (!Number.isSafeInteger(user.id) || user.id <= 0 || user.suspended || user.archived) return;
  // An offline session is a limited, local continuation of an authenticated
  // session, not a password or CSRF token; financial writes still require API.
  await resumeWrite({key:"last",user,savedAt:Date.now()});
}
export async function readOfflineSession():
  Promise<import("../../../packages/contracts/src/index").User | null> {
  const row = await resumeRead();
  if (!validOfflineSession(row)) return null;
  return row!.user;
}
export async function clearOfflineSession(): Promise<void> {
  await resumeClear();
}

/**
 * A shared device may enroll more than one employee, but only after the
 * server has verified that employee's password during an online login.
 * PBKDF2 stores a salted verifier, never the password or the server hash.
 * Offline access expires seven days after that online verification.
 */
type OfflineAccount = {
  userId: number; user: import("../../../packages/contracts/src/index").User;
  login: string; salt: number[]; verifier: number[]; verifiedAt: number;
  failures: number; lockedUntil: number;
};
const OFFLINE_ACCOUNT_DB = "alraesy-offline-accounts-v1";
const OFFLINE_PBKDF2_ITERATIONS = 350_000;
function offlineLoginId(value: string): string { return value.trim().toLowerCase(); }
function accountDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(OFFLINE_ACCOUNT_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("accounts", {keyPath: "userId"});
    request.onsuccess = () => { const db=request.result; db.onversionchange=()=>db.close(); resolve(db); };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("تعذر تحديث اعتماد الموظفين على هذا الجهاز"));
  });
}
async function allOfflineAccounts(): Promise<OfflineAccount[]> {
  const db=await accountDb();
  try {
    return await new Promise((resolve,reject)=>{
      const req=db.transaction("accounts","readonly").objectStore("accounts").getAll();
      req.onsuccess=()=>resolve(req.result as OfflineAccount[]);
      req.onerror=()=>reject(req.error);
    });
  } finally { db.close(); }
}
async function storeOfflineAccount(account: OfflineAccount): Promise<void> {
  const db=await accountDb();
  try {
    await new Promise<void>((resolve,reject)=>{
      const tx=db.transaction("accounts","readwrite");
      tx.objectStore("accounts").put(account);
      tx.oncomplete=()=>resolve();
      tx.onabort=()=>reject(tx.error);
      tx.onerror=()=>reject(tx.error);
    });
  } finally { db.close(); }
}
async function passwordVerifier(password:string,salt:number[]):Promise<number[]> {
  if (!crypto?.subtle) throw new Error("هذا الجهاز لا يدعم التحقق الآمن دون اتصال");
  const bytes=new TextEncoder().encode(password);
  const key=await crypto.subtle.importKey("raw",bytes,{name:"PBKDF2"},false,["deriveBits"]);
  const bits=await crypto.subtle.deriveBits({
    name:"PBKDF2",salt:new Uint8Array(salt),iterations:OFFLINE_PBKDF2_ITERATIONS,hash:"SHA-256",
  },key,256);
  return Array.from(new Uint8Array(bits));
}
export async function enrollOfflineAccount(
  user: import("../../../packages/contracts/src/index").User,
  login: string, password: string,
): Promise<void> {
  if (user.archived || user.suspended || !user.id || !login.trim() || !password) return;
  const salt=Array.from(crypto.getRandomValues(new Uint8Array(16)));
  const verifier=await passwordVerifier(password,salt);
  await storeOfflineAccount({
    userId:user.id,user,login:offlineLoginId(login),salt,verifier,
    verifiedAt:Date.now(),failures:0,lockedUntil:0,
  });
}
export async function authenticateOfflineAccount(
  login:string,password:string,
): Promise<import("../../../packages/contracts/src/index").User> {
  const account=(await allOfflineAccounts()).find(row=>row.login===offlineLoginId(login));
  const now=Date.now();
  if (!account || !validOfflineSession({user:account.user,savedAt:account.verifiedAt},now))
    throw new Error("هذا الحساب لم يجهز للدخول دون إنترنت أو انتهت صلاحيته. يجب الدخول مرة عبر الإنترنت.");
  if (account.lockedUntil>now)
    throw new Error("محاولات دخول كثيرة. أعد المحاولة بعد انتهاء فترة الحظر أو ادخل عبر الإنترنت.");
  const actual=await passwordVerifier(password,account.salt);
  let difference=0;
  for(let i=0;i<account.verifier.length;i++) difference |= account.verifier[i] ^ (actual[i] ?? 0);
  if(difference!==0 || account.verifier.length!==actual.length) {
    account.failures++;
    if(account.failures>=5) { account.lockedUntil=now+60_000; account.failures=0; }
    await storeOfflineAccount(account);
    throw new Error("كلمة المرور غير صحيحة");
  }
  account.failures=0;
  account.lockedUntil=0;
  await storeOfflineAccount(account);
  return account.user;
}
/** A local sign-out revokes local visibility without pretending to revoke the
 * server cookie while disconnected. That cookie cannot be used by this app
 * until a fresh online login replaces it. */
export async function setOfflineLoginRequired(required:boolean, clearActive=false):Promise<void> {
  const db=await resumeDatabase();
  try {
    await new Promise<void>((resolve,reject)=>{
      const tx=db.transaction("verified","readwrite");
      tx.objectStore("verified").put({key:"fresh-login-required",required});
      if(clearActive) tx.objectStore("verified").delete("last");
      tx.oncomplete=()=>resolve();
      tx.onabort=()=>reject(tx.error);
      tx.onerror=()=>reject(tx.error);
    });
  } finally { db.close(); }
}
export async function offlineLoginRequired():Promise<boolean> {
  const db=await resumeDatabase();
  try {
    return await new Promise((resolve,reject)=>{
      const req=db.transaction("verified","readonly").objectStore("verified").get("fresh-login-required");
      req.onsuccess=()=>resolve(!!(req.result as {required?:boolean}|undefined)?.required);
      req.onerror=()=>reject(req.error);
    });
  } finally { db.close(); }
}

function allowedSnapshot(path: string): boolean {
  // Cache only already-authorized server GET responses. The user key is
  // separate per account; no authentication or password endpoints are cached.
  return /^\/appearance\?scope=(?:public|company%3A\d+|company:\d+)$/.test(path) ||
    /^\/my-shortcuts(?:\?|$)/.test(path) ||
    /^\/companies(?:\?|$)/.test(path) ||
    /^\/companies\/[1-9]\d*$/.test(path) ||
    /^\/companies\/[1-9]\d*\/letterhead$/.test(path) ||
    /^\/page-catalog\?/.test(path) ||
    /^\/companies\/[1-9]\d*\/(?:commerce-options|financial-options|invoices|financial-documents|items|item-compositions|accounts|stock-balances|stock-movements|branches|locations|currencies|control|my-sales-cashbox)(?:[/?]|$)/.test(path)
    || /^\/(?:questions|answers)(?:[/?]|$)/.test(path)
    || /^\/companies\/[1-9]\d*\/(?:questions|answers)(?:[/?]|$)/.test(path)
    || /^\/companies\/[1-9]\d*\/wallet\/summary$/.test(path)
    || /^\/companies\/[1-9]\d*\/sales-item-alerts\/[1-9]\d*$/.test(path);
}


export type SaleRankSnapshot = {
  asOfDate: string;
  scores: Record<string,string>;
  priorities?: Record<string,string>;
};
export type SaleRankProgress = SaleRankSnapshot & {
  afterId: number;
};
const saleRankPath = (companyId:number, stage:"complete"|"progress") =>
  "/local-sale-ranks/" + companyId + "/" + stage;
/** The rank is sales-private, unlike public item cards. Scope it to the
 * current user and company, and retain the last complete snapshot offline.
 */
export async function readSaleRankSnapshot(
  userId:number,companyId:number,stage:"complete"|"progress"="complete",
):Promise<SaleRankProgress|null>{
  if(activeUser!==userId) return null;
  const path=saleRankPath(companyId,stage);
  const row=await readOne<Snapshot>("snapshots",userId+":"+path);
  if(!row?.value||typeof row.value!=="object")return null;
  const value=row.value as SaleRankProgress;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value.asOfDate) ||
      !value.scores||typeof value.scores!=="object")return null;
  return value;
}
export async function saveSaleRankSnapshot(
  userId:number,companyId:number,stage:"complete"|"progress",
  snapshot:SaleRankProgress,
):Promise<void>{
  if(activeUser!==userId)throw new Error("تغير المستخدم أثناء تحديث ترتيب المبيعات");
  const path=saleRankPath(companyId,stage);
  await writeOne("snapshots",{
    key:userId+":"+path,userId,path,
    value:snapshot,savedAt:new Date().toISOString(),
  } satisfies Snapshot);
  if(stage==="complete")await deleteOne("snapshots",userId+":"+saleRankPath(companyId,"progress"));
}
/** Sorting a saved item lookup never derives sales data from the local sales
 * drafts: the ranking came from a previously authorized stored server view.
 */
export function compareItemsBySavedSales(
  a:Record<string,unknown>,
  b:Record<string,unknown>,
  scores:Record<string,string>,
  search="",
):number{
  const q=search.trim().toLocaleLowerCase();
  const exact=(item:typeof a)=>!!q&&[item.code,item.barcode].some(v=>
    typeof v==="string"&&v.toLocaleLowerCase()===q);
  if(exact(a)!==exact(b))return exact(a)?-1:1;
  const left=BigInt(scores[String(a.id)]??"0"),right=BigInt(scores[String(b.id)]??"0");
  if(left!==right)return left>right?-1:1;
  return String(a.code??"").localeCompare(String(b.code??""),"en")||Number(a.id)-Number(b.id);
}

/** Invoice search ranking is server-derived and scaled by 1e6 to retain
 * fractional quantities while comparing exactly with BigInt offline.
 */
export function compareItemsBySaleQuantityAndStock(
  a: Record<string,unknown>, b: Record<string,unknown>,
  scores: Record<string,string>, search = "",
): number {
  const q = search.trim().toLocaleLowerCase();
  const exact = (item: Record<string,unknown>) =>
    !!q && [item.code,item.barcode].some(value =>
      typeof value === "string" && value.toLocaleLowerCase() === q);
  if (exact(a) !== exact(b)) return exact(a) ? -1 : 1;
  const left = BigInt(scores[String(a.id)] ?? "0");
  const right = BigInt(scores[String(b.id)] ?? "0");
  if (left !== right) return left > right ? -1 : 1;
  return String(a.code ?? "").localeCompare(String(b.code ?? ""), "en")
    || Number(a.id) - Number(b.id);
}

type LocalAppearance = import("../../../packages/contracts/src/index").AppearancePreference;
const appearanceDraftPath = (scope: string) =>
  "/pending-appearance?scope=" + encodeURIComponent(scope);
export async function saveAppearanceDraft(
  userId: number, scope: string, preference: LocalAppearance,
): Promise<void> {
  if (activeUser !== userId) return;
  if (!["light","dark"].includes(preference.mode) ||
      !/^#[0-9a-f]{6}$/i.test(preference.color)) return;
  const path=appearanceDraftPath(scope);
  await writeOne("snapshots", {key:userId+":"+path,userId,path,
    value:preference,savedAt:new Date().toISOString()} satisfies Snapshot);
}
export async function readAppearanceDraft(
  userId: number, scope: string,
): Promise<LocalAppearance | null> {
  if (activeUser !== userId) return null;
  const row=await readOne<Snapshot>("snapshots",userId+":"+appearanceDraftPath(scope));
  return (row?.value as LocalAppearance|undefined)??null;
}
export async function clearAppearanceDraft(userId: number, scope: string): Promise<void> {
  if (activeUser !== userId) return;
  await deleteOne("snapshots",userId+":"+appearanceDraftPath(scope));
}

/** Question outcomes belong only to the signed-in user and original scope.
 * The shared question catalog must never contain answer keys or personal choices.
 */
export type SavedQuestionOutcome = {
  selectedAnswer: number; correct: boolean; correctAnswer: number | null;
  correctText?: string | null;
  points: number; comment: string | null; otherOptionCounts: number[];
};
function answerHistoryPath(scope: string, questionId: number): string {
  return "/my-answer-history/" + encodeURIComponent(scope) + "/" + questionId;
}
export async function storePersonalAnswer(
  userId: number, scope: string, questionId: number, outcome: SavedQuestionOutcome,
  notify = true,
): Promise<void> {
  if (activeUser !== userId || !Number.isSafeInteger(questionId) || questionId <= 0 ||
      !Number.isSafeInteger(outcome.selectedAnswer) || outcome.selectedAnswer <= 0) return;
  const path = answerHistoryPath(scope, questionId);
  await writeOne("snapshots", {
    key: userId + ":" + path, userId, path,
    value: outcome, savedAt: new Date().toISOString(),
  } satisfies Snapshot);
  if(notify) changed();
}
export function announcePersonalAnswerChanges(): void { changed(); }
export async function personalAnswerHistory(
  userId: number, scope: string,
): Promise<Record<number, SavedQuestionOutcome>> {
  if (activeUser !== userId) return {};
  const prefix = "/my-answer-history/" + encodeURIComponent(scope) + "/";
  const rows = await readIndex<Snapshot>("snapshots", "user", userId);
  const result: Record<number, SavedQuestionOutcome> = {};
  for (const row of rows) {
    if (!row.path.startsWith(prefix)) continue;
    const questionId = Number(row.path.slice(prefix.length));
    const value = row.value as SavedQuestionOutcome;
    if (Number.isSafeInteger(questionId) && questionId > 0 &&
        Number.isSafeInteger(value?.selectedAnswer) && value.selectedAnswer > 0)
      result[questionId] = value;
  }
  return result;
}
/** Server-confirmed answers from GET replace the local user-only history. */
async function rememberQuestionHistory(userId: number, path: string, value: unknown) {
  const questionList = /^\/(?:companies\/\d+\/)?questions\?/.test(path);
  if (!questionList || !value || typeof value !== "object") return;
  const scopeId = path.match(/^\/companies\/(\d+)\/questions\?/);
  const scope = scopeId ? "company:" + scopeId[1] : "public";
  const items = (value as {items?: unknown}).items;
  if (!Array.isArray(items)) return;
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const q = raw as Record<string, unknown>;
    if (typeof q.id !== "number" ||
        typeof q.myLastSelectedAnswer !== "number" ||
        typeof q.myLastCorrect !== "boolean") continue;
    await storePersonalAnswer(userId, scope, q.id, {
      selectedAnswer: q.myLastSelectedAnswer, correct: q.myLastCorrect,
      correctAnswer: typeof q.correctAnswer === "number" ? q.correctAnswer : null,
      correctText: typeof q.myLastCorrectText === "string" ? q.myLastCorrectText : null,
      points: typeof q.myLastPoints === "number" ? q.myLastPoints : 0,
      comment: typeof q.myLastComment === "string" ? q.myLastComment : null,
      otherOptionCounts: Array.isArray(q.otherOptionCounts)
        ? q.otherOptionCounts.filter((n):n is number => typeof n === "number") : [],
    }, false);
  }
  changed();
}

export async function rememberRead(path: string, value: unknown): Promise<void> {
  const userId = activeUser;
  if (userId === null || !allowedSnapshot(path)) return;
  // Do not exhaust mobile storage with a single huge response.
  const serialized = JSON.stringify(value);
  if (!serialized || serialized.length > 800_000) return;
  await writeOne("snapshots", {
    key: String(userId) + ":" + path, userId, path, value,
    savedAt: new Date().toISOString(),
  } satisfies Snapshot);
  await rememberQuestionHistory(userId, path, value);
  // A direct online item-card read must also refresh its offline search card.
  const detail = path.match(/^\/companies\/(\d+)\/items\/(\d+)$/);
  if (detail && value && typeof value === "object") {
    const item = (value as { item?: Record<string, unknown> }).item;
    if (item && item.id === Number(detail[2])) {
      await writeCatalog([{
        key: [userId, Number(detail[1]), "items", item.id].join(":"),
        userId, companyId: Number(detail[1]), type: "items", value: item,
      }]);
    }
  }
  const match = path.match(/^\/companies\/(\d+)\/(?:commerce-options|financial-options)\?/);
  if (!match || !value || typeof value !== "object") return;
  const type = new URLSearchParams(path.slice(path.indexOf("?") + 1)).get("type");
  if (!type || !["items", "accounts", "branches", "locations", "currencies"].includes(type)) return;
  const items = (value as { items?: unknown }).items;
  if (!Array.isArray(items)) return;
  const records: CatalogEntry[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const id = (item as { id?: unknown }).id;
    if (typeof id !== "number" || !Number.isSafeInteger(id)) continue;
    const companyId = Number(match[1]);
    const key = [userId, companyId, type, id].join(":");
    records.push({ key, userId, companyId, type, value: item as Record<string, unknown> });
  }
  await writeCatalog(records);
}
/** Device-local company letterhead image, isolated by verified user and company.
 * No authenticated media URL is shared across users or promoted to an API grant.
 */
const letterheadMediaPath = (companyId:number, imageUrl:string) =>
  "/local-company-letterhead/" + companyId + "/" + imageUrl;
export async function saveOfflineLetterheadImage(
  userId:number, companyId:number, imageUrl:string, blob:Blob,
):Promise<void> {
  if (activeUser!==userId || !/^\/api\/media\/[0-9a-f-]{36}\/full$/i.test(imageUrl) ||
      !blob.type.startsWith("image/") || blob.size>5_000_000) return;
  const path=letterheadMediaPath(companyId,imageUrl);
  await writeOne("snapshots",{
    key:userId+":"+path,userId,path,value:blob,savedAt:new Date().toISOString(),
  } satisfies Snapshot);
}
export async function readOfflineLetterheadImage(
  userId:number, companyId:number, imageUrl:string,
):Promise<Blob|null> {
  if (activeUser!==userId || !/^\/api\/media\/[0-9a-f-]{36}\/full$/i.test(imageUrl))
    return null;
  const row=await readOne<Snapshot>("snapshots",userId+":"+letterheadMediaPath(companyId,imageUrl));
  return row?.value instanceof Blob && row.value.type.startsWith("image/")
    ? row.value : null;
}

export async function savedRead<T>(path: string): Promise<T | undefined> {
  const userId = activeUser;
  if (userId === null || !allowedSnapshot(path)) return undefined;
  const snapshot = await readOne<Snapshot>("snapshots", String(userId) + ":" + path);
  const card = path.match(/^\/companies\/(\d+)\/items\/(\d+)$/);
  if (card) {
    const entry = await readOne<CatalogEntry>("catalog",
      [userId, Number(card[1]), "items", Number(card[2])].join(":"));
    if (entry) return { item: entry.value } as T;
  }
  const itemQuery = /^\/companies\/\d+\/(?:commerce-options|financial-options)\?/.test(path) &&
    new URLSearchParams(path.split("?")[1]).get("type") === "items";
  if (snapshot && !itemQuery) return snapshot.value as T;
  const match = path.match(/^\/companies\/(\d+)\/(?:commerce-options|financial-options)\?/);
  if (!match) return undefined;
  const companyId = Number(match[1]);
  const qs = new URLSearchParams(path.slice(path.indexOf("?") + 1));
  const type = qs.get("type");
  if (!type || !["items", "accounts", "branches", "locations", "currencies"].includes(type)) return undefined;
  const records = await readIndex<CatalogEntry>("catalog", "scope", [userId, companyId, type]);
  if (!records.length) return snapshot?.value as T | undefined;
  const q = (qs.get("q") ?? "").normalize("NFKC").toLocaleLowerCase();
  const active = qs.get("active");
  const id = qs.get("id");
  const shortcut = qs.get("shortcut");
  const branchId = qs.get("branchId");
  const filtered = records.map(record => record.value).filter(item => {
    if (id && String(item.id) !== id) return false;
    if (shortcut && String(item.shortcut ?? "").toUpperCase() !== shortcut.toUpperCase()) return false;
    if (active === "true" && item.active === false) return false;
    if (branchId && String(item.branchId) !== branchId) return false;
    if (!q) return true;
    return ["name", "code", "barcode", "shortCode", "shortcut", "searchKeys", "englishName"]
      .some(key => String(item[key] ?? "").normalize("NFKC").toLocaleLowerCase().includes(q));
  });
  if(type==="items" && qs.get("sort")?.startsWith("saleQuantityPlusStock:desc")) {
    const rank=await readSaleRankSnapshot(userId,companyId);
    if(rank?.priorities)
      filtered.sort((a,b)=>compareItemsBySaleQuantityAndStock(a,b,rank.priorities,qs.get("q")??""));
  } else if(type==="items" && qs.get("sort")?.startsWith("saleTimes:desc")) {
    const rank=await readSaleRankSnapshot(userId,companyId);
    if(rank) filtered.sort((a,b)=>compareItemsBySavedSales(a,b,rank.scores,qs.get("q")??""));
  }
  const page = Math.max(1, Number(qs.get("page") ?? "1") || 1);
  const pageSize = Math.min(100, Math.max(1, Number(qs.get("pageSize") ?? "20") || 20));
  const offset = (page - 1) * pageSize;
  return { items: filtered.slice(offset, offset + pageSize), total: filtered.length, page, pageSize } as T;
}

type CatalogProgress = { key: string; nextPage: number; complete: boolean };
export async function readCatalogProgress(userId: number, companyId: number, section: string) {
  if (activeUser !== userId) throw new Error("تغير مستخدم الجهاز");
  const row = await readOne<CatalogProgress>("catalog-download", userId + ":" + companyId + ":" + section);
  return { nextPage: row?.nextPage ?? 1, complete: !!row?.complete };
}
export async function saveCatalogProgress(
  userId: number, companyId: number, section: string, nextPage: number, complete: boolean,
): Promise<void> {
  if (activeUser !== userId) throw new Error("تغير مستخدم الجهاز");
  await writeOne("catalog-download", {
    key: userId + ":" + companyId + ":" + section, nextPage, complete,
  } satisfies CatalogProgress);
}

export type ItemChangeCursor = { since: string; afterId: number };
export type CatalogDownload = {
  key: string;
  userId: number;
  companyId: number;
  cursor: ItemChangeCursor;
  count: number;
  complete: boolean;
};
export async function catalogDownloadState(userId: number, companyId: number): Promise<CatalogDownload | undefined> {
  if (activeUser !== userId) return undefined;
  return readOne<CatalogDownload>("catalog-download", userId + ":" + companyId);
}
export async function rememberCatalogBatch(
  userId: number, companyId: number, items: Record<string, unknown>[],
  cursor: ItemChangeCursor, count: number, complete: boolean,
): Promise<void> {
  if (activeUser !== userId) throw new Error("تغير المستخدم أثناء التنزيل");
  const entries: CatalogEntry[] = [];
  for (const item of items) {
    if (typeof item.id !== "number" || !Number.isSafeInteger(item.id)) continue;
    entries.push({
      key: [userId, companyId, "items", item.id].join(":"),
      userId, companyId, type: "items", value: item,
    });
  }
  // Write cards first, THEN the checkpoint. A refresh or interrupted download
  // can replay a page safely without ever marking missing cards as saved.
  await writeCatalog(entries);
  await writeOne("catalog-download", {
    key: userId + ":" + companyId, userId, companyId, cursor, count, complete,
  } satisfies CatalogDownload);
}

export async function itemChangeCursor(userId: number, companyId: number): Promise<ItemChangeCursor | null> {
  if (activeUser !== userId) return null;
  const key = userId + ":" + companyId;
  const stored = await readOne<{ cursor: ItemChangeCursor }>("item-sync", key);
  if (stored) return stored.cursor;
  // Preexisting offline downloads may be older than this feature. Start at the
  // earliest saved item read, not at "now", so edits made while offline are caught.
  const snapshots = await readIndex<Snapshot>("snapshots", "user", userId);
  const dates = snapshots.filter(row =>
    row.path.startsWith("/companies/" + companyId + "/items") ||
    (row.path.startsWith("/companies/" + companyId + "/commerce-options?") &&
      new URLSearchParams(row.path.split("?")[1]).get("type") === "items"))
    .map(row => Date.parse(row.savedAt)).filter(Number.isFinite);
  if (!dates.length) return null;
  return { since: new Date(Math.max(0, Math.min(...dates) - 60_000)).toISOString(), afterId: 0 };
}
export async function applyItemChanges(
  userId: number, companyId: number,
  items: Record<string, unknown>[], cursor: ItemChangeCursor,
): Promise<void> {
  if (activeUser !== userId) throw new Error("تغير الحساب أثناء مزامنة الأصناف");
  const db = await database();
  const snapshots = items.length ? await readIndex<Snapshot>("snapshots", "user", userId) : [];
  if (activeUser !== userId) throw new Error("تغير الحساب أثناء مزامنة الأصناف");
  const updated = new Map(items.map(item => [item.id, item]));
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(["catalog", "snapshots", "item-sync"], "readwrite");
    for (const item of items) {
      if (typeof item.id !== "number") continue;
      tx.objectStore("catalog").put({
        key: [userId, companyId, "items", item.id].join(":"),
        userId, companyId, type: "items", value: item,
      } satisfies CatalogEntry);
    }
    // Update already downloaded detail/list snapshots as well. Nothing from
    // another user or company is touched; no financial data is modified.
    for (const row of snapshots) {
      if (!row.path.startsWith("/companies/" + companyId + "/")) continue;
      const url = row.path;
      const isItemDetail = /^\/companies\/\d+\/items\/\d+$/.test(url);
      const isItemList = /^\/companies\/\d+\/items(?:\?|$)/.test(url);
      const isOptions = url.includes("/commerce-options?") &&
        new URLSearchParams(url.split("?")[1]).get("type") === "items";
      if (!isItemDetail && !isItemList && !isOptions) continue;
      const original = row.value as { item?: Record<string, unknown>; items?: Record<string, unknown>[] };
      if (!original || typeof original !== "object") continue;
      let changed = false;
      let value = original;
      if (isItemDetail && original.item && updated.has(original.item.id)) {
        value = { ...value, item: updated.get(original.item.id) };
        changed = true;
      }
      if (Array.isArray(original.items)) {
        const nextItems = original.items.map(item => {
          const next = updated.get(item.id);
          if (next) { changed = true; return next; }
          return item;
        });
        if (changed) value = { ...value, items: nextItems };
      }
      if (changed) tx.objectStore("snapshots").put({ ...row, value, savedAt: new Date().toISOString() });
    }
    tx.objectStore("item-sync").put({ key: userId + ":" + companyId, cursor });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  if (items.length) changed();
}

export async function queueOfflineOperation(
  userId: number, companyId: number | null, kind: OfflineKind,
  path: string, body: { idempotencyKey: string },
): Promise<void> {
  if (activeUser !== userId) throw new Error("تغير المستخدم؛ لا يمكن حفظ العملية لهذا الحساب");
  if (!/^[0-9a-f-]{36}$/i.test(body.idempotencyKey))
    throw new Error("مفتاح منع التكرار غير صالح");
  const expected = kind === "answer"
    ? /^\/(?:companies\/\d+\/)?questions\/\d+\/answers$/
    : kind === "invoice"
      ? /^\/companies\/\d+\/invoices$/
      : kind === "cashbox"
        ? /^\/companies\/\d+\/sales\/cashbox-operations$/
        : /^\/companies\/\d+\/financial-documents$/;
  if (!expected.test(path)) throw new Error("مسار العملية غير مسموح للحفظ المحلي");
  if (kind === "cashbox" && (companyId === null ||
      path !== `/companies/${companyId}/sales/cashbox-operations`))
    throw new Error("عملية الصندوق لا تطابق شركة المستخدم");
  const existing = await readOne<OfflinePending>("pending", body.idempotencyKey);
  if (existing) {
    if (existing.userId !== userId || existing.companyId !== companyId ||
        existing.kind !== kind || existing.path !== path ||
        JSON.stringify(existing.body) !== JSON.stringify(body))
      throw new Error("مفتاح العملية محفوظ محليًا لبيانات مختلفة");
    return;
  }
  await writeOne("pending", {
    id: body.idempotencyKey, userId, companyId, kind, path,
    body, createdAt: new Date().toISOString(), failure: null,
  } satisfies OfflinePending);
  changed();
}
export async function pendingForUser(userId: number): Promise<OfflinePending[]> {
  const entries = await readIndex<OfflinePending>("pending", "user", userId);
  return entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
let syncing: Promise<{ saved: number; failed: number }> | null = null;
export function syncPending(
  userId: number, post: (path: string, body: unknown) => Promise<unknown>,
): Promise<{ saved: number; failed: number }> {
  if (syncing) return syncing;
  syncing = (async () => {
    if (activeUser !== userId || !navigator.onLine) return { saved: 0, failed: 0 };
    let saved = 0, failed = 0;
    for (const row of await pendingForUser(userId)) {
      if (activeUser !== userId || !navigator.onLine) break;
      try {
        // Backend revalidates company access and all data, and uses each
        // original idempotency key atomically to avoid duplicate documents.
        const confirmed = await post(row.path, row.body);
        if (row.kind === "answer" && confirmed && typeof confirmed === "object") {
          const details = confirmed as Record<string, unknown>;
          const choice = (row.body as { selectedAnswer?: unknown }).selectedAnswer;
          const match = row.path.match(/^\/(?:companies\/(\d+)\/)?questions\/(\d+)\/answers$/);
          if (match && typeof choice === "number" &&
              typeof details.correct === "boolean") {
            // A saved server response, not the local draft, determines correctness.
            await storePersonalAnswer(userId, match[1] ? "company:" + match[1] : "public",
              Number(match[2]), {
                selectedAnswer: choice, correct: details.correct,
                correctAnswer: typeof details.correctAnswer === "number" ? details.correctAnswer : null,
                correctText: typeof details.correctText === "string" ? details.correctText : null,
                points: typeof details.points === "number" ? details.points : 0,
                comment: (row.body as {comment?: string|null}).comment ?? null,
                otherOptionCounts: Array.isArray(details.otherOptionCounts)
                  ? details.otherOptionCounts.filter((n):n is number => typeof n === "number") : [],
              });
          }
        }
        await deleteOne("pending", row.id);
        saved++;
        changed();
      } catch (error) {
        failed++;
        row.failure = error instanceof Error ? error.message : "تعذر الترحيل؛ راجع العملية";
        await writeOne("pending", row);
        changed();
        // Preserve ordering and stop on auth/validation/transport failures.
        break;
      }
    }
    return { saved, failed };
  })().finally(() => { syncing = null; });
  return syncing;
}
