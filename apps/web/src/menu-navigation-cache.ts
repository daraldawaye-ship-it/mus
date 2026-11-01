/**
 * Instant, user-and-company scoped presentation snapshot for the avatar menu.
 * Only links from a previously authorized page catalog are saved. This is NOT
 * an authorization cache: guards and server APIs must still enforce access.
 * IndexedDB remains the canonical offline GET fallback; this tiny localStorage
 * mirror exists only because IndexedDB cannot hydrate the first paint synchronously.
 */
import type { PageEntry, User } from "../../../packages/contracts/src/index";
import { allowedAvatarTabs, type AvatarMenuTab } from "./avatar-menu-permissions";

export type MenuLink = { key: string; name: string; href: string };
export type MenuNavigationSnapshot = {
  version: 1;
  savedAt: number;
  tabs: AvatarMenuTab[];
  defaultHref: string | null;
  links: MenuLink[];
  quickAllowed: boolean;
};

const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const ALL_TABS: AvatarMenuTab[] = [
  "navigation", "item", "financialAccount", "employee", "tools", "settings",
];
const storageKey = (userId: number, companyId: number | null) =>
  `alraesy-avatar-navigation-v1:${userId}:${companyId ?? "public"}`;
const localHref = (value: unknown): value is string =>
  typeof value === "string" && /^\/(?!\/)/.test(value) &&
  !value.includes("\\") && value.length <= 2048;

export function buildMenuNavigation(
  user: Pick<User, "owner" | "kind">,
  companyId: number | null,
  pages: readonly PageEntry[],
  chosenKeys: readonly string[],
  now = Date.now(),
): MenuNavigationSnapshot {
  const permitted = new Map(pages.filter(entry =>
    entry.enabled && entry.actionAccess.view && localHref(entry.href) &&
    !entry.record && (entry.scope === "public" || companyId !== null),
  ).map(entry => [entry.key, entry]));
  const defaultPage = permitted.get(companyId ? "company.pages" : "public.pages") ??
    permitted.get("public.pages");
  const links: MenuLink[] = [...new Set(chosenKeys)]
    .map(key => permitted.get(key))
    .filter((entry): entry is PageEntry =>
      !!entry && entry.key !== defaultPage?.key)
    .sort((a, b) => a.order - b.order || a.key.localeCompare(b.key))
    .map(entry => ({key: entry.key, name: entry.name, href: entry.href!}));
  return {
    version: 1,
    savedAt: now,
    tabs: allowedAvatarTabs(user.owner, companyId, pages),
    defaultHref: defaultPage?.href ?? null,
    links,
    quickAllowed: (user.owner || user.kind === "admin") &&
      !!permitted.get("public.general-table")?.actionAccess.create,
  };
}

export function readMenuNavigation(
  userId: number, companyId: number | null, now = Date.now(),
): MenuNavigationSnapshot | null {
  if (typeof window === "undefined" || !Number.isSafeInteger(userId) || userId <= 0) return null;
  try {
    const raw = window.localStorage.getItem(storageKey(userId, companyId));
    if (!raw) return null;
    const value: MenuNavigationSnapshot = JSON.parse(raw);
    if (value.version !== 1 || !Number.isFinite(value.savedAt) ||
        value.savedAt > now || now - value.savedAt > MAX_AGE ||
        !Array.isArray(value.tabs) || !value.tabs.includes("navigation") ||
        !value.tabs.every(tab => ALL_TABS.includes(tab)) ||
        !(value.defaultHref === null || localHref(value.defaultHref)) ||
        !Array.isArray(value.links) || value.links.length > 200 ||
        !value.links.every(link => !!link && typeof link.key === "string" &&
          typeof link.name === "string" && localHref(link.href)) ||
        typeof value.quickAllowed !== "boolean") return null;
    return value;
  } catch { return null; }
}

export function saveMenuNavigation(
  user: Pick<User, "id" | "owner" | "kind">,
  companyId: number | null,
  pages: readonly PageEntry[],
  chosenKeys: readonly string[],
): void {
  if (typeof window === "undefined" || !Number.isSafeInteger(user.id) || user.id <= 0) return;
  try {
    const snapshot = buildMenuNavigation(user, companyId, pages, chosenKeys);
    window.localStorage.setItem(storageKey(user.id, companyId), JSON.stringify(snapshot));
  } catch {
    // Storage blocked or full: the existing asynchronous API/IndexedDB path still works.
  }
}
