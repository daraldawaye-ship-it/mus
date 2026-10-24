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
    companyId && pages
      ? pages.filter(page => page.enabled && page.actionAccess.view).map(page => page.key)
      : [],
  );
  const any = (...keys: string[]) => keys.some(key => allowed.has(key));
  const result: AvatarMenuTab[] = ["navigation"];
  if (any("company.items", "company.item-card", "company.sales", "company.purchases", "company.stock-movements"))
    result.push("item");
  // financial-options?type=accounts requires finance.view on the API.
  if (any("company.financial-documents", "company.account-ledger", "company.account-balances"))
    result.push("financialAccount");
  if (any("company.employees")) result.push("employee");
  // This placeholder is reserved for administrators with configuration rights.
  if (any("company.configuration", "company.central-access"))
    result.push("tools");
  result.push("settings");
  return result;
}
