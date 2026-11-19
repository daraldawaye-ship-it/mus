import { useEffect, useState, useSyncExternalStore } from "react";
import { connectionSnapshot, isOfflineNow, subscribeConnection } from "./connection-mode";
import { clearMarketCacheScope, getMarketCacheScope, subscribeMarketCache } from "./market-offline";

const DB = "alraesy-market-images-v1";
const MAX_IMAGES = 400;
const MAX_BYTES = 48 * 1024 * 1024;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const CHECK_INTERVAL = 60_000;
type ImageMeta = { key: string; scope: string; url: string; bytes: number; savedAt: number; checkedAt: number; etag: string | null };
type ImageEntry = ImageMeta & { blob: Blob };
let database: Promise<IDBDatabase> | undefined;
let generation = 0;
const listeners = new Set<() => void>();
const objectUrls = new Map<string, Set<string>>();
const inFlight = new Map<string, Promise<ImageEntry | null>>();
const blockedScopes = new Set<string>();
let activeDownloads = 0;
const downloadQueue: Array<() => void> = [];

async function downloadSlot<T>(work: () => Promise<T>): Promise<T> {
  await new Promise<void>(resolve => {
    const enter = () => { activeDownloads++; resolve(); };
    if (activeDownloads >= 3) downloadQueue.push(enter);
    else enter();
  });
  try { return await work(); }
  finally { activeDownloads--; downloadQueue.shift()?.(); }
}

function openDatabase(): Promise<IDBDatabase> {
  if (database) return database;
  database = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore("images", { keyPath: "key" });
      const metadata = db.createObjectStore("metadata", { keyPath: "key" });
      metadata.createIndex("scope", "scope");
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => { request.result.close(); database = undefined; };
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Local image storage is busy"));
  }).catch(error => { database = undefined; throw error; });
  return database;
}
function idbResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function completion(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () => reject(transaction.error);
  });
}
const imageKey = (scope: string, url: string) => `${scope}\n${url}`;
const isCurrent = (scope: string, epoch: number) => getMarketCacheScope() === scope && generation === epoch;
function revokeScope(scope: string) {
  for (const value of objectUrls.get(scope) ?? []) URL.revokeObjectURL(value);
  objectUrls.delete(scope);
}
async function deleteImage(key: string): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction(["images", "metadata"], "readwrite");
  tx.objectStore("images").delete(key);
  tx.objectStore("metadata").delete(key);
  await completion(tx);
}
async function deleteScope(scope: string): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction(["images", "metadata"], "readwrite");
  const cursor = tx.objectStore("metadata").index("scope").openCursor(IDBKeyRange.only(scope));
  cursor.onsuccess = () => {
    if (!cursor.result) return;
    tx.objectStore("images").delete(cursor.result.primaryKey);
    cursor.result.delete();
    cursor.result.continue();
  };
  await completion(tx);
}
subscribeMarketCache(event => {
  if (event.type === "updated" && event.scope && blockedScopes.delete(event.scope)) {
    generation++;
    for (const listener of listeners) listener();
  }
  if (event.type !== "scope" && event.type !== "cleared") return;
  generation++;
  // Blob URLs are readable without another HTTP authorization check. Revoke
  // every mounted old identity immediately, before a different account renders.
  for (const scope of [...objectUrls.keys()]) revokeScope(scope);
  if (event.type === "cleared" && event.scope) void deleteScope(event.scope).catch(() => {});
  for (const listener of listeners) listener();
});
function subscribeImages(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
const identitySnapshot = () => `${getMarketCacheScope() ?? ""}\n${generation}`;

/** Only URLs actually rendered by a market image component are considered.
 * Cross-origin sources must allow CORS; their opaque bodies are never claimed
 * to be available offline. Card derivatives normally avoid that restriction. */
export function marketImageUrl(source: string): { url: string; local: boolean } | null {
  if (typeof window === "undefined") return null;
  try {
    const url = new URL(source, window.location.origin);
    if (url.username || url.password) return null;
    const local = url.origin === window.location.origin;
    if (local && !/^\/api\/medicine-market\/(?:images\/[a-f0-9-]{36}|cards\/[1-9]\d*\/image-variants\/(?:icon|preview|main))$/.test(url.pathname)) return null;
    if (!local && url.protocol !== "https:") return null;
    url.hash = "";
    return { url: local ? url.pathname + url.search : url.href, local };
  } catch { return null; }
}
async function readImage(scope: string, url: string): Promise<ImageEntry | null> {
  const db = await openDatabase();
  const row = await idbResult(db.transaction("images").objectStore("images").get(imageKey(scope, url))) as ImageEntry | undefined;
  if (!row) return null;
  if (row.checkedAt < Date.now() - MAX_AGE || !(row.blob instanceof Blob) || row.blob.size > MAX_IMAGE_BYTES) {
    await deleteImage(row.key);
    return null;
  }
  return row;
}
async function storeImage(row: ImageEntry, epoch: number): Promise<void> {
  if (!isCurrent(row.scope, epoch)) return;
  const db = await openDatabase();
  if (!isCurrent(row.scope, epoch)) return;
  const tx = db.transaction(["images", "metadata"], "readwrite");
  const { blob, ...meta } = row;
  const metadata = tx.objectStore("metadata");
  const images = tx.objectStore("images");
  images.put(row);
  metadata.put(meta);
  const request = metadata.getAll();
  request.onsuccess = () => {
    const entries = (request.result as ImageMeta[]).sort((a, b) => b.checkedAt - a.checkedAt);
    let bytes = 0, kept = 0;
    for (const entry of entries) {
      if (entry.checkedAt < Date.now() - MAX_AGE || kept >= MAX_IMAGES || bytes + entry.bytes > MAX_BYTES) {
        images.delete(entry.key); metadata.delete(entry.key);
      } else { bytes += entry.bytes; kept++; }
    }
  };
  await completion(tx);
  if (!isCurrent(row.scope, epoch)) await deleteImage(row.key);
}
async function boundedBlob(response: Response): Promise<Blob> {
  if (Number(response.headers.get("content-length")) > MAX_IMAGE_BYTES) throw new Error("Image too large");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Image body unavailable");
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > MAX_IMAGE_BYTES) { await reader.cancel(); throw new Error("Image too large"); }
    parts.push(new Uint8Array(part.value));
  }
  return new Blob(parts, { type: response.headers.get("content-type")?.split(";")[0] ?? "image/webp" });
}
function refreshImage(scope: string, url: string, local: boolean, previous: ImageEntry | null, epoch: number): Promise<ImageEntry | null> {
  const key = `${epoch}\n${imageKey(scope, url)}`;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const promise = downloadSlot(async () => {
    if (!isCurrent(scope, epoch) || isOfflineNow()) return previous;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(url, {
        credentials: local && scope !== "guest" ? "same-origin" : "omit",
        mode: "cors", cache: "no-store", signal: controller.signal,
        headers: previous?.etag ? { "If-None-Match": previous.etag } : {},
      });
      if (!isCurrent(scope, epoch)) return null;
      if (response.status === 304 && previous) {
        const current = { ...previous, checkedAt: Date.now() };
        await storeImage(current, epoch).catch(() => {});
        return current;
      }
      if ([401, 403, 404].includes(response.status)) {
        if (local && response.status !== 404 && !blockedScopes.has(scope)) {
          blockedScopes.add(scope);
          await clearMarketCacheScope(scope).catch(() => {});
        }
        await deleteImage(imageKey(scope, url)).catch(() => {});
        return null;
      }
      if (!response.ok || !/^image\/(?:webp|png|jpeg|gif|avif)(?:;|$)/i.test(response.headers.get("content-type") ?? "")) throw new Error("Image unavailable");
      const blob = await boundedBlob(response);
      if (!isCurrent(scope, epoch)) return null;
      const now = Date.now();
      const row: ImageEntry = { key: imageKey(scope, url), scope, url, blob, bytes: blob.size, savedAt: now, checkedAt: now, etag: response.headers.get("etag") };
      await storeImage(row, epoch).catch(() => {});
      return row;
    } finally { clearTimeout(timer); }
  }).finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

