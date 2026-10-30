import type { Account } from "../../../packages/contracts/src/index";

export type LinkedCashboxSnapshot = {
  account: Account | null;
  offlineIdentity?: { userId: number; companyId: number; employeeId: number };
};

/** Never select a cashbox by account name, number, or another employee's link. */
export function ownActiveSalesCashbox(
  response: LinkedCashboxSnapshot | undefined,
  userId: number,
  companyId: number,
  employeeId: number,
  requireIdentity: boolean,
): Account | null {
  if (!response || (requireIdentity && (
    response.offlineIdentity?.userId !== userId ||
    response.offlineIdentity?.companyId !== companyId ||
    response.offlineIdentity?.employeeId !== employeeId
  ))) return null;
  const account = response.account;
  return account?.companyId === companyId && account.active === true &&
    account.kind === "posting" && account.cashOrBank === true ? account : null;
}
