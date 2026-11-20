import type { User } from "../../../packages/contracts/src/index";
import { marketKinds, type MarketCard } from "../../../packages/contracts/src/medicine-market";

/** Market snapshots are never shared with company/accounting downloads. */
const DB_NAME = "alraesy-market-offline-v1";
const MAX_AGE = 30 * 24 * 60 * 60 * 1000;
const MAX_BYTES = 24 * 1024 * 1024;
const MAX_RESPONSES = 250;
const MAX_CARDS = 4000;
const MAX_ENTRY_BYTES = 1500 * 1024;
const ROOT = "/medicine-market";

export type MarketCacheEvent = {
  type: "updated" | "cleared" | "status" | "scope";
  scope: string | null;
  path?: string;
  data?: unknown;
};
export type MarketReadStatus = {
  source: "saved" | "network" | "missing";
  savedAt: number | null;
  checkedAt: number | null;
  partial: boolean;
  refreshing: boolean;
  error?: string;
};
export type MarketCacheContext = { scope: string | null; generation: number };
export type SavedMarketRead<T = unknown> = {
  data: T;
  etag: string | null;
  savedAt: number;
  checkedAt: number;
  partial: boolean;
};
type Authority = Pick<User, "id" | "owner" | "kind" | "editor" | "monitor" | "suspended" | "archived">;
type Entry = {
  key: string;
  scope: string;
  kind: "response" | "card";
  path: string;
  data: unknown;
  etag: string | null;
  savedAt: number;
  checkedAt: number;
  requestedAt: number;
  bytes: number;
};
type EntryMeta = Omit<Entry, "data" | "etag" | "requestedAt">;
type ResponseCopy<T> = Pick<Entry, "scope" | "etag" | "savedAt" | "checkedAt" | "requestedAt"> & { data: T };
type CardCopy = Pick<Entry, "scope" | "savedAt" | "checkedAt" | "requestedAt"> & { data: MarketCard };
const listeners = new Set<(event: MarketCacheEvent) => void>();
const statuses = new Map<string, MarketReadStatus>();
const dependencies = new Map<string, Set<number>>();
let scope: string | null = null;
let generation = 0;
let dbPromise: Promise<IDBDatabase> | null = null;
let scopeError: string | null = null;
let activeCleared = false;
type CacheInvalidation = { type: "cleared"; scope: string; path?: string };
let channel: BroadcastChannel | null = null;
const SIGNAL_KEY = "alraesy-market-cache-invalidation";