/** A mounted image gets a scoped Blob URL. No native request can accidentally
 * reuse a previous employee's cookie while the market is in guest-only mode. */
export function useMarketImage(source: string | null): { src: string | undefined; failed: boolean; pending: boolean } {
  const identity = useSyncExternalStore(subscribeImages, identitySnapshot, () => "");
  const connection = useSyncExternalStore(subscribeConnection, connectionSnapshot, () => "online");
  const [shown, setShown] = useState<{ identity: string; source: string | null; src?: string; failed: boolean; pending: boolean }>();
  useEffect(() => {
    const scope = getMarketCacheScope(), epoch = generation;
    const target = source && marketImageUrl(source);
    let active = true, currentUrl: string | undefined;
    const show = (blob: Blob | null, failed = false, fallback?: string) => {
      if (!active || !scope || !isCurrent(scope, epoch)) return;
      if (currentUrl) { URL.revokeObjectURL(currentUrl); objectUrls.get(scope)?.delete(currentUrl); }
      currentUrl = blob ? URL.createObjectURL(blob) : undefined;
      if (currentUrl) {
        const urls = objectUrls.get(scope) ?? new Set<string>();
        urls.add(currentUrl); objectUrls.set(scope, urls);
      }
      setShown({ identity, source, src: currentUrl ?? fallback, failed, pending: false });
    };
    if (source && !target) setShown({ identity, source, src: source, failed: false, pending: false });
    else if (scope && target) {
      setShown({ identity, source, failed: false, pending: true });
      void (async () => {
        if (blockedScopes.has(scope)) { show(null, true); return; }
        const saved = await readImage(scope, target.url).catch(() => null);
        if (!active || !isCurrent(scope, epoch)) return;
        if (saved) show(saved.blob);
        if (isOfflineNow()) { if (!saved) show(null, true); return; }
        if (saved && saved.checkedAt > Date.now() - CHECK_INTERVAL) return;
        try {
          const fresh = await refreshImage(scope, target.url, target.local, saved, epoch);
          show(fresh?.blob ?? null, !fresh);
        } catch {
          if (!saved) show(null, target.local, target.local ? undefined : source ?? undefined);
        }
      })();
    }
    return () => {
      active = false;
      if (currentUrl) { URL.revokeObjectURL(currentUrl); if (scope) objectUrls.get(scope)?.delete(currentUrl); }
    };
  }, [source, identity, connection]);
  return shown?.identity === identity && shown.source === source
    ? { src: shown.src, failed: shown.failed, pending: shown.pending }
    : { src: undefined, failed: false, pending: true };
}
