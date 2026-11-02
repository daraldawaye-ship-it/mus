/** Permission-dependent system shortcuts visible in every company.
 * They never grant permission: the caller must supply the currently
 * authorized page keys from the page directory for this company and user.
 */
export const SETTLEMENT_FOLLOW_UP_SHORTCUT = "company.settlement-follow-up";

export function withRequiredShortcuts(
  pageKeys: readonly string[],
  permitted: ReadonlySet<string>,
  companyId: number | null,
): string[] {
  const filtered = [...new Set(pageKeys.filter(key => permitted.has(key)))];
  if (companyId !== null &&
      permitted.has(SETTLEMENT_FOLLOW_UP_SHORTCUT) &&
      !filtered.includes(SETTLEMENT_FOLLOW_UP_SHORTCUT))
    filtered.push(SETTLEMENT_FOLLOW_UP_SHORTCUT);
  return filtered;
}