function emit(event: MarketCacheEvent) {
  for (const listener of listeners) {
    try { listener(event); } catch { /* A display subscriber cannot break a read. */ }
  }
}
export function subscribeMarketCache(listener: (event: MarketCacheEvent) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function getMarketCacheScope(): string | null { return scope; }
export function getMarketCacheScopeError(): string | null { return scopeError; }
export function captureMarketCacheContext(): MarketCacheContext { return { scope, generation }; }
export function isCurrentMarketCacheContext(context: MarketCacheContext) {
  return context.scope !== null && context.scope === scope && context.generation === generation;
}
export function marketCacheIdentity(user: Authority | null, visitorOnly = false, forceGuest = false): string {
  if (!user || forceGuest) return "guest";
  // A user can visit with a phone-only session and later log in with full
  // authority. Its private fields must never become the visitor's snapshot.
  return `user:${user.id}:${[user.owner, user.kind, user.editor, user.monitor,
    user.suspended, user.archived, visitorOnly].join(":")}`;
}
/** Stop old-principal reads while an explicit login is adopting its new session. */
export function pauseMarketCacheSession() {
  if (scope !== null && scope !== "guest" && !activeCleared)
    void clearMarketCacheScope(scope).catch(() => {});
  scope = null;
  generation++;
  statuses.clear();
  dependencies.clear();
  activeCleared = false;
  emit({ type: "scope", scope });
}
export function setMarketCacheSession(user: Authority | null, visitorOnly?: boolean, forceGuest = false) {
  // Legacy offline identities predate the stored visitorOnly flag. Retain this
  // compatibility hint; it cannot authorize an expired or missing session.
  const authority = user ? marketCacheIdentity(user) : null;
  let visitor = visitorOnly ?? false;
  if (user && !forceGuest && typeof localStorage !== "undefined") {
    try {
      if (visitorOnly === undefined) {
        const hint = JSON.parse(localStorage.getItem("alraesy-market-session-mode") ?? "null");
        if (hint?.authority === authority) visitor = hint.visitorOnly === true;
      } else localStorage.setItem("alraesy-market-session-mode", JSON.stringify({ authority, visitorOnly }));
    } catch { /* An optional mode hint must never block login. */ }
  }
  const next = marketCacheIdentity(user, visitor, forceGuest);
  if (next === scope) return;
  // A changed principal or authority must not retain an accessible old scope.
  if (scope !== null && scope !== "guest" && !activeCleared) void clearMarketCacheScope(scope).catch(() => {});
  scope = next;
  scopeError = null;
  activeCleared = false;
  generation++;
  statuses.clear();
  dependencies.clear();
  emit({ type: "scope", scope });
}

export function normalizeMarketPath(path: string): string {
  const [pathname, search = ""] = path.split("?", 2);
  const params = new URLSearchParams(search);
  params.sort();
  const suffix = params.toString();
  return pathname + (suffix ? `?${suffix}` : "");
}
function positive(value: string | null, max = 2147483647) {
  return value !== null && /^[1-9]\d*$/.test(value) && Number(value) <= max;
}
/** An explicit allowlist excludes review queues, contributions, admin and writes. */
export function isMarketCachePath(path: string): boolean {
  if (path.includes("#")) return false;
  const [pathname, search = ""] = path.split("?", 2);
  const params = new URLSearchParams(search);
  const keys = [...params.keys()];
  if (new Set(keys).size !== keys.length) return false;
  if (pathname === `${ROOT}/meta` || /^\/medicine-market\/cards\/[1-9]\d*$/.test(pathname))
    return keys.length === 0;
  if (/^\/medicine-market\/cards\/[1-9]\d*\/related-medicines$/.test(pathname))
    return keys.every(key => key === "cursor") && (!params.has("cursor") || positive(params.get("cursor")));
  if (pathname !== `${ROOT}/cards`) return false;
  return keys.every(key => ["kind", "q", "page", "pageSize", "archived", "sort"].includes(key)) &&
    (!params.has("kind") || params.get("kind") === "" || (marketKinds as readonly string[]).includes(params.get("kind")!)) &&
    (params.get("q") ?? "").length <= 200 &&
    (!params.has("page") || positive(params.get("page"), 1000000)) &&
    (!params.has("pageSize") || positive(params.get("pageSize"), 100)) &&
    (!params.has("archived") || ["true", "false"].includes(params.get("archived")!)) &&
    (!params.has("sort") || ["created", "updated"].includes(params.get("sort")!));
}

export function getMarketReadStatus(path: string): MarketReadStatus | null {
  return statuses.get(normalizeMarketPath(path)) ?? null;
}
export function setMarketReadStatus(context: MarketCacheContext, path: string, status: MarketReadStatus) {
  if (!isCurrentMarketCacheContext(context)) return;
  path = normalizeMarketPath(path);
  const previous = statuses.get(path);
  if (previous && Object.keys(status).every(key =>
    previous[key as keyof MarketReadStatus] === status[key as keyof MarketReadStatus]) &&
    Object.keys(previous).length === Object.keys(status).length) return;
  statuses.set(path, status);
  // Status is per visible query, not a second unbounded copy of market data.
  if (statuses.size > 500) statuses.delete(statuses.keys().next().value!);
  emit({ type: "status", scope: context.scope, path });
}

function database(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("التخزين المحلي غير متاح"));
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        for (const name of ["entries", "metadata"]) {
          const store = request.result.createObjectStore(name, { keyPath: "key" });
          store.createIndex("scope", "scope");
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); dbPromise = null; };
        resolve(db);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("تعذر فتح نسخة السوق المحفوظة"));
    }).catch(error => { dbPromise = null; throw error; });
  }
  return dbPromise;
}
function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("تعذر حفظ نسخة السوق"));
    tx.onerror = () => reject(tx.error);
  });
}
const responseKey = (scope: string, path: string) => `${scope}|response|${path}`;
const cardKey = (scope: string, id: number) => `${scope}|card|${id}`;
function valid(entry: Entry | undefined, now = Date.now()): entry is Entry {
  return !!entry && entry.savedAt <= now && now - entry.checkedAt <= MAX_AGE;
}
function card(value: unknown): value is MarketCard {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<MarketCard>;
  return Number.isSafeInteger(v.id) && Number(v.id) > 0 && typeof v.name === "string" &&
    (marketKinds as readonly unknown[]).includes(v.kind) &&
    !!v.data && typeof v.data === "object" && !Array.isArray(v.data) &&
    ["pending", "published", "rejected"].includes(v.status ?? "") &&
    typeof v.archived === "boolean" && typeof v.revision === "number";
}
function receivedCards(data: unknown): MarketCard[] {
  if (!data || typeof data !== "object") return [];
  const value = data as { card?: unknown; items?: unknown };
  return card(value.card) ? [value.card] :
    Array.isArray(value.items) ? value.items.filter(card) : [];
}
function cardFingerprint(value: MarketCard) {
  const { englishName: _derivedName, ...body } = value as MarketCard & { englishName?: string | null };
  return JSON.stringify(body);
}
function trackDependencies(path: string, data: unknown) {
  dependencies.set(normalizeMarketPath(path), new Set(receivedCards(data).map(item => item.id)));
  if (dependencies.size > 500) dependencies.delete(dependencies.keys().next().value!);
}
function metadata(entry: Entry): EntryMeta {
  const { data: _data, etag: _etag, requestedAt: _requestedAt, ...value } = entry;
  return value;
}
function put(tx: IDBTransaction, entry: Entry) {
  tx.objectStore("entries").put(entry);
  tx.objectStore("metadata").put(metadata(entry));
}
function remove(tx: IDBTransaction, key: string) {
  tx.objectStore("entries").delete(key);
  tx.objectStore("metadata").delete(key);
}
function makeEntry(context: MarketCacheContext, path: string, data: unknown, etag: string | null,
  requestedAt: number, now: number, kind: Entry["kind"] = "response"): Entry | null {
  if (!context.scope) return null;
  const bytes = JSON.stringify(data).length * 2;
  if (bytes > MAX_ENTRY_BYTES) return null;
  return { key: kind === "card" ? cardKey(context.scope, (data as MarketCard).id) : responseKey(context.scope, path),
    scope: context.scope, kind, path, data, etag, bytes, savedAt: now, checkedAt: now, requestedAt };
}

