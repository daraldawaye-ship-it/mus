import { useQuery } from "@tanstack/react-query";
import type { Account, CompanyContext } from "../../../packages/contracts/src/index";
import { api, useSession } from "./api";

/** Only a linked, active sales cashbox belonging to this employee is eligible. */
export function useEmployeeCashbox(context: CompanyContext): Account | null {
  const { user } = useSession();
  const companyId = context.company.id;
  const employeeId = context.employee?.id;
  const query = useQuery({
    queryKey: ["employee-sales-cashbox", user?.id, companyId, employeeId],
    enabled: Boolean(user && employeeId),
    queryFn: ({ signal }) =>
      api<{ account: Account | null }>(
        `/companies/${companyId}/my-sales-cashbox`,
        { signal },
      ),
  });
  return query.data?.account ?? null;
}
