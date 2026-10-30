import { useQuery } from "@tanstack/react-query";
import type { Account, CompanyContext } from "../../../packages/contracts/src/index";
import { api, useSession } from "./api";
import { offlineUser, rememberRead, savedRead } from "./offline-storage";

export type LinkedCashboxSnapshot = {
  account: Account | null;
  // The server reply is authorized for the current user; attach this local
  // identity binding when persisting it, never guess by number or name.
  offlineIdentity?: { userId: number; companyId: number; employeeId: number };
};

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

/** Read the employee's *server-linked* sales cashbox, not an arbitrary account. */
export async function employeeSalesCashbox(
  userId: number, companyId: number, employeeId: number,
  signal?: AbortSignal,
): Promise<Account | null> {
  if (offlineUser() !== userId) return null;
  const path = `/companies/${companyId}/my-sales-cashbox`;
  // Avoid a network request entirely while offline; browsers pause standard
  // React Query queries, so callers must also use networkMode: "always".
  if (!navigator.onLine) {
    const cached = await savedRead<LinkedCashboxSnapshot>(path).catch(() => undefined);
    return ownActiveSalesCashbox(cached,userId,companyId,employeeId,true);
  }
  const response = await api<LinkedCashboxSnapshot>(path,{signal});
  if (signal?.aborted || offlineUser() !== userId) return null;
  const account = ownActiveSalesCashbox(response,userId,companyId,employeeId,false);
  // An authenticated null reply also replaces an old linked cashbox.
  // Wait for the write: immediately disconnecting after opening the invoice
  // must not lose the employee's saved default.
  await rememberRead(path,{
    account,
    offlineIdentity:{userId,companyId,employeeId},
  } satisfies LinkedCashboxSnapshot).catch(() => {});
  return account;
}

/** Only a linked, active sales cashbox belonging to this employee is eligible. */
export function useEmployeeCashbox(context: CompanyContext): Account | null {
  const { user } = useSession();
  const companyId = context.company.id;
  const employeeId = context.employee?.id;
  const query = useQuery({
    queryKey: ["employee-sales-cashbox", user?.id, companyId, employeeId],
    enabled: Boolean(user && employeeId),
    networkMode: "always",
    staleTime: 60_000,
    queryFn: ({ signal }) => employeeSalesCashbox(user!.id,companyId,employeeId!,signal),
  });
  return query.data ?? null;
}