/** Bound persistent JSON storage without repeatedly reading all JSON bodies. */
async function prune(db: IDBDatabase) {
  const tx = db.transaction(["entries", "metadata"], "readwrite");
  const done = transactionDone(tx);
  const request = tx.objectStore("metadata").getAll();
  request.onsuccess = () => {
    const now = Date.now();
    const rows = (request.result as EntryMeta[]).sort((a, b) => b.checkedAt - a.checkedAt);
    let bytes = 0, responses = 0, cards = 0;
    for (const row of rows) {
      const expired = now - row.checkedAt > MAX_AGE || row.savedAt > now;
      if (expired || bytes + row.bytes > MAX_BYTES ||
          (row.kind === "card" ? cards >= MAX_CARDS : responses >= MAX_RESPONSES)) {
        remove(tx, row.key);
      } else {
        bytes += row.bytes;
        if (row.kind === "card") cards++; else responses++;
      }
    }
  };
  await done;
}

export async function saveMarketRead(context: MarketCacheContext, path: string, data: unknown,
  etag: string | null, requestedAt: number): Promise<boolean> {
  if (!isCurrentMarketCacheContext(context) || !isMarketCachePath(path)) return false;
  path = normalizeMarketPath(path);
  const now = Date.now();
  const entry = makeEntry(context, path, data, etag, requestedAt, now);
  const db = await database();
  if (!isCurrentMarketCacheContext(context)) return false;
  const tx = db.transaction(["entries", "metadata"], "readwrite");
  const done = transactionDone(tx);
  let persisted = false;
  if (entry) {
    const previous = tx.objectStore("entries").get(entry.key);
    previous.onsuccess = () => {
      if (!isCurrentMarketCacheContext(context)) return;
      const row = previous.result as Entry | undefined;
      if (row && row.requestedAt > requestedAt) return;
      put(tx, entry);
      persisted = true;
    };
  }
  for (const value of receivedCards(data)) {
    const incoming = makeEntry(context, `${ROOT}/cards/${value.id}`, value, null, requestedAt, now, "card");
    if (!incoming) continue;
    const previous = tx.objectStore("entries").get(incoming.key);
    previous.onsuccess = () => {
      if (!isCurrentMarketCacheContext(context)) return;
      const row = previous.result as Entry | undefined;
      if (row && ((row.data as MarketCard).revision > value.revision || row.requestedAt > requestedAt)) return;
      put(tx, incoming);
    };
  }
  await done;
  await prune(db);
  if (persisted && isCurrentMarketCacheContext(context)) activeCleared = false;
  return persisted && isCurrentMarketCacheContext(context);
}

