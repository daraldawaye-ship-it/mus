/**
 * Device-local read snapshots and a durable, user-scoped outbox.
 * This is not a second authoritative accounting database. Only the server
 * posts documents and awards question points.
 */
export type OfflineKind = "invoice" | "voucher" | "answer";
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
export async function saveOfflineSession(
  user: import("../../../packages/contracts/src/index").User,
): Promise<void> {
  if (!Number.isSafeInteger(user.id) || user.id <= 0 || user.suspended || user.archived) return;
  // An offline session is a limited, local continuation of an authenticated
  // session, not a password or CSRF token; financial writes still require API.
  await writeOne("offline-session", {
    key: "last", user, savedAt: Date.now(),
  } satisfies OfflineSessionRow);
}
export async function readOfflineSession():
  Promise<import("../../../packages/contracts/src/index").User | null> {
  const row = await readOne<OfflineSessionRow>("offline-session", "last");
  if (!row || !row.user || !Number.isSafeInteger(row.user.id) ||
      row.user.id <= 0 || row.user.suspended || row.user.archived ||
      Date.now() < row.savedAt ||
      Date.now() - row.savedAt > OFFLINE_SESSION_MAX_AGE_MS) return null;
  return row.user;
}
export async function clearOfflineSession(): Promise<void> {
  await deleteOne("offline-session", "last");
}
function allowedSnapshot(path: string): boolean {
  // Cache only already-authorized server GET responses. The user key is
  // separate per account; no authentication or password endpoints are cached.
  return /^\/companies(?:\?|$)/.test(path) ||
    /^\/companies\/[1-9]\d*$/.test(path) ||
    /^\/page-catalog\?/.test(path) ||
    /^\/companies\/[1-9]\d*\/(?:commerce-options|financial-options|invoices|financial-documents|items|item-compositions|accounts|stock-balances|stock-movements|branches|locations|currencies|control)(?:[/?]|$)/.test(path)
    || /^\/(?:questions|answers)(?:[/?]|$)/.test(path)
    || /^\/companies\/[1-9]\d*\/(?:questions|answers)(?:[/?]|$)/.test(path);
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
      : /^\/companies\/\d+\/financial-documents$/;
  if (!expected.test(path)) throw new Error("مسار العملية غير مسموح للحفظ المحلي");
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
        await post(row.path, row.body);
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
