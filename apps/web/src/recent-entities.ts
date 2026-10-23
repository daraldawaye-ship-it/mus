/** Latest explicitly touched entity per signed-in user and company. */
export type RecentEntityKind = "item" | "account" | "employee";
export type RecentEntity = { id: number; name: string };
export const RECENT_ENTITY_EVENT = "alraesy:recent-entity";
const key = (u: number, c: number, k: RecentEntityKind) => `alraesy:recent:${u}:${c}:${k}`;
export function readRecentEntity(u: number, c: number, k: RecentEntityKind): RecentEntity | null {
  if (typeof window === "undefined" || !u || !c) return null;
  try {
    const data: unknown = JSON.parse(window.localStorage.getItem(key(u,c,k)) ?? "null");
    if (!data || typeof data !== "object") return null;
    const entity = data as Partial<RecentEntity>;
    return Number.isSafeInteger(entity.id) && (entity.id ?? 0) > 0 &&
      typeof entity.name === "string" && entity.name.length <= 300
      ? { id: entity.id!, name: entity.name } : null;
  } catch { return null; }
}
export function rememberRecentEntity(u: number, c: number, k: RecentEntityKind, entity: RecentEntity) {
  if (typeof window === "undefined" || !u || !c || !Number.isSafeInteger(entity.id) || entity.id <= 0) return;
  const value = { id: entity.id, name: entity.name.slice(0,300) };
  try { window.localStorage.setItem(key(u,c,k), JSON.stringify(value)); }
  catch { /* Restricted storage does not interrupt normal operations. */ }
  window.dispatchEvent(new CustomEvent(RECENT_ENTITY_EVENT, {detail:{userId:u,companyId:c,kind:k,value}}));
}