/** A 304 verifies the saved body, including all cards obtained in that response. */
export async function confirmMarketRead(context: MarketCacheContext, path: string) {
  if (!isCurrentMarketCacheContext(context)) return;
  const db = await database();
  if (!isCurrentMarketCacheContext(context)) return;
  const tx = db.transaction(["entries", "metadata"], "readwrite");
  const done = transactionDone(tx);
  const request = tx.objectStore("entries").get(responseKey(context.scope!, normalizeMarketPath(path)));
  request.onsuccess = () => {
    if (!isCurrentMarketCacheContext(context)) return;
    const value = request.result as Entry | undefined;
    if (!value) return;
    const now = Date.now();
    put(tx, { ...value, checkedAt: now });
    for (const item of receivedCards(value.data)) {
      const get = tx.objectStore("entries").get(cardKey(context.scope!, item.id));
      get.onsuccess = () => {
        const current = get.result as Entry | undefined;
        if (current && isCurrentMarketCacheContext(context) &&
            cardFingerprint(current.data as MarketCard) === cardFingerprint(item))
          put(tx, { ...current, checkedAt: now });
      };
    }
  };
  await done;
}

function normalizedText(value: unknown): string {
  return String(value ?? "").normalize("NFKC").replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    .replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي").replace(/\s+/g, " ").trim().toLowerCase();
}
export function searchSavedMarketCards(cards: readonly MarketCard[], path: string) {
  const params = new URLSearchParams(path.split("?", 2)[1] ?? "");
  const kind = params.get("kind") || null, query = normalizedText(params.get("q"));
  const archived = params.get("archived") === "true";
  const page = Number(params.get("page") ?? 1), pageSize = Number(params.get("pageSize") ?? 20);
  const sort = params.get("sort") === "created" ? "createdAt" : "updatedAt";
  const filtered = cards.filter(item => item.status === "published" && item.archived === archived &&
    (kind ? item.kind === kind : item.kind !== "dosage-form") &&
    (!query || String(item.id) === query || [item.name, item.data.arabicSearchKey, item.data.englishName, item.data.keywords]
      .some(value => normalizedText(value).includes(query))))
    .sort((a, b) => kind === "drug-classification" ? a.id - b.id : String(b[sort]).localeCompare(String(a[sort])) || b.id - a.id);
  return { items: filtered.slice((page - 1) * pageSize, page * pageSize), total: filtered.length, page, pageSize };
}

/** Keep each scoped card current without discarding a detail's saved discussion. */
export function reconcileSavedMarketCards<T>(snapshot: ResponseCopy<T>, latest: readonly CardCopy[]): SavedMarketRead<T> {
  const copies = new Map(latest.filter(row => row.scope === snapshot.scope).map(row => [row.data.id, row]));
  let changed = false;
  let savedAt = snapshot.savedAt, checkedAt = snapshot.checkedAt;
  const replace = (original: unknown): unknown => {
    if (!card(original)) return original;
    const copy = copies.get(original.id);
    if (!copy || copy.data.revision < original.revision ||
        copy.data.revision === original.revision && copy.requestedAt < snapshot.requestedAt) return original;
    const updated = { ...copy.data } as MarketCard & { englishName?: string | null };
    // Related-medicine pages expose this derived alias in addition to card.data.
    if (Object.hasOwn(original, "englishName"))
      updated.englishName = typeof updated.data.englishName === "string" ? updated.data.englishName : null;
    else delete updated.englishName;
    if (JSON.stringify(updated) === JSON.stringify(original)) return original;
    changed = true;
    savedAt = Math.min(savedAt, copy.savedAt);
    checkedAt = Math.min(checkedAt, copy.checkedAt);
    return updated;
  };
  let data: unknown = snapshot.data;
  if (data && typeof data === "object") {
    const body = data as { card?: unknown; items?: unknown };
    if (card(body.card)) {
      const value = replace(body.card);
      if (changed) data = { ...body, card: value };
    } else if (Array.isArray(body.items)) {
      const items = body.items.map(replace);
      if (changed) data = { ...body, items };
    }
  }
  // A validator covers the original complete HTTP body, not a locally merged
  // body with newer prices/counters and older comments or pagination metadata.
  return { data: data as T, etag: changed ? null : snapshot.etag,
    savedAt, checkedAt, partial: changed };
}

