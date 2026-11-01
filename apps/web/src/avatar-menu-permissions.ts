/** Presentation gate for the avatar's six top tabs.
 * The server's page catalog is the authority for module visibility. This
 * never replaces API authorization for the data behind a tab.
 */
export type AvatarMenuTab =
  | "navigation" | "item" | "financialAccount" | "employee" | "tools" | "settings";

type ReadablePage = { key: string; enabled: boolean; actionAccess: { view: boolean } };

/** Personal navigation and account settings remain accessible to every user.
 * Company lookups are displayed only when their actual backing endpoints
 * can be used with at least one granted page permission.
 */
export function allowedAvatarTabs(
  owner: boolean,
  companyId: number | null,
  pages: readonly ReadablePage[] | undefined,
): AvatarMenuTab[] {
  if (owner) return ["navigation", "item", "financialAccount", "employee", "tools", "settings"];
  const allowed = new Set(
    pages
      ? pages.filter(page => page.enabled && page.actionAccess.view &&
          (companyId !== null || page.key === "public.last-present")).map(page => page.key)
      : [],
  );
  const any = (...keys: string[]) => keys.some(key => allowed.has(key));
  const result: AvatarMenuTab[] = ["navigation"];
  if (any("company.items", "company.item-card", "company.sales", "company.purchases", "company.stock-movements"))
    result.push("item");
  // Account readers and finance readers can search accounts, but neither
  // receives financial posting privileges from this presentation change.
  if (any("company.accounts", "company.financial-documents", "company.account-ledger", "company.account-balances"))
    result.push("financialAccount");
  if (any("company.employees")) result.push("employee");
  // Every company employee has a tab for pages they are allowed to view.
  // The global presence link alone can also expose it to permitted public users.
  if (companyId !== null || any("public.last-present"))
    result.push("tools");
  result.push("settings");
  return result;
}
