// Historical sales invoices store the full accounting name, including private
// metadata, rather than a separate name for accounts created by the pledge flow.
const pledgeAccountPrefix = /^الرهونات\s*[-–—]\s*/u;
export const isPledgeAccountPrintName = (name: string) => pledgeAccountPrefix.test(name.trim());

export function pledgeOwnerFromAccountPrintName(name: string): string {
  const value = name.trim();
  if (!isPledgeAccountPrintName(value)) return "";
  // Fail closed when the stored value is not in the known format.
  return value.replace(pledgeAccountPrefix, "").match(/^([^_]+)_ت\s*\//u)?.[1]?.trim() ?? "";
}

export function salePrintCustomerName(name: string | null, accountName: string): string {
  return name?.trim() || pledgeOwnerFromAccountPrintName(accountName);
}