export async function readMarketCache<T>(context: MarketCacheContext, path: string): Promise<SavedMarketRead<T> | undefined> {
  if (!isCurrentMarketCacheContext(context) || !isMarketCachePath(path)) return undefined;
  path = normalizeMarketPath(path);
  const db = await database();
  if (!isCurrentMarketCacheContext(context)) return undefined;
  const exact = await requestResult(db.transaction("entries", "readonly").objectStore("entries")
    .get(responseKey(context.scope!, path))) as Entry | undefined;
  if (!isCurrentMarketCacheContext(context)) return undefined;
  if (valid(exact)) {
    const ids = [...new Set(receivedCards(exact.data).map(item => item.id))];
    const store = db.transaction("entries", "readonly").objectStore("entries");
    const rows = (await Promise.all(ids.map(id => requestResult(store.get(cardKey(context.scope!, id)))))) as (Entry | undefined)[];
    if (!isCurrentMarketCacheContext(context)) return undefined;
    const result = reconcileSavedMarketCards({ ...exact, data: exact.data as T },
      rows.filter((row): row is Entry => valid(row) && row.kind === "card" && card(row.data)) as CardCopy[]);
    trackDependencies(path, result.data);
    return result;
  }
  if (path === `${ROOT}/meta`) return undefined;
  const rows = (await requestResult(db.transaction("entries", "readonly").objectStore("entries")
    .index("scope").getAll(context.scope!)) as Entry[]).filter(row => row.kind === "card" && valid(row));
  if (!isCurrentMarketCacheContext(context) || !rows.length) return undefined;
  const cards = rows.map(row => row.data as MarketCard);
  const pathname = path.split("?", 1)[0];
  const detail = /^\/medicine-market\/cards\/([1-9]\d*)$/.exec(pathname);
  const related = /^\/medicine-market\/cards\/([1-9]\d*)\/related-medicines$/.exec(pathname);
  let value: unknown;
  let used = rows;
  if (detail) {
    const entry = rows.find(row => (row.data as MarketCard).id === Number(detail[1]));
    if (!entry) return undefined;
    // This card came from a search/list. Empty arrays are not asserted to be
    // complete: the read status explicitly marks the whole detail as partial.
    value = { card: entry.data, comments: [], contributions: [] };
    used = [entry];
  } else if (related) {
    const source = cards.find(item => item.id === Number(related[1]));
    if (!source) return undefined;
    const field = source.kind === "agent" ? "agentId" : source.kind === "manufacturer" ? "manufacturerId" : "compositionId";
    const relation = source.kind === "medicine" ? source.data.compositionId : source.id;
    const cursor = new URLSearchParams(path.split("?", 2)[1] ?? "").get("cursor");
    const matches = ["agent", "manufacturer", "composition", "medicine"].includes(source.kind) && relation != null
      ? cards.filter(item => item.kind === "medicine" && item.status === "published" && !item.archived &&
        item.id !== source.id && (!cursor || item.id < Number(cursor)) && String(item.data[field]) === String(relation))
        .sort((a, b) => b.id - a.id) : [];
    const items = matches.slice(0, 20).map(item => ({ ...item,
      englishName: typeof item.data.englishName === "string" ? item.data.englishName : null }));
    value = { items, nextCursor: matches.length > 20 ? items[19].id : null };
  } else if (pathname === `${ROOT}/cards`) {
    value = searchSavedMarketCards(cards, path);
  } else return undefined;
  trackDependencies(path, value);
  return { data: value as T, etag: null, partial: true,
    savedAt: Math.min(...used.map(row => row.savedAt)), checkedAt: Math.min(...used.map(row => row.checkedAt)) };
}

export function publishMarketRead(context: MarketCacheContext, path: string, data: unknown) {
  if (isCurrentMarketCacheContext(context)) {
    trackDependencies(path, data);
    emit({ type: "updated", scope: context.scope, path: normalizeMarketPath(path), data });
  }
}

/** A missing card invalidates its copies, without erasing the market metadata. */
export async function invalidateMarketCardRead(context: MarketCacheContext, path: string): Promise<void> {
  const match = /^\/medicine-market\/cards\/([1-9]\d*)(?:\/related-medicines)?(?:\?|$)/.exec(path);
  if (!match) return clearMarketCacheScope(context.scope);
  if (!isCurrentMarketCacheContext(context)) return;
  const id = Number(match[1]);
  const detailPath = `${ROOT}/cards/${id}`;
  const affected = new Set<string>([normalizeMarketPath(path), detailPath]);
  for (const [query, ids] of dependencies)
    if (ids.has(id) || query.split("?", 1)[0] === `${detailPath}/related-medicines`) affected.add(query);
  // No in-flight pre-deletion response may put this card back into a list.
  generation++;
  const emitted = new Set<string>();
  const notify = () => {
    for (const query of affected) {
      if (emitted.has(query)) continue;
      emitted.add(query);
      if (scope === context.scope) { statuses.delete(query); dependencies.delete(query); }
      emit({ type: "cleared", scope: context.scope, path: query });
      if (context.scope) broadcastInvalidation({ type: "cleared", scope: context.scope, path: query });
    }
  };
  notify();
  const db = await database();
  const tx = db.transaction(["entries", "metadata"], "readwrite");
  const done = transactionDone(tx);
  const request = tx.objectStore("entries").index("scope").getAll(context.scope!);
  request.onsuccess = () => {
    for (const row of request.result as Entry[]) {
      const pathname = row.path.split("?", 1)[0];
      if (row.kind === "card" ? (row.data as MarketCard).id === id :
          pathname === detailPath || pathname === `${detailPath}/related-medicines` ||
          receivedCards(row.data).some(item => item.id === id)) {
        remove(tx, row.key);
        if (row.kind === "response") affected.add(row.path);
      }
    }
  };
  try { await done; }
  finally { notify(); }
}

/** Purging the scope also removes copies of denied cards inside cached lists. */
export async function clearMarketCacheScope(target: string | null = scope, broadcast = true): Promise<void> {
  if (target === null) return;
  if (target === scope) { generation++; statuses.clear(); dependencies.clear(); activeCleared = true; }
  emit({ type: "cleared", scope: target });
  if (broadcast) broadcastInvalidation({ type: "cleared", scope: target });
  const db = await database();
  const tx = db.transaction(["entries", "metadata"], "readwrite");
  const done = transactionDone(tx);
  const request = tx.objectStore("metadata").index("scope").openCursor(target);
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    remove(tx, (cursor.value as EntryMeta).key);
    cursor.continue();
  };
  await done;
}

function broadcastInvalidation(message: CacheInvalidation) {
  if (typeof window === "undefined") return;
  try {
    if (channel) channel.postMessage(message);
    else {
      // The storage event is delivered only to the other tabs. No response
      // body, user profile, session token or credential is transmitted.
      localStorage.setItem(SIGNAL_KEY, JSON.stringify({ ...message, nonce: `${Date.now()}:${Math.random()}` }));
      localStorage.removeItem(SIGNAL_KEY);
    }
  } catch { /* Storage policy must not prevent the local purge. */ }
}
function receiveInvalidation(value: unknown) {
  if (!value || typeof value !== "object") return;
  const message = value as Partial<CacheInvalidation>;
  if (message.type !== "cleared" || typeof message.scope !== "string" || message.scope.length > 300 ||
      (message.path !== undefined && (typeof message.path !== "string" || !isMarketCachePath(message.path)))) return;
  const target = message.scope;
  if (message.path) {
    if (scope === target) {
      generation++;
      statuses.delete(message.path);
      dependencies.delete(message.path);
    }
    emit({ type: "cleared", scope: target, path: message.path });
    return;
  }
  const active = scope;
  void clearMarketCacheScope(target, false).catch(() => {});
  // Cookies are shared between tabs. A private tab must re-confirm its
  // session before issuing another market request under an old identity.
  if (active === target || active?.startsWith("user:")) {
    if (active !== target) void clearMarketCacheScope(active, false).catch(() => {});
    scopeError = "تغيّرت جلسة السوق في نافذة أخرى؛ حدّث الصفحة لتأكيد الحساب.";
    scope = null;
    generation++;
    activeCleared = false;
    statuses.clear();
    dependencies.clear();
    emit({ type: "scope", scope });
    window.dispatchEvent(new Event("alraesy-market-session-revoked"));
  }
}
if (typeof window !== "undefined") {
  try {
    if (typeof BroadcastChannel !== "undefined") {
      channel = new BroadcastChannel("alraesy-market-cache-v1");
      channel.onmessage = event => receiveInvalidation(event.data);
    }
  } catch { channel = null; }
  window.addEventListener("storage", event => {
    if (event.key !== SIGNAL_KEY || !event.newValue) return;
    try { receiveInvalidation(JSON.parse(event.newValue)); } catch { /* Ignore unrelated/malformed storage. */ }
  });
}
